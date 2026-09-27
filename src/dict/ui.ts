/**
 * 词库在界面上的样子。
 *
 * 对用户来说，词库是自动准备好的东西：正常时什么都不显示，只在没准备好（首次下载、断网、出错）时
 * 说一句现在怎样、要不要做点什么。面向用户只说「词库」，出问题需要解释时才提「内置词库」。
 * 文案只描述真实阶段：字节数来自已存好并核对过的分段；进度只更新状态条，不弹通知。
 */
import { App, Modal, requestUrl } from "obsidian";
import type { DictIdentity } from "../assets";
import type { DictCatalog, DictStatus, RangeFetcher } from "./manager";

/** 用 Obsidian 自己的网络接口取一段字节（iPad 上走原生请求，不受网页跨域限制）。 */
export const requestUrlFetcher: RangeFetcher = async (url, start, end) => {
  const res = await requestUrl({ url, method: "GET", throw: false, headers: { Range: `bytes=${start}-${end}` } });
  return { status: res.status, body: res.arrayBuffer, headers: res.headers };
};

export function fullDictIdentity(catalog: DictCatalog): DictIdentity {
  return { label: catalog.label, source: `${catalog.id}（${catalog.source}）`, files: catalog.files };
}

/** 插件这边的情况：引擎实际在用哪个词库、是否正在切换。 */
export interface DictUiContext {
  fullLoaded: boolean;
  switching?: "full" | "base";
}

function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}

export function approxSize(catalog: DictCatalog): string {
  return `约 ${Math.round(catalog.tarball.bytes / 1e6)} MB`;
}

export type DictAction = "pause" | "resume" | "retry" | "restore" | "download";

/**
 * 一句话状态，加上此刻唯一有意义的一个操作（没有就不显示按钮）。
 * normal＝一切就绪，设置页里这一行不显示；chip＝笔记右上角状态条上的短字（null＝不显示）。
 */
export interface DictLine {
  text: string;
  chip: string | null;
  normal: boolean;
  warn: boolean;
  action?: { kind: DictAction; label: string };
}

export function dictLine(status: DictStatus | undefined, ctx: DictUiContext): DictLine {
  const line = (text: string, chip: string | null, extra: Partial<DictLine> = {}): DictLine => ({ text, chip, normal: false, warn: false, ...extra });
  if (!status) return line("这台设备无法保存词库，暂时用内置词库", null, { warn: true });
  const size = `${mb(status.bytesDone)} / ${mb(status.bytesTotal)} MB`;
  if (ctx.switching === "full") return line("正在启用词库…", "正在启用词库…");
  if (ctx.switching === "base") return line("正在切回内置词库…", "正在切回内置词库…");
  if (status.elsewhere && status.phase !== "active" && status.phase !== "ready" && status.phase !== "paused") {
    return line("另一个 Obsidian 窗口正在下载词库", "另一窗口正在下载词库");
  }
  switch (status.phase) {
    case "active":
    case "ready":
      if (ctx.fullLoaded) return line("词库已就绪，之后不用联网", null, { normal: true });
      return status.phase === "ready"
        ? line("词库下载好了，停手后自动启用", "词库已下载，停手后启用")
        : line("词库已下载，下次打开时启用", null);
    case "downloading":
      return line(`正在下载词库 ${size}，下完前候选词会少一些，照常打字`, `正在下载词库 ${size}`, { action: { kind: "pause", label: "暂停" } });
    case "verifying":
      return line("词库下载好了，正在校验", "词库校验中");
    case "waiting": {
      if (status.error?.kind === "offline") return line("等待联网，联网后自动继续下载词库", "等待联网下载词库");
      const minutes = status.nextRetryAt ? Math.max(1, Math.ceil((status.nextRetryAt - Date.now()) / 60_000)) : 0;
      return line(minutes > 5 ? `词库暂未下载完成，约 ${minutes} 分钟后自动重试` : "词库暂未下载完成，稍后自动重试", "词库稍后重试",
        { action: { kind: "retry", label: "立即重试" } });
    }
    case "paused":
      if (status.pausedReason === "baseOnly") return line("已停止使用下载的词库，暂时用内置词库", null, { action: { kind: "restore", label: "恢复" } });
      return line(`已暂停下载词库${status.segmentsDone ? `（已下 ${mb(status.bytesDone)} MB）` : ""}`, null, { action: { kind: "resume", label: "继续" } });
    case "error":
      if (status.error?.kind === "storage") {
        return line("存储空间不足，词库没下载完，暂时用内置词库", "词库：空间不足", { warn: true, action: { kind: "retry", label: "重试" } });
      }
      return line("词库启用失败，暂时用内置词库", "词库启用失败", { warn: true, action: { kind: "retry", label: "重试" } });
    default:
      return line(status.segmentsDone ? `已下载 ${size}，稍后自动接着下` : `还没下载词库（${approxSize(status.catalog)}），稍后自动开始`, null,
        { action: { kind: "download", label: "现在下载" } });
  }
}

