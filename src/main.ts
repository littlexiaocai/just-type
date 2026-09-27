import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { INLINE_PREEDIT_CLASS, inlinePreeditEffect, inlinePreeditExtension } from "./inline-preedit";
import workerSource from "./vendor/my-rime-worker.txt";
import { assetSummary, embeddedDictIdentity, loadLocalAssets, type DictIdentity, type LocalAssets } from "./assets";
import { CATALOG, DEFAULT_CONFIG, DictManager, USING_DEV_URLS, type DictStatus } from "./dict/manager";
import { DictStore } from "./dict/store";
import { approxSize, describeDict, DictChip, DictStatusModal, fullDictIdentity, requestUrlFetcher, type DictControls, type DictUiContext } from "./dict/ui";
import { searchEmoji, type EmojiEntry } from "./emoji";
import { compareVersions, PLUGIN_PAGE_URI, UpdateChecker } from "./update";
import { RELEASE_NOTES, type ReleaseNote } from "./release-notes";

const PLUGIN_VERSION = "0.7.24";
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

/* 上屏后把挂起的学习写进词典，再存盘。
 *
 * librime 每次上屏后，把这次的学习放在一个挂起的事务里（好让用户立刻按退格时撤销），要等下一次
 * 上屏或收到一个引擎不处理的键才真正写入。插件在没有输入时不把退格交给引擎，这个撤销用不上；
 * 反倒是「最后一次上屏」的学习，在 Obsidian 被系统结束时会丢（0.7.22 及以前键盘、点选都会丢）。
 * 所以上屏后立即补发一个引擎不处理的 {F24}，让事务写入，再 syncfs 存盘。只在上屏后已无输入时发，
 * 不打扰还在组字的状态。 */
const FLUSH_LEARNING = 'e.state===0&&Module.ccall("process","string",["string"],["{F24}"]),await y("write")';

/* 对上游 Worker 的全部改动。每处必须恰好命中一次：命中不到说明上游变了，启动时直接报错，绝不悄悄失效。 */
const WORKER_PATCHES: { name: string; from: string; to: string }[] = [
  {
    // pinyin_simp 的依赖表是 bi=["stroke"]。产品不用笔画反查，stroke 会拖进 luna_pinyin，体积翻倍。
    name: "去掉笔画依赖",
    from: 'bi=["stroke"]',
    to: "bi=[]"
  },
  {
    // 上游按「文件名＋源码里写死的 md5」把方案和词库缓存进 IndexedDB「ime」，命中就不再读插件提供的
    // 文件：插件更新了词库，老用户照样用旧缓存。改成每次都走解析器取插件给的文件。
    name: "绕过上游方案／词库缓存",
    from: "await ta.get(a,o,ca(c,a))",
    to: 'await fetch(ca(c,a)).then(r=>{if(!r.ok)throw new Error("Fail to download "+a);return r.arrayBuffer()})'
  },
  {
    name: "键盘上屏后写入学习并存盘",
    from: 'async process(n){const e=JSON.parse(Module.ccall("process","string",["string"],[n]));return"committed"in e&&await y("write"),e}',
    to: `async process(n){const e=JSON.parse(Module.ccall("process","string",["string"],[n]));return"committed"in e&&(${FLUSH_LEARNING}),e}`
  },
  {
    // 手指点选原来连存盘都不做。
    name: "点选上屏后写入学习并存盘",
    from: 'selectCandidateOnCurrentPage(n){return Module.ccall("select_candidate_on_current_page","string",["number"],[n])}',
    to: `async selectCandidateOnCurrentPage(n){const r=Module.ccall("select_candidate_on_current_page","string",["number"],[n]),e=JSON.parse(r);return"committed"in e&&(${FLUSH_LEARNING}),r}`
  }
];

function patchWorkerSource(source: string): string {
  let patched = source;
  for (const patch of WORKER_PATCHES) {
    const hits = patched.split(patch.from).length - 1;
    if (hits !== 1) {
      throw new Error(`Just Type：worker 补丁「${patch.name}」应命中 1 次，实际 ${hits}。上游 worker 可能已变化。`);
    }
    patched = patched.replace(patch.from, patch.to);
  }
  return patched;
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

  /** 等已排队的调用都处理完。换引擎前用：在途的按键和存盘先做完。 */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  destroy(): void {
    // 还没回来的调用立刻失败，之后的调用也直接失败：停掉的 Worker 不会再回话，不能让调用链一直挂着。
    this.fatal ??= new Error("RIME 引擎已停止");
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.fatal);
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
  updateCheck: boolean;
}

