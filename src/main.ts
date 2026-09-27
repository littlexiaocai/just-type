import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { INLINE_PREEDIT_CLASS, inlinePreeditEffect, inlinePreeditExtension } from "./inline-preedit";
import workerSource from "./vendor/my-rime-worker.txt";
import { assetSummary, loadLocalAssets, type LocalAssets } from "./assets";
import { searchEmoji, type EmojiEntry } from "./emoji";

const PLUGIN_VERSION = "0.7.20";
const INIT_TIMEOUT_MS = 45000;
const MAX_TRACE = 60;
const REPORT_FOLDER = "就打个字诊断";
// 同一条提醒的最短间隔，以及「系统输入法刚才在工作」这条证据的有效期。
const IME_WARN_COOLDOWN_MS = 30 * 1000;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const EMOJI_PAGE = 7;
/** 系统表情面板给出的 key：单枚表情、ZWJ 序列、国旗、键帽。CJK 和任何字母（含 é ü）都不算。 */
const EMOJI_KEY = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|^[\u{1F1E6}-\u{1F1FF}]{2}$|^[0-9#*]\uFE0F?\u20E3$/u;

type Candidate = { text: string; comment?: string };
type RimeResult = {
  state: 0 | 1 | 2 | 3;
  committed?: string;
  head?: string;
  body?: string;
  tail?: string;
  page?: number;
  isLastPage?: boolean;
  highlighted?: number;
  selectLabels?: string[];
  candidates?: Candidate[];
  updatedSchema?: string;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type WorkerReply =
  | { type: "control"; args?: unknown; name?: string }
  | { type: "success"; result: unknown }
  | { type: "error"; error?: { message?: string } };

type Logger = (message: string) => void;

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒无响应）`)), ms);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * 注入 Worker 的本地资源解析器。
 *
 * 上游 Worker 通过三个入口取资源：importScripts 拉 rime.js，fetch 拉 wasm / 方案，
 * XMLHttpRequest 拉 rime.data（Emscripten 文件包走这条，不走 fetch）。
 * 主线程在建 Worker 之前已把内嵌资源解压成 Blob URL，这段 shim 只做一件事：
 * 把上游拼出来的 CDN 地址换成对应的本地 Blob URL，然后调用原生实现。
 *
 * 不用消息传递、不接管 onmessage、不 eval——映射表在建 Worker 时就写死在源码里，
 * 没有先后顺序可言，也就没有竞态。
 *
 * 关键约束：**映射里没有就立刻抛错，绝不回落网络**。留回落等于远程代码路径还在，
 * 审核问题并没有真正消失，失败也会变成难查的静默降级。
 */
function buildLocalResolver(urls: Record<string, string>): string {
  return `
self.process = undefined;
self.require = undefined;
self.addEventListener("error", function (e) { console.error("[Just Type] worker error:", e.message, e.filename, e.lineno); });
self.addEventListener("unhandledrejection", function (e) { console.error("[Just Type] worker rejection:", e.reason && (e.reason.stack || e.reason.message || e.reason)); });
(function () {
  // 上游的 Module.printErr 把 /[EWID]\\S+ \\S+ \\S+ (.*)/ 不带锚点地 match，
  // 于是任何位置命中都会去取 {E,W,I,D}[msg[0]]；消息不以这四个字母开头时
  // 取到 undefined 直接抛，真正的引擎错误反而被自己的错误处理吞掉。
  // 这里在 Module 赋值时包一层，既捞回原始信息，也堵住这个上游缺陷。
  var moduleValue;
  Object.defineProperty(self, "Module", {
    configurable: true,
    get: function () { return moduleValue; },
    set: function (m) {
      if (m && typeof m.printErr === "function") {
        var original = m.printErr;
        m.printErr = function (msg) {
          try { original.call(this, msg); }
          catch (e) { console.error("[Just Type] RIME:", msg); }
        };
      }
      moduleValue = m;
    }
  });

  var MAP = ${JSON.stringify(urls)};
  var nativeImportScripts = self.importScripts.bind(self);
  var nativeFetch = self.fetch.bind(self);
  var nativeXhrOpen = self.XMLHttpRequest.prototype.open;

  function basename(url) {
    var s = String(url);
    var q = s.indexOf("?");
    if (q >= 0) s = s.slice(0, q);
    return s.slice(s.lastIndexOf("/") + 1);
  }
  function missing(url) {
    return new Error("Just Type IME：资源未内嵌，且运行时不联网 —— " + url);
  }

  self.importScripts = function () {
    var local = [];
    for (var i = 0; i < arguments.length; i++) {
      var hit = MAP[basename(arguments[i])];
      if (!hit) throw missing(arguments[i]);
      local.push(hit);
    }
    return nativeImportScripts.apply(null, local);
  };

  self.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url);
    var hit = MAP[basename(url)];
    if (!hit) return Promise.reject(missing(url));
    return nativeFetch(hit, init);
  };

  self.XMLHttpRequest.prototype.open = function (method, url) {
    var hit = MAP[basename(url)];
    if (!hit) throw missing(url);
    var args = Array.prototype.slice.call(arguments);
    args[1] = hit;
    return nativeXhrOpen.apply(this, args);
  };
})();
`;
}

/** My RIME worker 里 pinyin_simp 的依赖表是 bi=["stroke"]。产品不用笔画反查，改成空数组。必须只命中一次。 */
const WORKER_STROKE_DEP = "bi=[\"stroke\"]";

function patchWorkerSource(source: string): string {
  const hits = source.split(WORKER_STROKE_DEP).length - 1;
  if (hits !== 1) {
    throw new Error(`Just Type：worker 依赖表补丁应命中 1 次，实际 ${hits}。上游 worker 可能已变化。`);
  }
  return source.replace(WORKER_STROKE_DEP, "bi=[]");
}

/**
 * 候选按钮的「点一下」。
 *
 * iPadOS 上只在 pointerdown 里 preventDefault 拦不住失焦：手指一碰，正文或标题就先失焦。
 * 正文（CodeMirror）自己记着光标，失焦了照样能插；内联标题是普通可编辑元素，失焦后
 * 引擎结果异步回来时已不在手势里，系统不让代码把焦点放回去，字就上不了屏（0.7.20 标题点选失败）。
 * 在 touchstart 上 preventDefault 才能让焦点留在原处；代价是系统不再合成 click，所以改在抬起时选词。
 */
function bindTap(button: HTMLElement, onTap: () => void): void {
  button.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("pointerup", (event) => {
    if (event.button === 0) onTap();
  });
}

/** 系统 IME 正在组合时，浏览器把这次 keydown 标成 keyCode 229。这是平台事实，不是按键身份。 */
function isSystemImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

class RimeWorkerClient {
  private worker: Worker;
  private workerUrl: string;
  private assetUrls: string[] = [];
  private pending?: PendingCall;
  private chain: Promise<unknown> = Promise.resolve();
  private fatal?: Error;

  constructor(source: string, assets: LocalAssets, private log: Logger) {
    // 每个内嵌资源做成一个 Blob URL，交给 Worker 里的解析器按文件名取用。
    const urls: Record<string, string> = {};
    const track = (name: string, blob: Blob): void => {
      const url = URL.createObjectURL(blob);
      this.assetUrls.push(url);
      urls[name] = url;
    };
    track("rime.js", new Blob([assets.script], { type: "text/javascript" }));
    for (const [name, buffer] of Object.entries(assets.binaries)) {
      // WebAssembly.compileStreaming 会校验 MIME，给错类型会退回较慢的
      // ArrayBuffer 路径，还白跑一次编译。
      const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      track(name, new Blob([buffer], { type }));
    }

    // 解析器里也把 Node 标记抹掉：Electron 会在 Worker 里暴露 process，
    // Emscripten 见到就改走 Node 的 fs 分支，与 iOS 上跑的路径不一致。
    const blob = new Blob([buildLocalResolver(urls) + "\n" + patchWorkerSource(source)], { type: "text/javascript" });
    this.workerUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.workerUrl);

    this.worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.type === "control") {
        this.log(`worker control: ${JSON.stringify(message.args ?? message.name ?? "")}`.slice(0, 200));
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) return;
      if (message.type === "success") pending.resolve(message.result);
      else pending.reject(new Error(message.error?.message ?? "RIME Worker 调用失败"));
    });

    this.worker.addEventListener("error", (event: ErrorEvent) => {
      // A blob worker that fails inside importScripts reports here, often with an
      // empty message, so record every field the event carries.
      const detail = [
        event.message || "(无错误文本)",
        event.filename ? `文件 ${event.filename}` : "",
        event.lineno ? `行 ${event.lineno}:${event.colno ?? 0}` : ""
      ].filter(Boolean).join(" · ");
      const error = new Error(`RIME Worker 启动失败：${detail}`);
      this.fatal = error;
      this.log(`worker error → ${detail}`);
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error);
    });

    this.worker.addEventListener("messageerror", () => {
      this.log("worker messageerror：消息无法反序列化");
    });
  }

  call<T>(name: string, ...args: unknown[]): Promise<T> {
    if (this.fatal) return Promise.reject(this.fatal);
    const run = () => new Promise<T>((resolve, reject) => {
      this.pending = {
        resolve: (value) => resolve(value as T),
        reject
      };
      this.worker.postMessage({ name, args, transferableIndices: [] });
    });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  destroy(): void {
    this.worker.terminate();
    URL.revokeObjectURL(this.workerUrl);
    for (const url of this.assetUrls) URL.revokeObjectURL(url);
    this.assetUrls = [];
  }
}

const KEY_MAP: Record<string, string> = {
  Escape: "Escape",
  Backspace: "BackSpace",
  Delete: "Delete",
  Tab: "Tab",
  Enter: "Return",
  ArrowUp: "Up",
  ArrowRight: "Right",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  " ": "space",
  ",": "comma",
  ".": "period",
  "?": "question",
  "!": "exclam",
  ";": "semicolon",
  ":": "colon",
  "'": "apostrophe",
  "/": "slash",
  "\\": "backslash"
};

const START_PUNCTUATION = new Set([",", ".", "?", "!", ";", ":", "/", "\\"]);

/* 方案里 / 和 \ 都是以「、」打头的标点菜单（后面还有 ／ ÷ 之类）。中文输入法的习惯是
   按下直接出顿号，所以菜单首项是「、」时立即确认，不让用户再按一次空格。 */
const COMMA_KEYS = new Set(["/", "\\"]);

/* 就打个字能接管的输入位置：正文编辑器，或笔记顶部的内联标题（普通的可编辑元素，不是 CodeMirror）。 */
type InputSink =
  | { kind: "editor"; view: MarkdownView }
  | { kind: "title"; el: HTMLElement; range?: Range };

type InputMode = "chinese" | "english" | "emoji";

/* 中英切换键可配。默认 Shift，沿用多数输入法的习惯；但 Shift 在某些键盘布局或
   其他插件下可能被占用，所以留出口让用户改，也允许彻底关掉只用命令。 */
type ToggleKey = "Shift" | "Control" | "Alt" | "Meta" | "none";

const TOGGLE_KEY_LABEL: Record<ToggleKey, string> = {
  Shift: "Shift",
  Control: "Control",
  Alt: "Option / Alt",
  Meta: "Command / Win",
  none: "关闭（只用命令或状态栏切换）"
};

/* 拼音音节之间的分隔符。RIME 方案的 delimiter 第一个字符是空格，
   所以引擎给出的是 "huo xu hui"；这里只改显示，不动引擎。默认撇号，
   与微信、搜狗等输入法一致，新用户最眼熟。 */
type PinyinSeparator = "apostrophe" | "space" | "dot";

const PINYIN_SEPARATOR_CHAR: Record<PinyinSeparator, string> = {
  apostrophe: "'",
  space: " ",
  dot: "·"
};

const PINYIN_SEPARATOR_LABEL: Record<PinyinSeparator, string> = {
  apostrophe: "撇号　huo'xu'hui（微信 / 搜狗风格）",
  space: "空格　huo xu hui",
  dot: "间隔点　huo·xu·hui"
};

/* 拼音画在哪。行内＝光标处带下划线（微信 / 系统输入法的样子），候选栏只剩一行；
   候选栏上方＝0.7.17 及以前的样子，留着给行内显示出问题时退回。 */
type PreeditPosition = "inline" | "panel";

const PREEDIT_POSITION_LABEL: Record<PreeditPosition, string> = {
  inline: "行内　拼音在光标处，和微信输入法一样",
  panel: "候选栏上方　旧版样式"
};

interface JustTypeSettings {
  toggleKey: ToggleKey;
  pinyinSeparator: PinyinSeparator;
  preeditPosition: PreeditPosition;
}

const DEFAULT_SETTINGS: JustTypeSettings = { toggleKey: "Shift", pinyinSeparator: "apostrophe", preeditPosition: "inline" };

const MODE_LABEL: Record<InputMode, string> = { chinese: "Just Type 中", english: "Just Type 英", emoji: "Just Type 😀" };
const MODE_NOTICE: Record<InputMode, string> = {
  chinese: "中文",
  english: "英文",
  emoji: "表情 — 打关键词搜索，如 xiao / smile / huo。按 Shift 回中文"
};

type SkipReason =
  | "未启用"
  | "引擎未就绪"
  | "焦点不在编辑器"
  | "带修饰键"
  | "系统输入法组合中"
  | "非拼音按键";

class JustTypeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: JustTypePlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "中英文切换键",
      desc: "单独按一下这个键（中间不夹别的键）在中文和英文之间切换。命令面板里的「切换中英文 (toggle)」始终可用，也可以在 Obsidian 的快捷键设置里自行绑定。",
      aliases: ["toggle", "Shift", "chinese", "english"],
      control: {
        type: "dropdown",
        key: "toggleKey",
        options: { ...TOGGLE_KEY_LABEL }
      }
    }, {
      name: "拼音显示位置",
      desc: "正在打的拼音显示在哪里。只影响显示，不影响输入。",
      aliases: ["preedit", "inline", "拼音", "行内", "位置"],
      control: {
        type: "dropdown",
        key: "preeditPosition",
        options: { ...PREEDIT_POSITION_LABEL }
      }
    }, {
      name: "拼音分隔符",
      desc: "拼音音节之间用什么隔开。只影响显示，不影响输入。",
      aliases: ["separator", "delimiter", "分隔", "撇号", "空格"],
      control: {
        type: "dropdown",
        key: "pinyinSeparator",
        options: { ...PINYIN_SEPARATOR_LABEL }
      }
    }];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("中英文切换键")
      .setDesc("单独按一下这个键（中间不夹别的键）在中文和英文之间切换。命令面板里的「切换中英文 (toggle)」始终可用，也可以在 Obsidian 的快捷键设置里自行绑定。")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(TOGGLE_KEY_LABEL)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.toggleKey);
        dropdown.onChange(async (value) => {
          this.plugin.settings.toggleKey = value as ToggleKey;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName("拼音显示位置")
      .setDesc("正在打的拼音显示在哪里。只影响显示，不影响输入。")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PREEDIT_POSITION_LABEL)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.preeditPosition);
        dropdown.onChange(async (value) => {
          this.plugin.settings.preeditPosition = value as PreeditPosition;
          await this.plugin.saveData(this.plugin.settings);
        });
      });

    new Setting(containerEl)
      .setName("拼音分隔符")
      .setDesc("拼音音节之间用什么隔开。只影响显示，不影响输入。")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PINYIN_SEPARATOR_LABEL)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.settings.pinyinSeparator);
        dropdown.onChange(async (value) => {
          this.plugin.settings.pinyinSeparator = value as PinyinSeparator;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }
}

class DiagnosticsModal extends Modal {
  constructor(app: App, private report: string, private sensitive = false) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("just-type-diag");
    contentEl.createEl("h3", { text: "Just Type · 诊断报告" });
    contentEl.createEl("p", {
      cls: "just-type-diag-hint",
      text: this.sensitive
        ? "⚠️ 本次记录包含你实际敲下的按键内容。外发前请先通读一遍。"
        : "可以把这份报告发给协助排查的人。按键内容已脱敏，只保留类别（字母/数字/符号）。"
    });
    const area = contentEl.createEl("textarea", { cls: "just-type-diag-text" });
    area.value = this.report;
    area.readOnly = true;
    area.rows = 18;

    const actions = contentEl.createDiv({ cls: "just-type-diag-actions" });
    const copyButton = actions.createEl("button", { text: "复制报告", cls: "mod-cta" });
    copyButton.addEventListener("click", () => {
      const reset = (): void => {
        window.setTimeout(() => copyButton.setText("复制报告"), 1600);
      };
      navigator.clipboard.writeText(this.report).then(
        () => { copyButton.setText("已复制"); reset(); },
        () => {
          area.select();
          const ok = document.execCommand("copy");
          copyButton.setText(ok ? "已复制" : "复制失败，请手动选中");
          reset();
        }
      );
    });
    actions.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class JustTypePlugin extends Plugin {
  private client?: RimeWorkerClient;
  private mode: InputMode = "chinese";
  private emojiQuery = "";
  private emojiHits: EmojiEntry[] = [];
  private ready = false;
  private composing = false;
  private panel?: HTMLDivElement;
  private preedit?: HTMLDivElement;
  private candidates?: HTMLDivElement;
  /* 当前画着行内拼音的那个编辑器。清除时必须清它，而不是清「现在的活动编辑器」。 */
  private inlineTarget?: EditorView;
  /* iPad 上手指一按候选栏，编辑器就先失焦。记下按下的时刻，这之后短时间内的失焦不当成「离开」。 */
  private panelPressAt = -Infinity;
  private activeSink?: InputSink;
  private status?: HTMLElement;
  private ribbon?: HTMLElement;
  private inputSequence = 0;
  private discardThrough = 0;
  /* 活动编辑器换了就加一。异步结果带着按键时的 generation，对不上就丢弃，
     避免切笔记/窗格后把字写进旧 MarkdownView。 */
  private editorGeneration = 0;

  private startedAt = Date.now();
  private diagnostics: string[] = [];
  private initError?: string;
  private keydownSeen = 0;
  private keydownCaptured = 0;
  private skipCounts: Partial<Record<SkipReason, number>> = {};
  private lastKeyNote = "(尚未按键)";
  private eventTrace: string[] = [];
  private eventCounts: Record<string, number> = {};
  private pendingTrace = -1;
  private toggleArmed = false;
  settings: JustTypeSettings = { ...DEFAULT_SETTINGS };
  private imeConflictStreak = 0;
  private lastImeWarnAt = 0;
  private imeTookOver = false;
  private traceEnabled = false;
  private traceRawKeys = false;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<JustTypeSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.addSettingTab(new JustTypeSettingTab(this.app, this));
    this.log(`插件 ${PLUGIN_VERSION} 载入`);
    this.log(this.environmentLine());

    this.createPanel();
    this.registerEditorExtension(inlinePreeditExtension);
    this.registerCommands();
    this.createControls();
    this.registerDomEvent(document, "keydown", (event) => this.onKeydown(event), true);
    this.registerDomEvent(document, "keyup", (event) => this.onKeyup(event), true);
    this.registerDomEvent(document, "focusout", (event) => this.onEditorFocusOut(event), true);
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.invalidateEditorContext("active-leaf-change")));
    this.registerEvent(this.app.workspace.on("file-open", () => this.invalidateEditorContext("file-open")));
    this.registerInputProbes();
    this.updateStatus("正在加载…");

    try {
      const t0 = Date.now();
      const t0assets = Date.now();
      const assets = await loadLocalAssets();
      this.log(`内嵌资源解压完成（${Date.now() - t0assets}ms）`);

      this.client = new RimeWorkerClient(workerSource, assets, (message) => this.log(message));
      this.log(`Worker 已创建（${Date.now() - t0}ms）`);

      const t1 = Date.now();
      await timeout(this.client.call<void>("setIME", "pinyin_simp"), INIT_TIMEOUT_MS, "加载 RIME 引擎与词库");
      this.log(`setIME(pinyin_simp) 完成（${Date.now() - t1}ms）`);

      await timeout(this.client.call<void>("setPageSize", 7), 10000, "设置候选页大小");
      this.log("setPageSize(7) 完成");

      this.ready = true;
      this.updateStatus();
      this.log(`就绪，总耗时 ${Date.now() - this.startedAt}ms`);
      new Notice(this.readyHint());
    } catch (error) {
      const message = this.errorMessage(error);
      this.initError = message;
      this.log(`初始化失败：${message}`);
      console.error("RIME initialization failed", error);
      this.updateStatus("加载失败");
      new Notice(`Just Type 加载失败：${message}\n运行命令「诊断报告 (report)」查看详情`, 15000);
    }
  }

  onunload(): void {
    this.setInlinePreedit(undefined, "");
    this.client?.destroy();
    this.panel?.remove();
  }

  /* ---------------- diagnostics ---------------- */

  private log(message: string): void {
    const stamp = String(Date.now() - this.startedAt).padStart(6, " ");
    this.diagnostics.push(`[+${stamp}ms] ${message}`);
  }

  private environmentLine(): string {
    const kind = Platform.isIosApp ? "iOS/iPadOS App"
      : Platform.isAndroidApp ? "Android App"
      : Platform.isMacOS ? "macOS 桌面"
      : Platform.isWin ? "Windows 桌面"
      : "其它";
    return `环境：${kind}｜mobile=${Platform.isMobile}｜Obsidian ${(this.app as unknown as { appVersion?: string }).appVersion ?? "?"}`;
  }

  /** Separates "the CDN is unreachable" from "the page context is not allowed to fetch it". */

  /* 被动事件探针：只记录，不改变任何行为。用于在 iPad 上看清系统键盘到底发什么事件。 */

  private registerInputProbes(): void {
    const types = ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"];
    for (const type of types) {
      const handler = (event: Event): void => {
        if (!this.isInputTarget(event.target)) return;
        this.noteSystemIme(event);
        this.trace(type, `${this.describeEvent(event)} @${this.targetTag(event.target)}`);
      };
      document.addEventListener(type, handler, true);
      this.register(() => document.removeEventListener(type, handler, true));
    }
  }

  /* 英文模式下就打个字完全放行按键，打出中文还是英文取决于系统输入源。插件查不到
     系统输入源（网页环境没有这个 API），只能从事件反推。

     注意：不能拿「有 composition 事件」当判据。macOS 上那确实意味着输入法在转换，
     但 iOS 的自动改正和预测输入在打普通英文时也走 composition，照那么判会在英文
     键盘下疯狂误报（0.7.2 就是这么错的）。

     真正可靠的判据是 compositionend 提交了汉字：自动改正提交的是 ASCII，中文输入
     法提交的是汉字。代价是提醒要等到第一个词上屏之后才出现，可以接受。

     只在「当下真的发生了」时提醒。0.7.2 还做过一条「切换到英文模式时，若 10 分钟内
     见过中文输入法就提前提醒」，那是凭记忆猜——输入源随时会变，记忆必然过期，
     必然误报，0.7.8 已删除。 */
  private noteSystemIme(event: Event): void {
    if (event.type !== "compositionend") return;
    if (!CJK.test((event as CompositionEvent).data ?? "")) return;
    this.warnSystemImeTookOver();
  }

  /* 系统键盘切到中文时，就打个字在任何模式下都不工作——按键在到达插件之前就被系统
     输入法吃掉了。所以话要说「就打个字停了」，不是「你在某某模式」：用户需要知道的是
     工具还灵不灵，不是自己处在哪一档。

     两条触发路径共用这一条文案：中文模式下按键被 229 连续跳过，以及任何模式下
     系统输入法上屏了汉字。同一种处境，不该有两种说法。 */
  private warnSystemImeTookOver(): void {
    this.imeTookOver = true;
    if (Date.now() - this.lastImeWarnAt < IME_WARN_COOLDOWN_MS) return;
    this.lastImeWarnAt = Date.now();
    new Notice("系统键盘切到中文了，Just Type 已停止工作——按键现在归系统输入法。要继续用 Just Type，请把系统键盘切回英文 ABC。", 8000);
  }

  private describeEvent(event: Event): string {
    const input = event as InputEvent;
    if (typeof input.inputType === "string") {
      return `inputType="${input.inputType}" data=${this.redactData(input.data)} comp=${input.isComposing}`;
    }
    const composition = event as CompositionEvent;
    if (typeof composition.data === "string") return `data=${this.redactData(composition.data)}`;
    return "";
  }

  /* 默认只吐类别，不吐用户敲了什么。诊断 iPad 软键盘要的是「key 是不是 Unidentified」，
     而不是「用户打了什么字」——类别足够回答前者。 */
  private redactKey(key: string): string {
    if (this.traceRawKeys) return JSON.stringify(key);
    if (key.length !== 1) return JSON.stringify(key); // Shift / Unidentified / ArrowDown 等具名键不是内容
    if (/[a-z]/i.test(key)) return "<字母>";
    if (/[0-9]/.test(key)) return "<数字>";
    if (/\s/.test(key)) return "<空白>";
    return "<符号>";
  }

  /* code 和 keyCode 同样会泄露按了哪个键（keyCode 81 就是 Q）。但 code="" 和 keyCode=229
     是判定 iOS 软键盘行为的关键信号，不能一刀切抹掉——只把「能还原出字符」的那部分换成类别。 */
  private redactCode(code: string): string {
    if (this.traceRawKeys) return JSON.stringify(code);
    if (/^Key[A-Z]$/.test(code)) return "<字母键>";
    if (/^Digit[0-9]$/.test(code)) return "<数字键>";
    if (/^Numpad[0-9]$/.test(code)) return "<小键盘数字>";
    return JSON.stringify(code); // ""、"Space"、"Escape"、"ArrowDown" 等
  }

  private redactKeyCode(keyCode: number): string {
    if (this.traceRawKeys) return String(keyCode);
    // 229 = 系统输入法组合中，0 = 未提供；这两个必须原样保留
    if (keyCode === 229 || keyCode === 0) return String(keyCode);
    const isContent = (keyCode >= 48 && keyCode <= 57) || (keyCode >= 65 && keyCode <= 90);
    return isContent ? "<内容>" : String(keyCode);
  }

  private redactData(data: string | null): string {
    if (data === null) return "null";
    if (this.traceRawKeys) return JSON.stringify(data);
    return `<${[...data].length} 字符>`;
  }

  /* shouldCapture 里模式判断排在焦点判断前面，英文模式下所有按键都记成「未启用」，
     焦点信息就丢了。轨迹里单独带一份，排查时才看得出按键到底落在哪。 */
  private readyHint(): string {
    const key = this.settings.toggleKey;
    return key === "none"
      ? "Just Type 已就绪——用命令「切换中英文 (toggle)」或点状态栏切换"
      : `Just Type 已就绪——按 ${TOGGLE_KEY_LABEL[key]} 在中英文之间切换`;
  }

  private targetTag(target: EventTarget | null): string {
    if (!(target instanceof Element)) return "none";
    if (this.isEditorTarget(target)) return "editor";
    if (this.titleElement(target)) return "title";
    const cls = target.className?.toString().trim().split(/\s+/)[0] ?? "";
    return cls || target.tagName.toLowerCase();
  }

  private trace(kind: string, detail: string): number {
    if (!this.traceEnabled) return -1;
    this.eventCounts[kind] = (this.eventCounts[kind] ?? 0) + 1;
    const stamp = String(Date.now() - this.startedAt).padStart(6, " ");
    this.eventTrace.push(`[+${stamp}ms] ${kind} ${detail}`);
    if (this.eventTrace.length > MAX_TRACE) this.eventTrace.shift();
    return this.eventTrace.length - 1;
  }

  private markTrace(index: number, marker: string): void {
    if (index < 0 || index >= this.eventTrace.length) return;
    this.eventTrace[index] += ` → ${marker}`;
  }

  /* 报告本来只在内存里，iPad 上排查只能靠手抄。写成 Vault 笔记后可以随
     Obsidian Sync 到别的设备，两头都能直接读。脱敏规则与屏幕上的报告一致。 */
  private async saveReport(): Promise<void> {
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const path = `${REPORT_FOLDER}/${stamp}.md`;
    try {
      if (!this.app.vault.getAbstractFileByPath(REPORT_FOLDER)) {
        await this.app.vault.createFolder(REPORT_FOLDER);
      }
      const file = await this.app.vault.create(path, "```\n" + this.buildReport() + "\n```\n");
      new Notice(`诊断报告已存到 ${path}`, 8000);
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      new Notice(`保存诊断报告失败：${this.errorMessage(error)}`, 8000);
    }
  }

  private buildReport(): string {
    const skips = Object.entries(this.skipCounts)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([reason, count]) => `    ${reason}: ${count}`)
      .join("\n") || "    (无)";

    const counts = Object.entries(this.eventCounts)
      .map(([kind, n]) => `  ${kind}: ${n}`)
      .join("\n") || "  (无)";

    const traceState = !this.traceEnabled
      ? "关（运行命令「诊断：开始/停止记录按键事件」开启）"
      : this.traceRawKeys
        ? "开 — ⚠️ 含原始按键内容"
        : "开 — 已脱敏";

    const trace = this.eventTrace.length
      ? this.eventTrace.map((line) => `  ${line}`).join("\n")
      : "  (无)";

    return [
      "Just Type · 诊断报告",
      `生成时间：${new Date().toLocaleString()}`,
      `插件版本：${PLUGIN_VERSION}`,
      this.environmentLine(),
      "",
      "--- 内嵌资源（运行时不联网）---",
      assetSummary(),
      "",
      "--- 当前状态 ---",
      `  引擎就绪 ready = ${this.ready}`,
      `  输入模式 mode = ${this.mode}`,
      `  组合中 composing = ${this.composing}`,
      `  编辑器 generation = ${this.editorGeneration}`,
      `  初始化错误 = ${this.initError ?? "(无)"}`,
      "",
      "--- 按键捕获 ---",
      `  收到 keydown：${this.keydownSeen}`,
      `  被 Just Type 截获：${this.keydownCaptured}`,
      `  最近一次按键：${this.lastKeyNote}`,
      "  未截获原因统计：",
      skips,
      "",
      "--- 事件计数 ---",
      counts,
      "",
      `--- 最近事件轨迹（最多 ${MAX_TRACE} 条）---`,
      `  记录状态：${traceState}`,
      trace,
      "",
      "--- 初始化过程 ---",
      ...this.diagnostics
    ].join("\n");
  }

  /* ---------------- UI ---------------- */

  private registerCommands(): void {
    this.addCommand({
      id: "toggle-chinese-english",
      name: "切换中英文 (toggle)",
      callback: () => this.toggle()
    });
    this.addCommand({
      id: "toggle-emoji",
      name: "切换表情模式 (emoji)",
      callback: () => this.toggleEmoji()
    });
    this.addCommand({
      id: "diagnostics",
      name: "诊断报告 (report)",
      callback: () => new DiagnosticsModal(this.app, this.buildReport(), this.traceRawKeys).open()
    });
    this.addCommand({
      id: "toggle-trace",
      name: "诊断：开始/停止记录按键事件 (trace)",
      callback: () => {
        this.traceEnabled = !this.traceEnabled;
        if (this.traceEnabled) {
          this.eventTrace = [];
          this.eventCounts = {};
        } else {
          this.traceRawKeys = false;
        }
        new Notice(this.traceEnabled
          ? "按键事件记录：开（内容已脱敏）。复现问题后运行「诊断报告 (report)」。"
          : "按键事件记录：关。");
      }
    });
    this.addCommand({
      id: "toggle-trace-raw",
      name: "诊断：记录原始按键内容 敏感 (trace raw)",
      callback: () => {
        this.traceRawKeys = !this.traceRawKeys;
        if (this.traceRawKeys && !this.traceEnabled) {
          this.traceEnabled = true;
          this.eventTrace = [];
          this.eventCounts = {};
        }
        new Notice(this.traceRawKeys
          ? "⚠️ 记录已包含你实际敲下的按键内容，报告外发前请通读。再运行一次此命令可关闭。"
          : "已恢复脱敏记录。", 8000);
      }
    });
    this.addCommand({
      id: "save-report",
      name: "诊断：把报告存进 Vault (save report)",
      callback: () => void this.saveReport()
    });
  }

  private createControls(): void {
    // Obsidian mobile has no status bar, so the ribbon carries the state there.
    this.ribbon = this.addRibbonIcon("languages", "Just Type：切换中英文", () => this.toggle());
    if (!Platform.isMobile) {
      this.status = this.addStatusBarItem();
      this.status.addClass("just-type-status");
      this.status.addEventListener("click", () => this.toggle());
    }
  }

  /* Shift、状态栏、ribbon 都只管中/英——和其他输入法的习惯一致。
     在表情模式下按 Shift 直接回中文，规则简单，不用记之前在哪。
     表情模式改由独立命令进入：iPad 上用系统地球键更顺手，这条留作后路。 */
  private toggle(): void {
    this.setMode(this.mode === "chinese" ? "english" : "chinese");
  }

  private toggleEmoji(): void {
    this.setMode(this.mode === "emoji" ? "chinese" : "emoji");
  }

  private setMode(next: InputMode): void {
    this.cancelComposition();
    this.clearEmoji();
    this.mode = next;
    this.updateStatus();
    if (next === "emoji") {
      const view = this.activeEditor();
      if (view) this.renderEmojiPanel(view);
    }
    new Notice(`Just Type：${MODE_NOTICE[next]}`);
  }

  private updateStatus(override?: string): void {
    const active = this.mode !== "english" && this.ready;
    const label = override ?? MODE_LABEL[this.mode];
    if (this.status) {
      this.status.setText(label);
      this.status.toggleClass("is-enabled", active);
    }
    if (this.ribbon) {
      this.ribbon.toggleClass("is-enabled", active);
      this.ribbon.setAttribute("aria-label", `Just Type：${MODE_NOTICE[this.mode]}`);
      setIcon(this.ribbon, this.mode === "emoji" ? "smile" : this.mode === "chinese" && this.ready ? "languages" : "type");
    }
  }

  private createPanel(): void {
    this.panel = document.body.createDiv({ cls: "just-type-panel" });
    this.panel.setAttribute("aria-live", "polite");
    this.preedit = this.panel.createDiv({ cls: "just-type-preedit" });
    this.candidates = this.panel.createDiv({ cls: "just-type-candidates" });
    // 捕获阶段记录，早于 iPadOS 让编辑器失焦。标题失焦后光标位置会丢，这里先存一份。
    this.panel.addEventListener("pointerdown", () => {
      this.panelPressAt = performance.now();
      const sink = this.activeSink;
      if (sink?.kind === "title") {
        const selection = window.getSelection();
        if (selection?.rangeCount && sink.el.contains(selection.anchorNode)) sink.range = selection.getRangeAt(0).cloneRange();
      }
    }, true);
  }

  /* ---------------- input ---------------- */

  private isEditorTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(".markdown-source-view .cm-content"));
  }

  private titleElement(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest(".inline-title");
    return el instanceof HTMLElement && el.isContentEditable ? el : null;
  }

  /* 正文或内联标题都算。表情模式和系统表情面板仍只管正文。 */
  private isInputTarget(target: EventTarget | null): boolean {
    return this.isEditorTarget(target) || Boolean(this.titleElement(target));
  }

  private sinkFor(target: EventTarget | null): InputSink | null {
    if (this.isEditorTarget(target)) {
      const view = this.activeEditor();
      return view ? { kind: "editor", view } : null;
    }
    const el = this.titleElement(target);
    return el ? { kind: "title", el } : null;
  }

  private insertText(sink: InputSink, text: string): void {
    if (sink.kind === "editor") {
      sink.view.editor.replaceSelection(text);
      return;
    }
    const el = sink.el;
    this.restoreTitleFocus(sink);
    const selection = window.getSelection();
    if (!selection?.rangeCount || !el.contains(selection.anchorNode)) {
      const end = document.createRange();
      end.selectNodeContents(el);
      end.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(end);
    }
    // 走浏览器自己的插入，Obsidian 能收到正常的 input 事件并据此改文件名。
    // execCommand 已不推荐，但在可编辑元素里仍是唯一能进撤销栈、触发原生 input 的办法；失败再手动插。
    if (!document.execCommand("insertText", false, text)) {
      const range = window.getSelection()?.getRangeAt(0);
      if (!range) return;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    sink.range = undefined;
  }

  /* 标题失焦后光标位置会丢：把焦点和按下候选栏前存的光标位置一起放回去。
     iPadOS 只允许在手势里把焦点给可编辑元素，所以点选时要在抬手那一刻同步调用，不能等引擎结果。 */
  private restoreTitleFocus(sink: InputSink): void {
    if (sink.kind !== "title" || document.activeElement === sink.el) return;
    sink.el.focus();
    const selection = window.getSelection();
    if (sink.range && selection) {
      selection.removeAllRanges();
      selection.addRange(sink.range);
    }
  }

  /* 点完候选把焦点还回去，外接键盘才能接着打。 */
  private refocus(sink: InputSink): void {
    if (sink.kind === "editor") sink.view.editor.focus();
    else if (document.activeElement !== sink.el) sink.el.focus();
  }

  private activeEditor(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  private skip(reason: SkipReason): false {
    this.skipCounts[reason] = (this.skipCounts[reason] ?? 0) + 1;
    // 插件开着、键却被系统输入法吃掉时，沉默看起来就像插件坏了。连续几次就说一声。
    if (reason === "系统输入法组合中") {
      this.imeConflictStreak += 1;
      if (this.imeConflictStreak === 3 && this.mode === "chinese") {
        this.warnSystemImeTookOver();
      }
    }
    this.markTrace(this.pendingTrace, reason);
    this.pendingTrace = -1;
    return false;
  }

  private shouldCapture(event: KeyboardEvent): boolean {
    if (this.mode !== "chinese") return this.skip("未启用");
    if (!this.ready || !this.client) return this.skip("引擎未就绪");
    if (!this.isInputTarget(event.target)) return this.skip("焦点不在编辑器");
    // The system IME is still composing (it was left on a Chinese layout). Letting
    // RIME also consume the key commits the same word twice.
    if (isSystemImeComposing(event)) return this.skip("系统输入法组合中");
    if (event.metaKey || event.ctrlKey || event.altKey) return this.skip("带修饰键");
    if (event.shiftKey && event.key.length !== 1) return this.skip("带修饰键");
    if (this.composing) {
      return /^[a-z0-9]$/i.test(event.key) || event.key in KEY_MAP ? true : this.skip("非拼音按键");
    }
    // ？！：要按 Shift 才打得出来，不能一律当修饰键放行；Shift＋字母仍放给系统（大写字母）。
    if (event.shiftKey && !START_PUNCTUATION.has(event.key)) return this.skip("带修饰键");
    return /^[a-z]$/i.test(event.key) || START_PUNCTUATION.has(event.key) ? true : this.skip("非拼音按键");
  }

  /* 单独按下并松开切换键（中间没有别的键）＝ 中/英切换。默认 Shift，可在设置里改。 */
  private isToggleKeyAlone(event: KeyboardEvent): boolean {
    const key = this.settings.toggleKey;
    if (key === "none" || event.key !== key) return false;
    if (key !== "Control" && event.ctrlKey) return false;
    if (key !== "Meta" && event.metaKey) return false;
    if (key !== "Alt" && event.altKey) return false;
    if (key !== "Shift" && event.shiftKey) return false;
    return true;
  }

  private onKeyup(event: KeyboardEvent): void {
    if (event.key !== this.settings.toggleKey || !this.toggleArmed) return;
    this.toggleArmed = false;
    if (!this.ready || !this.isInputTarget(event.target)) return;
    this.toggle();
  }

  /* iPadOS 把「点系统表情面板」发成 keydown：key 是那个表情本身，code="Unidentified"，
     keyCode=0。实测它有时不会跟上 beforeinput/input，表情就插不进文档（诊断报告
     2026-09-20-214712 里 🥳 失败、🤩 成功，同样的动作两种结果）。

     既然按键送到了，就由就打个字自己写进文档，不再看系统脸色。preventDefault 掐掉系统
     那条不稳的插入路径，所以不会重复上屏。
     结构判据：keyCode=0、code 未识别、无修饰键。内容判据用 Unicode 表情属性，
     排除 CJK 和任何字母（含 é ü），避免把非表情的非 ASCII 键当表情插入。 */
  private isPickerChar(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.keyCode !== 0) return false;
    if (event.code !== "" && event.code !== "Unidentified") return false;
    const key = event.key;
    if (!key) return false;
    if (/^[A-Z][A-Za-z]+$/.test(key)) return false; // Enter / Shift / Unidentified 这类具名键
    if (CJK.test(key) || /\p{L}/u.test(key)) return false;
    return EMOJI_KEY.test(key);
  }

  private insertPickerChar(event: KeyboardEvent): void {
    if (!this.isEditorTarget(event.target)) return void this.skip("焦点不在编辑器");
    const view = this.activeEditor();
    if (!view) return void this.skip("焦点不在编辑器");

    if (this.composing) this.cancelComposition();
    if (this.mode === "emoji") this.clearEmoji();

    event.preventDefault();
    event.stopImmediatePropagation();
    view.editor.replaceSelection(event.key);
    this.keydownCaptured += 1;
    this.markTrace(this.pendingTrace, "表情直接上屏");
    this.pendingTrace = -1;
  }

  /* 「就打个字停了」有提示，「就打个字回来了」也得有，否则用户不知道什么时候能接着用。
     插件查不到系统输入源，但能从按键反推：系统中文输入法在工作时，按键到达这里
     是 keyCode 229 / isComposing；一旦有正常字符键落进编辑器，就说明系统交还了
     控制权。只在确实被接管过之后报一次，平时不啰嗦。 */
  private noteImeReleased(event: KeyboardEvent): void {
    if (!this.imeTookOver) return;
    if (isSystemImeComposing(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length !== 1) return;
    if (!this.isInputTarget(event.target)) return;
    this.imeTookOver = false;
    new Notice(this.readyHint(), 6000);
  }

  private onKeydown(event: KeyboardEvent): void {
    this.toggleArmed = this.isToggleKeyAlone(event);
    this.keydownSeen += 1;
    const target = event.target instanceof Element ? event.target.className.toString().slice(0, 60) : String(event.target);
    this.lastKeyNote = `key=${this.redactKey(event.key)} code=${this.redactCode(event.code)} keyCode=${this.redactKeyCode(event.keyCode)} isComposing=${event.isComposing} target=[${target}]`;
    this.pendingTrace = this.trace("keydown", `key=${this.redactKey(event.key)} code=${this.redactCode(event.code)} kc=${this.redactKeyCode(event.keyCode)} comp=${event.isComposing} @${this.targetTag(event.target)}`);

    this.noteImeReleased(event);

    if (this.isPickerChar(event)) {
      this.insertPickerChar(event);
      return;
    }

    if (this.mode === "emoji") {
      this.handleEmojiMode(event);
      return;
    }

    if (!this.shouldCapture(event)) return;
    const sink = this.sinkFor(event.target);
    if (!sink) return this.skip("焦点不在编辑器") as unknown as void;
    this.activeSink = sink;

    const rimeKey = this.toRimeKey(event);
    if (!rimeKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.keydownCaptured += 1;
    this.imeConflictStreak = 0;
    this.markTrace(this.pendingTrace, "截获");
    this.pendingTrace = -1;

    const sequence = ++this.inputSequence;
    const generation = this.editorGeneration;
    void this.client!.call<RimeResult>("process", rimeKey)
      .then((result) => COMMA_KEYS.has(event.key) ? this.confirmComma(result) : result)
      .then((result) => this.applyResult(result, event.key, sink, sequence, generation))
      .catch((error) => {
        console.error("RIME input failed", error);
        this.log(`process("${rimeKey}") 失败：${this.errorMessage(error)}`);
        this.cancelComposition();
        new Notice(`Just Type 输入失败：${this.errorMessage(error)}\n可运行命令「诊断报告 (report)」查看详情`, 8000);
      });
  }

  private handleEmojiMode(event: KeyboardEvent): void {
    if (!this.isEditorTarget(event.target)) return void this.skip("焦点不在编辑器");
    if (event.metaKey || event.ctrlKey || event.altKey) return void this.skip("带修饰键");
    if (isSystemImeComposing(event)) return void this.skip("系统输入法组合中");

    const view = this.activeEditor();
    if (!view) return void this.skip("焦点不在编辑器");
    if (!this.handleEmojiKey(event, view)) return void this.skip("非拼音按键");

    event.preventDefault();
    event.stopImmediatePropagation();
    this.keydownCaptured += 1;
    this.imeConflictStreak = 0;
    this.markTrace(this.pendingTrace, "截获");
    this.pendingTrace = -1;
  }

  private toRimeKey(event: KeyboardEvent): string | undefined {
    if (/^[a-z0-9]$/i.test(event.key)) return event.key.toLowerCase();
    const mapped = KEY_MAP[event.key];
    return mapped ? `{${mapped}}` : undefined;
  }

  /* / 或 \ 打开的是标点菜单：首项是「、」就立刻确认。前面若有拼音被顺带上屏，两段拼起来一起交出。 */
  private async confirmComma(result: RimeResult): Promise<RimeResult> {
    if (result.state !== 1 || result.candidates?.[0]?.text !== "、") return result;
    const next = await this.client!.call<RimeResult>("process", "{space}");
    return { ...next, committed: `${result.committed ?? ""}${next.committed ?? ""}` };
  }

  private applyResult(result: RimeResult, originalKey: string, sink: InputSink, sequence: number, generation: number): void {
    if (sequence <= this.discardThrough || generation !== this.editorGeneration) return;
    if (result.state === 0) {
      this.composing = false;
      this.hidePanel();
      if (result.committed) this.insertText(sink, result.committed);
      return;
    }
    if (result.state === 1) {
      this.composing = true;
      if (result.committed) this.insertText(sink, result.committed);
      this.renderPanel(result, sink);
      return;
    }
    this.composing = false;
    this.hidePanel();
    if (result.state === 3 && originalKey.length === 1) this.insertText(sink, originalKey);
  }

  /* ---------------- 表情模式 ---------------- */

  /* 返回 true 表示这个键归表情模式管，调用方负责 preventDefault。
     查询为空时只吃字母，其余键一律放行，免得表情模式下连空格退格都动不了。 */
  private handleEmojiKey(event: KeyboardEvent, view: MarkdownView): boolean {
    const key = event.key;

    if (/^[a-z]$/i.test(key)) {
      this.emojiQuery += key.toLowerCase();
      this.renderEmojiPanel(view);
      return true;
    }

    if (key === "Backspace") {
      if (!this.emojiQuery) return false;
      this.emojiQuery = this.emojiQuery.slice(0, -1);
      this.renderEmojiPanel(view);
      return true;
    }

    if (!this.emojiQuery) return false;

    if (key === "Escape") {
      this.clearEmoji();
      return true;
    }

    if (key === " ") {
      this.commitEmoji(0, view);
      return true;
    }

    if (/^[1-9]$/.test(key)) {
      this.commitEmoji(Number(key) - 1, view);
      return true;
    }

    return false;
  }

  private commitEmoji(index: number, view: MarkdownView): void {
    const hit = this.emojiHits[index];
    if (!hit) return;
    view.editor.replaceSelection(hit.e);
    this.emojiQuery = "";
    this.renderEmojiPanel(view);
  }

  private clearEmoji(): void {
    this.emojiQuery = "";
    this.emojiHits = [];
    this.hidePanel();
  }

  private renderEmojiPanel(view: MarkdownView): void {
    if (!this.panel || !this.preedit || !this.candidates) return;
    this.emojiHits = searchEmoji(this.emojiQuery, EMOJI_PAGE);
    this.panel.removeClass("is-inline");

    this.preedit.setText(this.emojiQuery ? `😀 ${this.emojiQuery}` : "😀 打关键词搜索表情（xiao / smile / huo）");
    this.candidates.empty();

    if (!this.emojiHits.length) {
      this.candidates.createEl("button", { text: "没有匹配的表情", attr: { type: "button", disabled: "true" } });
    }

    this.emojiHits.forEach((hit, index) => {
      const button = this.candidates!.createEl("button", {
        cls: index === 0 ? "is-highlighted" : "",
        text: `${index + 1} ${hit.e}`,
        attr: { type: "button" }
      });
      bindTap(button, () => {
        this.commitEmoji(index, view);
        view.editor.focus();
      });
    });

    this.positionPanel(this.caretRect(view));
    this.panel.addClass("is-visible");
  }

  /* 候选栏跟随光标。取不到光标位置时退回底部居中。 */
  private caretRect(view: MarkdownView): { left: number; top: number; bottom: number } | null {
    const cm = (view.editor as unknown as {
      cm?: {
        coordsAtPos?(pos: number): { left: number; top: number; bottom: number } | null;
        state?: { selection: { main: { head: number } } };
      };
    }).cm;
    const head = cm?.state?.selection.main.head;
    if (cm?.coordsAtPos && typeof head === "number") {
      const coords = cm.coordsAtPos(head);
      if (coords) return coords;
    }
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.top || rect.left) return { left: rect.left, top: rect.top, bottom: rect.bottom };
    }
    return null;
  }

  private editorViewOf(view: MarkdownView): EditorView | undefined {
    return (view.editor as unknown as { cm?: EditorView }).cm;
  }

  /* 空字符串＝清除。换了编辑器先清旧的，免得旧笔记里留一截拼音。 */
  private setInlinePreedit(view: MarkdownView | undefined, text: string): void {
    const target = text && view ? this.editorViewOf(view) : undefined;
    if (this.inlineTarget && this.inlineTarget !== target) {
      this.dispatchPreedit(this.inlineTarget, "");
      this.inlineTarget = undefined;
    }
    if (!target) return;
    this.dispatchPreedit(target, text);
    this.inlineTarget = target;
  }

  private dispatchPreedit(cm: EditorView, text: string): void {
    try {
      cm.dispatch({ effects: inlinePreeditEffect.of(text) });
    } catch (error) {
      // 编辑器已被关掉（窗格关闭、插件卸载）时 dispatch 可能抛错，没什么可清的了。
      this.log(`行内拼音更新失败：${this.errorMessage(error)}`);
    }
  }

  /* 行内拼音的位置：候选栏贴在拼音开头的正下方。拼音折行时用第一行的左边、整体的底边。 */
  private inlinePreeditRect(): { left: number; top: number; bottom: number } | null {
    const el = this.inlineTarget?.contentDOM.querySelector(`.${INLINE_PREEDIT_CLASS}`);
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const first = el.getClientRects()[0] ?? box;
    if (!box.width && !box.height) return null;
    return { left: first.left, top: box.top, bottom: box.bottom };
  }

  private positionPanel(caret: { left: number; top: number; bottom: number } | null): void {
    const panel = this.panel;
    if (!panel) return;
    if (!caret) {
      panel.removeClass("is-anchored");
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      return;
    }

    panel.addClass("is-anchored");
    // visualViewport 在 iPadOS 上会随软键盘收缩，用它才能避开被键盘盖住。
    const vv = window.visualViewport;
    const minX = vv ? vv.offsetLeft : 0;
    const minY = vv ? vv.offsetTop : 0;
    const maxX = minX + (vv ? vv.width : window.innerWidth);
    const maxY = minY + (vv ? vv.height : window.innerHeight);
    const gap = 6;
    const margin = 8;

    const width = panel.offsetWidth;
    const height = panel.offsetHeight;

    let left = caret.left;
    if (left + width > maxX - margin) left = maxX - margin - width;
    if (left < minX + margin) left = minX + margin;

    let top = caret.bottom + gap;
    if (top + height > maxY - margin) top = caret.top - gap - height;
    if (top < minY + margin) top = minY + margin;

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  /* 引擎用空格分隔音节。汉字部分（已选定的词）不含空格，所以整串替换是安全的；
     用户手打的撇号原样保留。 */
  formatPreedit(text: string): string {
    const sep = PINYIN_SEPARATOR_CHAR[this.settings.pinyinSeparator] ?? "'";
    return sep === " " ? text : text.replace(/ /g, sep);
  }

  /* 内联标题不是 CodeMirror，拿选区的位置；取不到就贴在标题下面。 */
  private titleRect(el: HTMLElement): { left: number; top: number; bottom: number } {
    const selection = window.getSelection();
    if (selection?.rangeCount && el.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (rect && (rect.left || rect.top)) return { left: rect.left, top: rect.top, bottom: rect.bottom };
    }
    const box = el.getBoundingClientRect();
    return { left: box.left, top: box.top, bottom: box.bottom };
  }

  private renderPanel(result: RimeResult, sink: InputSink): void {
    if (!this.panel || !this.preedit || !this.candidates) return;
    const head = result.head ?? "";
    const body = result.body ?? "";
    const tail = result.tail ?? "";
    const text = this.formatPreedit(`${head}${body}${tail}`);
    const view = sink.kind === "editor" ? sink.view : undefined;
    const inline = this.settings.preeditPosition === "inline" && Boolean(view && this.editorViewOf(view));
    this.panel.toggleClass("is-inline", inline);
    this.preedit.setText(inline ? "" : text);
    this.setInlinePreedit(inline ? view : undefined, inline ? text : "");
    this.candidates.empty();
    (result.candidates ?? []).forEach((candidate, index) => {
      const label = result.selectLabels?.[index] ?? String(index + 1);
      const button = this.candidates!.createEl("button", {
        cls: index === result.highlighted ? "is-highlighted" : "",
        text: `${label} ${candidate.text}${candidate.comment ? ` ${candidate.comment}` : ""}`,
        attr: { type: "button" }
      });
      bindTap(button, () => {
        this.restoreTitleFocus(sink);
        const sequence = ++this.inputSequence;
        const generation = this.editorGeneration;
        void this.client!.call<string>("selectCandidateOnCurrentPage", index)
          .then((raw) => {
            this.applyResult(JSON.parse(raw) as RimeResult, "", sink, sequence, generation);
            this.refocus(sink);
          })
          .catch((error) => {
            console.error("RIME input failed", error);
            this.log(`selectCandidate(${index}) 失败：${this.errorMessage(error)}`);
            this.cancelComposition();
            new Notice(`Just Type 输入失败：${this.errorMessage(error)}\n可运行命令「诊断报告 (report)」查看详情`, 8000);
          });
      });
    });
    const anchor = sink.kind === "title"
      ? this.titleRect(sink.el)
      : (inline ? this.inlinePreeditRect() : null) ?? this.caretRect(sink.view);
    this.positionPanel(anchor);
    this.panel.addClass("is-visible");
  }

  /* 活动编辑器不再是按下那一键时的那个。作废在途结果，并清掉引擎组合态，
     否则下一篇笔记里的按键会接着上一篇的拼音缓冲。 */
  private invalidateEditorContext(reason: string): void {
    this.editorGeneration += 1;
    const noteworthy = this.composing || this.emojiQuery.length > 0 || Boolean(this.panel?.classList.contains("is-visible"));
    this.cancelComposition();
    this.clearEmoji();
    if (noteworthy) this.log(`作废编辑器上下文（${reason}）generation=${this.editorGeneration}`);
  }

  private onEditorFocusOut(event: FocusEvent): void {
    if (!this.isInputTarget(event.target)) return;
    // iPadOS 上手指点候选，编辑器会先失焦、relatedTarget 还是空的。这时取消输入会把候选栏
    // 藏起来，点击就落空了（0.7.19 及以前点选上不了屏）。刚按过候选栏就不算离开。
    if (performance.now() - this.panelPressAt < 1000) return;
    const next = event.relatedTarget;
    if (next instanceof Node && this.panel?.contains(next)) return;
    if (this.isEditorTarget(event.target) && this.isEditorTarget(next)) return;
    this.invalidateEditorContext("focusout");
  }

  private cancelComposition(): void {
    this.composing = false;
    this.discardThrough = this.inputSequence;
    this.hidePanel();
    if (this.ready && this.client) void this.client.call<RimeResult>("process", "{Escape}");
  }

  private hidePanel(): void {
    this.setInlinePreedit(undefined, "");
    this.panel?.removeClass("is-visible");
    this.preedit?.setText("");
    this.candidates?.empty();
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
      const maybe = error as { message?: string; status?: number };
      if (maybe.message) return maybe.message;
      if (maybe.status) return `HTTP ${maybe.status}`;
    }
    return String(error);
  }
}