/**
 * 编辑区右上角的一小条状态。只在下载、校验、待启用、启用中、需要留意时出现；
 * 固定定位、不占版面，点一下看详情。iPad 没有状态栏，靠它让用户看得到进度。
 */
export class DictChip {
  private el: HTMLDivElement;

  constructor(onTap: () => void) {
    this.el = document.body.createDiv({ cls: "just-type-dict-chip" });
    this.el.setAttribute("role", "status");
    this.el.addEventListener("click", onTap);
  }

  /** anchor：当前笔记内容区的位置；没有打开的笔记就不显示。 */
  render(line: DictLine | null, anchor: DOMRect | null): void {
    const text = line?.chip;
    if (!text || !anchor || !anchor.width) {
      this.el.removeClass("is-visible");
      return;
    }
    this.el.setText(text);
    this.el.toggleClass("is-attention", Boolean(line?.warn));
    this.el.addClass("is-visible");
    const margin = 10;
    const vv = window.visualViewport;
    const maxRight = vv ? vv.offsetLeft + vv.width : window.innerWidth;
    const right = Math.min(anchor.right, maxRight) - margin;
    this.el.style.left = `${Math.round(Math.max(anchor.left + margin, right - this.el.offsetWidth))}px`;
    this.el.style.top = `${Math.round(anchor.top + margin)}px`;
  }

  remove(): void {
    this.el.remove();
  }
}

/** 详情窗和设置页用到的操作。 */
export interface DictControls {
  snapshot(): { status: DictStatus; ctx: DictUiContext } | undefined;
  subscribe(listener: () => void): () => void;
  run(kind: DictAction): void;
}

export class DictStatusModal extends Modal {
  private unsubscribe?: () => void;

  constructor(app: App, private controls: DictControls) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("词库");
    this.contentEl.addClass("just-type-dict-modal");
    this.render();
    this.unsubscribe = this.controls.subscribe(() => this.render());
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const snap = this.controls.snapshot();
    const line = dictLine(snap?.status, snap?.ctx ?? { fullLoaded: false });
    contentEl.createEl("p", { text: line.text, cls: line.warn ? "just-type-dict-warn" : "" });
    if (snap) {
      const { status } = snap;
      const failing = status.error && status.error.kind !== "offline" && (status.phase === "waiting" || status.phase === "error");
      if (failing) contentEl.createEl("p", { cls: "just-type-dict-note", text: `原因：${status.error!.message}` });
      if (status.phase === "downloading" || (status.segmentsDone > 0 && status.segmentsDone < status.segmentsTotal)) {
        const bar = contentEl.createEl("progress");
        bar.max = status.bytesTotal;
        bar.value = status.bytesDone;
      }
      contentEl.createEl("p", { cls: "just-type-dict-note", text: "来自雾凇拼音 · 只存在这台设备 · 不影响学习记录" });
    }
    const actions = contentEl.createDiv({ cls: "just-type-diag-actions" });
    const action = line.action;
    if (action) actions.createEl("button", { text: action.label, cls: "mod-cta" }).addEventListener("click", () => this.controls.run(action.kind));
    actions.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }
}