const DEFAULT_SETTINGS: JustTypeSettings = { toggleKey: "Shift", pinyinSeparator: "apostrophe", preeditPosition: "inline", updateCheck: true };

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

const UPDATE_DESC = "每 24 小时最多联网一次（npmmirror，备选 jsDelivr、GitHub），只读取最新版本号和一句更新要点，不发送任何本机数据。更新仍由你在插件页自己点「更新」。每台设备分别提醒。";

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
    }, {
      name: "完整词库",
      desc: `${this.plugin.dictSummary()} 点这里看详情、暂停或只用基础词库。`,
      aliases: ["dictionary", "词库", "完整词库", "下载", "雾凇", "rime-ice"],
      action: () => this.plugin.openDictStatus()
    }, {
      name: "立即重试下载完整词库",
      desc: "马上开始新一轮下载，不等自动重试。已下载并核对过的部分不会重下。",
      aliases: ["retry", "dictionary", "重试", "词库"],
      action: () => this.plugin.dictRetry()
    }, {
      name: "暂停或继续自动下载完整词库",
      desc: "暂停后重开 Obsidian 也保持暂停，直到你点继续。已下载的部分保留。",
      aliases: ["pause", "resume", "dictionary", "暂停", "继续", "词库"],
      action: () => this.plugin.dictTogglePause()
    }, {
      name: "有新版本时提醒",
      desc: UPDATE_DESC,
      aliases: ["update", "version", "更新", "版本", "提醒"],
      control: { type: "toggle", key: "updateCheck" }
    }, {
      name: "现在检查新版本",
      desc: "立即联网查一次，不受 24 小时间隔限制。",
      aliases: ["check", "update", "检查更新"],
      action: () => void this.plugin.checkUpdateNow()
    }, {
      name: "不再提醒已发现的新版本",
      desc: "只对目前发现的这个版本生效；以后出了更新的版本还会提醒。",
      aliases: ["ignore", "update", "不再提醒"],
      action: () => this.plugin.ignorePendingUpdate()
    }, {
      name: "查看最近更新",
      desc: "看看最近几个版本改了什么。",
      aliases: ["changelog", "what's new", "更新说明"],
      action: () => this.plugin.openWhatsNew()
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

    new Setting(containerEl)
      .setName("完整词库")
      .setDesc(this.plugin.dictSummary())
      .addButton((button) => button.setButtonText("详情").onClick(() => this.plugin.openDictStatus()))
      .addButton((button) => button.setButtonText("立即重试").onClick(() => this.plugin.dictRetry()))
      .addButton((button) => button.setButtonText("暂停／继续").onClick(() => this.plugin.dictTogglePause()));

    new Setting(containerEl)
      .setName("有新版本时提醒")
      .setDesc(UPDATE_DESC)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.updateCheck);
        toggle.onChange(async (value) => {
          this.plugin.settings.updateCheck = value;
          await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton((button) => button.setButtonText("现在检查").onClick(() => void this.plugin.checkUpdateNow()));

    new Setting(containerEl)
      .setName("最近更新")
      .setDesc("看看最近几个版本改了什么。")
      .addButton((button) => button.setButtonText("查看").onClick(() => this.plugin.openWhatsNew()));
  }
}

/* 「这次更新了什么」：按版本分组列出要点。 */
class WhatsNewModal extends Modal {
  constructor(app: App, private notes: ReleaseNote[], private heading: string) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    for (const note of this.notes) {
      this.contentEl.createEl("h4", { text: note.version, cls: "just-type-whatsnew-version" });
      const list = this.contentEl.createEl("ul", { cls: "just-type-whatsnew-list" });
      for (const item of note.items) list.createEl("li", { text: item });
    }
    const actions = this.contentEl.createDiv({ cls: "just-type-diag-actions" });
    actions.createEl("button", { text: "知道了", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
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
  private updates?: UpdateChecker;
  /* 引擎实际加载的词库（不是用户选的档位或下载目标）。引擎就绪后才有值。 */
  private loadedDict?: DictIdentity;
  /* 完整词库：后台下载任务和它在本机的存储。存储打不开（极少见）时为空，只用基础词库。 */
  private dict?: DictManager;
  private dictStore?: DictStore;
  private dictChip?: DictChip;
  private dictListeners = new Set<() => void>();
  private dictFrame?: number;
  private dictNoticed = new Set<string>();
  /* 引擎实际在用的词库，和下载任务的状态分开记。 */
  private engineDict: "base" | "full" = "base";
  /* 换引擎期间到来的按键，按到达顺序排队，新引擎（或退回的基础引擎）就绪后依次交给它。 */
  private engineQueue?: (() => void)[];
  private switching?: "base" | "full";
  private switchTimer?: number;
  /* 这次打开里完整词库启用失败过：同一次里不反复启用同一个包，下次打开或手动重试再说。 */
  private activationFailedThisRun = false;
  private lastCaptureAt = -Infinity;
  /* 这次启动已经提醒过的版本：同一次打开里不重复弹。 */
  private remindedVersion?: string;
  private upgradedFrom?: string;
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

    // 新版本提醒不依赖引擎：引擎加载失败的用户更需要知道有新版本。
    this.updates = new UpdateChecker(this.app, PLUGIN_VERSION, (message) => this.log(message));
    this.upgradedFrom = this.updates.recordRun();
    if (this.settings.updateCheck) {
      this.remindIfNewer();
      void this.updates.maybeCheck().then((got) => { if (got) this.remindIfNewer(); });
    }
    // iPad 上 Obsidian 常常只是切到后台，回到前台时也按 24 小时间隔查一次。
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible" || !this.settings.updateCheck || !this.updates) return;
      void this.updates.maybeCheck().then((got) => { if (got) this.remindIfNewer(); });
    });
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
      // 只读本机状态、不联网：已经装好完整词库就直接用它，否则先用基础词库。
      await this.openDict();
      let client = this.dict?.canActivate() ? await this.startFullEngine() : undefined;
      if (!client) {
        const t0assets = Date.now();
        const assets = await loadLocalAssets();
        this.log(`内嵌资源解压完成（${Date.now() - t0assets}ms）`);
        client = await this.startEngine(assets, "基础词库");
        this.engineDict = "base";
        this.loadedDict = embeddedDictIdentity();
      }
      this.client = client;
      this.ready = true;
      this.updateStatus();
      this.log(`就绪，总耗时 ${Date.now() - this.startedAt}ms`);
      if (this.upgradedFrom) this.showUpgradedNotice(this.upgradedFrom);
      else new Notice(this.readyHint());
      this.startDictTasks();
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
    if (this.switchTimer !== undefined) window.clearTimeout(this.switchTimer);
    if (this.dictFrame !== undefined) window.cancelAnimationFrame(this.dictFrame);
    this.dict?.dispose();
    this.dictStore?.close();
    this.dictChip?.remove();
    this.client?.destroy();
    this.panel?.remove();
  }

  /* ---------------- 引擎与词库 ---------------- */

  /** 建 Worker 并加载方案。probe：加载后打一个字母看有没有候选再取消，不上屏、不写学习记录。 */
  private async startEngine(assets: LocalAssets, label: string, probe = false): Promise<RimeWorkerClient> {
    const t0 = Date.now();
    const client = new RimeWorkerClient(workerSource, assets, (message) => this.log(message));
    try {
      await timeout(client.call<void>("setIME", "pinyin_simp"), INIT_TIMEOUT_MS, `加载 RIME 引擎与${label}`);
      this.log(`setIME(pinyin_simp) 完成：${label}（${Date.now() - t0}ms）`);
      await timeout(client.call<void>("setPageSize", 7), 10000, "设置候选页大小");
      if (probe) {
        const result = await timeout(client.call<RimeResult>("process", "a"), 10000, "词库就绪检查");
        await timeout(client.call<RimeResult>("process", "{Escape}"), 10000, "词库就绪检查");
        if (result.state !== 1 || !result.candidates?.length) throw new Error("词库就绪检查没有得到候选");
      }
    } catch (error) {
      client.destroy();
      throw error;
    }
    return client;
  }

  /** 把下载的完整词库文件放进引擎资源，替换内置的同名文件。 */
  private async fullAssets(files: Map<string, Uint8Array>): Promise<LocalAssets> {
    const assets = await loadLocalAssets(true);
    for (const [name, data] of files) {
      assets.binaries[name] = data.byteLength === data.buffer.byteLength ? data.buffer as ArrayBuffer : data.slice().buffer;
    }
    return assets;
  }

  /** 读本机的完整词库状态。只碰 IndexedDB，不联网；打不开就只用基础词库。 */
  private async openDict(): Promise<void> {
    const store = new DictStore();
    const dict = new DictManager(store, requestUrlFetcher, CATALOG, DEFAULT_CONFIG, (message) => this.log(message));
    try {
      await timeout(dict.init(), 10000, "读取完整词库状态");
    } catch (error) {
      this.log(`完整词库存储不可用，只用基础词库：${this.errorMessage(error)}`);
      dict.dispose();
      store.close();
      return;
    }
    this.dict = dict;
    this.dictStore = store;
    const status = dict.status();
    this.log(`完整词库状态：${status.phase}，已有 ${status.segmentsDone}/${status.segmentsTotal} 段${USING_DEV_URLS ? "（测试下载地址）" : ""}`);
  }

  /** 启动时用已装好的完整词库起引擎。取不出、校验不过或起不来都返回 undefined，由调用方改用基础词库。 */
  private async startFullEngine(): Promise<RimeWorkerClient | undefined> {
    const dict = this.dict!;
    const t0 = Date.now();
    try {
      const files = await dict.extractInstalled();
      if (!files) {
        this.dictLog("完整词库校验未通过，这次用基础词库，稍后自动补下");
        return undefined;
      }
      this.dictLog(`完整词库取出并校验完成（${Date.now() - t0}ms）`);
      const assets = await this.fullAssets(files);
      await dict.beginActivation();
      try {
        const client = await this.startEngine(assets, "完整词库", true);
        await dict.endActivation(true);
        this.engineDict = "full";
        this.loadedDict = fullDictIdentity(dict.catalog);
        this.dictLog(`启动即用完整词库（取出校验＋加载共 ${Date.now() - t0}ms）`);
        this.noticeOnce("activated", "完整词库已就绪，之后可离线使用");
        return client;
      } catch (error) {
        this.activationFailedThisRun = true;
        await dict.endActivation(false, this.errorMessage(error));
        throw error;
      }
    } catch (error) {
      this.dictLog(`完整词库启用失败，改用基础词库：${this.errorMessage(error)}`);
      return undefined;
    }
  }

  /** 基础输入就绪后：挂上状态条和前台、联网事件，稍后开始（或接着）下载。 */
  private startDictTasks(): void {
    const dict = this.dict;
    if (!dict) return;
    this.dictChip = new DictChip(() => this.openDictStatus());
    dict.onChange((status) => this.onDictStatus(status));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") dict.schedule("foreground");
    });
    this.registerDomEvent(window, "online", () => dict.schedule("online"));
    this.registerDomEvent(window, "resize", () => this.refreshDict());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshDict()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshDict()));
    // 让基础输入先稳下来，不和打开软件时的第一波输入抢资源。
    const timer = window.setTimeout(() => dict.schedule("startup"), 3000);
    this.register(() => window.clearTimeout(timer));
    // 启动时已经是需要提示的状态（例如上次启用失败被停用）：按同样的规则处理一遍。
    this.onDictStatus(dict.status());
  }

  private onDictStatus(status: DictStatus): void {
    this.refreshDict();
    if (status.phase === "downloading" && !status.resuming) {
      this.noticeOnce("download-started", `基础词库已就绪，正在后台下载完整词库（${approxSize(status.catalog)}），可继续输入。`);
    }
    if (status.phase === "error" && status.error) {
      this.noticeOnce(`error-${status.error.kind}`, describeDict(status, this.dictContext()).detail, 12000);
    }
    this.syncEngine();
  }

  /** 与词库切换有关的日志：同时记进跨重启保留的下载事件。 */
  private dictLog(message: string): void {
    if (this.dict) this.dict.record(message);
    else this.log(message);
  }

  /** 一次性提示：同一个词库版本只提示一次，跨重启记住。 */
  private noticeOnce(key: string, text: string, duration = 8000): void {
    const dict = this.dict;
    if (!dict || this.dictNoticed.has(key)) return;
    this.dictNoticed.add(key);
    void dict.claimNotice(key).then((first) => {
      if (first) new Notice(text, duration);
    });
  }

  private dictContext(): DictUiContext {
    return { fullLoaded: this.engineDict === "full", switching: this.switching };
  }

  /** 状态条和打开着的详情窗跟着刷新，一帧最多一次。 */
  private refreshDict(): void {
    if (this.dictFrame !== undefined) return;
    this.dictFrame = window.requestAnimationFrame(() => {
      this.dictFrame = undefined;
      const dict = this.dict;
      if (!dict) return;
      const view = this.activeEditor();
      this.dictChip?.render(describeDict(dict.status(), this.dictContext()), view ? view.contentEl.getBoundingClientRect() : null);
      for (const listener of this.dictListeners) listener();
    });
  }

  /** 该用哪个词库：已下载齐、没被停用、没选只用基础词库，且这次打开里没启用失败过，就用完整词库。 */
  private wantedDict(): "base" | "full" {
    return this.dict?.canActivate() && !this.activationFailedThisRun ? "full" : "base";
  }

  /** 用户停手：没有正在打的拼音或表情，2 秒内没按过键，窗口在前台。 */
  private inputIdle(): boolean {
    return !this.composing && !this.emojiQuery && !this.engineQueue
      && performance.now() - this.lastCaptureAt > 2000 && document.visibilityState === "visible";
  }

  /** 实际在用的和该用的不一致时，等用户停手再换。一直在打字就一直等，停下来就换。 */
  private syncEngine(): void {
    if (!this.ready || this.switching || this.switchTimer !== undefined) return;
    if (this.wantedDict() === this.engineDict) return;
    const check = (): void => {
      this.switchTimer = undefined;
      if (!this.ready || this.switching) return;
      const want = this.wantedDict();
      if (want === this.engineDict) return;
      if (!this.inputIdle()) {
        this.switchTimer = window.setTimeout(check, 1000);
        return;
      }
      void this.switchEngine(want);
    };
    this.switchTimer = window.setTimeout(check, 1000);
  }

  /**
   * 换引擎。先在旧引擎照常服务时把新词库准备好（取出、校验、备份学习记录），
   * 再用很短的时间停旧起新；这期间的按键排队，新引擎就绪后按原顺序处理。
   * 新引擎起不来就退回基础词库。两个 Worker 不同时挂着用户词典：同时写同一份学习记录会互相覆盖。
   */
  private async switchEngine(target: "base" | "full"): Promise<void> {
    const dict = this.dict;
    if (this.switching || !this.client || (target === "full" && !dict)) return;
    const label = target === "full" ? "完整词库" : "基础词库";
    this.switching = target;
    this.refreshDict();
    const t0 = Date.now();

    let assets: LocalAssets;
    try {
      if (target === "full") {
        const files = await dict!.extractInstalled();
        if (!files) throw new Error("完整词库校验未通过");
        assets = await this.fullAssets(files);
        await this.backupUserDict();
      } else {
        assets = await loadLocalAssets();
      }
    } catch (error) {
      this.dictLog(`准备切换到${label}失败：${this.errorMessage(error)}`);
      this.switching = undefined;
      this.refreshDict();
      return;
    }
    // 准备期间用户又开始打字了：这次不换，等下一次停手。
    if (!this.inputIdle() || !this.client) {
      this.switching = undefined;
      this.refreshDict();
      this.syncEngine();
      return;
    }

    this.engineQueue = [];
    const old = this.client;
    await timeout(old.idle(), 5000, "等待引擎处理完在途按键").catch(() => undefined);
    old.destroy();
    this.client = undefined;
    try {
      if (target === "full") await dict!.beginActivation();
      this.client = await this.startEngine(assets, label, target === "full");
      this.engineDict = target;
      this.loadedDict = target === "full" ? fullDictIdentity(dict!.catalog) : embeddedDictIdentity();
      if (target === "full") {
        await dict!.endActivation(true);
        this.noticeOnce("activated", "完整词库已就绪，之后可离线使用");
      }
      this.dictLog(`已切换到${label}（准备＋切换共 ${Date.now() - t0}ms）`);
    } catch (error) {
      const message = this.errorMessage(error);
      this.dictLog(`切换到${label}失败：${message}`);
      if (target === "full") {
        this.activationFailedThisRun = true;
        await dict!.endActivation(false, message);
      }
      if (!this.client) await this.recoverBaseEngine();
    } finally {
      this.switching = undefined;
      const queued = this.engineQueue ?? [];
      this.engineQueue = undefined;
      for (const task of queued) task();
      this.refreshDict();
      this.syncEngine();
    }
  }

  /** 新引擎起不来时重建基础词库引擎。连它也起不来就如实显示加载失败，不假装就绪。 */
  private async recoverBaseEngine(): Promise<void> {
    try {
      this.client = await this.startEngine(await loadLocalAssets(), "基础词库");
      this.engineDict = "base";
      this.loadedDict = embeddedDictIdentity();
    } catch (error) {
      const message = this.errorMessage(error);
      this.client = undefined;
      this.ready = false;
      this.initError = message;
      this.loadedDict = undefined;
      this.log(`基础词库也没能重新加载：${message}`);
      this.updateStatus("加载失败");
      new Notice(`Just Type 加载失败：${message}\n运行命令「诊断报告 (report)」查看详情`, 15000);
    }
  }

  /**
   * 第一次换成完整词库前，把学习记录（/rime 下除 build 以外的文件）在本机备份一份。
   * 学习记录和词库本来互不相干，换词库不会动它；这只是多一道保险，失败也不影响切换。
   */
  private async backupUserDict(): Promise<void> {
    const store = this.dictStore;
    const client = this.client;
    if (!store || !client) return;
    const key = "userdb-before-full";
    try {
      if (await store.getBackup(key)) return;
      const files: Record<string, Uint8Array> = {};
      let bytes = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const name of await client.call<string[]>("fsOperate", "readdir", dir)) {
          if (name === "." || name === ".." || (dir === "/rime" && name === "build")) continue;
          const path = `${dir}/${name}`;
          const stat = await client.call<{ mode: number }>("fsOperate", "stat", path);
          if (await client.call<boolean>("fsOperate", "isDir", stat.mode)) {
            await walk(path);
            continue;
          }
          const data = await client.call<Uint8Array>("fsOperate", "readFile", path);
          bytes += data.byteLength;
          if (bytes > 50e6) throw new Error("学习记录超过 50 MB，不做备份");
          files[path] = data;
        }
      };
      await walk("/rime");
      await store.putBackup(key, { at: Date.now(), plugin: PLUGIN_VERSION, files });
      this.dictLog(`学习记录已备份：${Object.keys(files).length} 个文件，${bytes} B`);
    } catch (error) {
      this.dictLog(`学习记录备份失败（不影响切换）：${this.errorMessage(error)}`);
    }
  }

  /* 设置页和详情窗用的操作。 */
  private dictControls(): DictControls {
    return {
      snapshot: () => (this.dict ? { status: this.dict.status(), ctx: this.dictContext() } : undefined),
      subscribe: (listener) => {
        this.dictListeners.add(listener);
        return () => this.dictListeners.delete(listener);
      },
      retry: () => this.dictRetry(),
      pause: () => void this.dict?.pause(),
      resume: () => void this.dict?.resume(),
      setBaseOnly: (on) => {
        if (!on) this.activationFailedThisRun = false;
        void this.dict?.setBaseOnly(on);
      },
      remove: () => void this.dict?.removeDownloaded().then(() => new Notice("已删除下载的完整词库，学习记录不受影响。之后只用基础词库，需要时可在设置里恢复。", 8000))
    };
  }

  openDictStatus(): void {
    new DictStatusModal(this.app, this.dictControls()).open();
  }

  dictSummary(): string {
    return this.dict ? describeDict(this.dict.status(), this.dictContext()).detail : "这台设备上完整词库存储不可用，基础词库可正常使用。";
  }

  dictRetry(): void {
    if (!this.dict) return;
    this.activationFailedThisRun = false;
    void this.dict.retryNow();
    new Notice("开始重新下载完整词库，已核对过的部分不会重下。", 5000);
  }

  dictTogglePause(): void {
    const dict = this.dict;
    if (!dict) return;
    if (dict.status().pausedReason === "paused") {
      void dict.resume();
      new Notice("继续下载完整词库。", 5000);
    } else {
      void dict.pause();
      new Notice("已暂停下载完整词库，重开 Obsidian 也保持暂停，可随时继续。", 6000);
    }
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
      "--- 内嵌资源（引擎与基础词库，运行时不下载）---",
      assetSummary(),
      "",
      "--- 词库（当前实际加载）---",
      ...(this.loadedDict
        ? [`  ${this.loadedDict.label}：${this.loadedDict.source}`, ...this.loadedDict.files.map((f) => `    ${f.name}  ${f.bytes} B  sha256 ${f.sha256}`)]
        : ["  （引擎尚未就绪，没有加载词库）"]),
      "",
      "--- 完整词库（后台任务，只在本机）---",
      ...this.dictReport(),
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

  private dictReport(): string[] {
    const dict = this.dict;
    if (!dict) return ["  存储不可用，只用基础词库"];
    const s = dict.status();
    const time = (at?: number): string => (at ? new Date(at).toLocaleString() : "无");
    return [
      `  目标 ${s.catalog.id}｜tgz ${s.catalog.tarball.bytes} B｜sha256 ${s.catalog.tarball.sha256}`,
      `  下载地址 ${s.catalog.urls.join(" → ")}${USING_DEV_URLS ? "（测试地址）" : ""}`,
      `  阶段 ${s.phase}｜已核对 ${s.segmentsDone}/${s.segmentsTotal} 段（${s.bytesDone}/${s.bytesTotal} B）｜接着下 ${s.resuming}`,
      `  暂停意图 ${s.pausedReason ?? "无"}｜下次自动重试 ${time(s.nextRetryAt)}`,
      `  最近错误 ${s.error ? `${s.error.kind}：${s.error.message}` : "无"}`,
      `  引擎在用 ${this.engineDict}｜切换中 ${this.switching ?? "否"}｜这次启用失败过 ${this.activationFailedThisRun}｜记录的启用版本 ${s.activeId ?? "无"}｜另一窗口在下 ${s.elsewhere}`,
      `  设备在线 navigator.onLine = ${String(navigator.onLine)}`,
      `  最近下载事件（跨重启保留，最多 60 条）：`,
      ...(s.history.length ? s.history.map((line) => `    ${line}`) : ["    （无）"])
    ];
  }

  /* ---------------- 新版本与更新说明 ---------------- */

  /* 不会自动消失，直到点按钮或点通知本身。这次打开里同一个版本只弹一次；下次打开还会再提醒。 */
  private remindIfNewer(): void {
    const info = this.updates?.newer();
    if (!info || this.updates!.isIgnored(info.version) || this.remindedVersion === info.version) return;
    this.remindedVersion = info.version;
    const message = createFragment((f) => {
      f.createDiv({ cls: "just-type-update-title", text: `Just Type 有新版本 ${info.version}（当前 ${PLUGIN_VERSION}）` });
      if (info.headline) f.createDiv({ cls: "just-type-update-headline", text: info.headline });
      const actions = f.createDiv({ cls: "just-type-update-actions" });
      actions.createEl("button", { text: "去更新", cls: "mod-cta" }).addEventListener("click", () => this.openPluginPage());
      // 点通知任何地方它都会收起；「稍后提醒」就是收起，下次打开 Obsidian 再说。
      actions.createEl("button", { text: "稍后提醒" });
    });
    new Notice(message, 0);
  }

  /* 走 Obsidian 自己的插件页，由用户点「更新」完成官方流程。插件不下载、不安装自己。 */
  private openPluginPage(): void {
    window.open(PLUGIN_PAGE_URI);
  }

  private notesSince(previous: string): ReleaseNote[] {
    return RELEASE_NOTES.filter((note) => compareVersions(note.version, previous) > 0 && compareVersions(note.version, PLUGIN_VERSION) <= 0);
  }

  /* 升级后第一次启动：把平时的「已就绪」换成这一条，不额外多弹。 */
  private showUpgradedNotice(previous: string): void {
    const notes = this.notesSince(previous);
    if (!notes.length) {
      new Notice(this.readyHint());
      return;
    }
    // 点击监听挂在自己建的元素上，不用 Notice.messageEl（1.8.7 才有）。
    const message = createFragment((f) => {
      const box = f.createDiv();
      box.createDiv({ cls: "just-type-update-title", text: `Just Type 已更新到 ${PLUGIN_VERSION}，已就绪` });
      box.createDiv({ cls: "just-type-update-link", text: "点这里看更新了什么" });
      box.addEventListener("click", () => new WhatsNewModal(this.app, notes, `Just Type ${PLUGIN_VERSION} 更新了什么`).open());
    });
    new Notice(message, 12000);
  }

  openWhatsNew(): void {
    const notes = RELEASE_NOTES.filter((note) => compareVersions(note.version, PLUGIN_VERSION) <= 0).slice(0, 3);
    new WhatsNewModal(this.app, notes, "Just Type 最近更新").open();
  }

  ignorePendingUpdate(): void {
    const info = this.updates?.newer();
    if (!info || this.updates!.isIgnored(info.version)) {
      new Notice(`目前没有待提醒的新版本（当前 ${PLUGIN_VERSION}）。`, 5000);
      return;
    }
    this.updates!.ignore(info.version);
    new Notice(`不再提醒 ${info.version}。以后出了更新的版本还会提醒。`, 6000);
  }

  async checkUpdateNow(): Promise<void> {
    if (!this.updates) return;
    const pending = new Notice("正在检查 Just Type 新版本…", 0);
    const got = await this.updates.maybeCheck(true);
    pending.hide();
    if (!got) {
      new Notice("检查失败：网络连不上版本信息地址。不影响输入，稍后会自动再试。", 8000);
      return;
    }
    const info = this.updates.newer();
    if (!info) {
      new Notice(`Just Type ${PLUGIN_VERSION} 已是最新版。`, 5000);
      return;
    }
    this.remindedVersion = undefined;
    this.remindIfNewer();
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
    this.addCommand({
      id: "dictionary-status",
      name: "完整词库状态 (dictionary)",
      callback: () => this.openDictStatus()
    });
    this.addCommand({
      id: "whats-new",
      name: "查看最近更新 (what's new)",
      callback: () => this.openWhatsNew()
    });
    this.addCommand({
      id: "check-update",
      name: "检查新版本 (check update)",
      callback: () => void this.checkUpdateNow()
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
    if (!this.ready || (!this.client && !this.engineQueue)) return this.skip("引擎未就绪");
    if (!this.isInputTarget(event.target)) return this.skip("焦点不在编辑器");
    // The system IME is still composing (it was left on a Chinese layout). Letting
    // RIME also consume the key commits the same word twice.
    if (isSystemImeComposing(event)) return this.skip("系统输入法组合中");
    if (event.metaKey || event.ctrlKey || event.altKey) return this.skip("带修饰键");
    if (event.shiftKey && event.key.length !== 1) return this.skip("带修饰键");
    // 换引擎时排着队的键还没交给引擎，组字状态未知：按「正在组字」对待，空格、数字、退格才不会漏进正文。
    if (this.composing || this.engineQueue?.length) {
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
    const target = event.target instanceof Element ? event.target.className.toString().slice(0, 60) : (event.target === null ? "null" : event.target.constructor.name);
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
    const key = event.key;
    this.lastCaptureAt = performance.now();
    this.withEngine(() => this.sendKey(rimeKey, key, sink, sequence, generation));
  }

  /* 正在换引擎就先排队，换好后按到达顺序执行；平时直接执行。 */
  private withEngine(task: () => void): void {
    if (this.engineQueue) this.engineQueue.push(task);
    else task();
  }

  private sendKey(rimeKey: string, key: string, sink: InputSink, sequence: number, generation: number): void {
    const client = this.client;
    if (!client) return;
    void client.call<RimeResult>("process", rimeKey)
      .then((result) => COMMA_KEYS.has(key) ? this.confirmComma(client, result) : result)
      .then((result) => this.applyResult(result, key, sink, sequence, generation))
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
  private async confirmComma(client: RimeWorkerClient, result: RimeResult): Promise<RimeResult> {
    if (result.state !== 1 || result.candidates?.[0]?.text !== "、") return result;
    const next = await client.call<RimeResult>("process", "{space}");
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
        this.withEngine(() => {
          const client = this.client;
          if (!client) return;
          void client.call<string>("selectCandidateOnCurrentPage", index)
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
    if (this.ready) this.withEngine(() => void this.client?.call<RimeResult>("process", "{Escape}").catch(() => undefined));
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
