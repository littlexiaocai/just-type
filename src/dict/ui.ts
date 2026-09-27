/**
 * 完整词库在界面上的样子：一句状态说明、编辑区右上角的小状态条、点开后的详情窗。
 *
 * 文案只描述真实阶段：下载的字节数来自已存好并核对过的分段，「100%」只代表传输结束，
 * 校验、待启用、启用中分开说。进度只更新状态条，不弹通知。
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

export interface DictDescription {
  /** 状态条上的短字；null＝不显示状态条。 */
  chip: string | null;
  detail: string;
  /** 需要用户留意（空间不足、已停用）。 */
  attention: boolean;
}

function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}

export function approxSize(catalog: DictCatalog): string {
  return `约 ${Math.round(catalog.tarball.bytes / 1e6)} MB`;
}

export type DictAction = "pause" | "resume" | "retry" | "restore" | "download";

/** 设置页和详情窗用的一句话状态，加上此刻唯一有意义的一个操作（没有就不显示按钮）。 */
export interface DictLine {
  text: string;
  warn: boolean;
  action?: { kind: DictAction; label: string };
}

export function dictLine(status: DictStatus | undefined, ctx: DictUiContext): DictLine {
  if (!status) return { text: "这台设备无法保存完整词库，基础词库照常可用", warn: false };
  const catalog = status.catalog;
  const size = `${mb(status.bytesDone)} / ${mb(status.bytesTotal)} MB`;
  const entries = catalog.entries ? `约 ${Math.round(catalog.entries / 1e4)} 万词条` : approxSize(catalog);
  if (ctx.switching === "full") return { text: "正在启用完整词库…", warn: false };
  if (ctx.switching === "base") return { text: "正在切回基础词库…", warn: false };
  if (status.elsewhere && status.phase !== "active" && status.phase !== "ready" && status.phase !== "paused") {
    return { text: "另一个 Obsidian 窗口正在下载", warn: false };
  }
  switch (status.phase) {
    case "active":
    case "ready":
      if (ctx.fullLoaded) return { text: `已启用 · ${entries}，离线可用`, warn: false };
      return { text: status.phase === "ready" ? "已下载，停手后自动启用" : "已下载，下次打开时启用", warn: false };
    case "downloading":
      return { text: `正在下载 ${size}，可继续打字`, warn: false, action: { kind: "pause", label: "暂停" } };
    case "verifying":
      return { text: "下载完成，正在校验", warn: false };
    case "waiting": {
      if (status.error?.kind === "offline") return { text: "等待联网，联网后自动继续", warn: false };
      const minutes = status.nextRetryAt ? Math.max(1, Math.ceil((status.nextRetryAt - Date.now()) / 60_000)) : 0;
      return { text: minutes > 5 ? `暂未下完，约 ${minutes} 分钟后自动重试` : "暂未下完，稍后自动重试", warn: false, action: { kind: "retry", label: "立即重试" } };
    }
    case "paused":
      if (status.pausedReason === "baseOnly") return { text: "只用基础词库", warn: false, action: { kind: "restore", label: "恢复" } };
      return { text: `已暂停${status.segmentsDone ? ` · 已下载 ${mb(status.bytesDone)} MB` : ""}`, warn: false, action: { kind: "resume", label: "继续" } };
    case "error":
      if (status.error?.kind === "storage") return { text: "存储空间不足，释放空间后点重试", warn: true, action: { kind: "retry", label: "重试" } };
      return { text: "这个版本启用或校验失败，已停用", warn: true, action: { kind: "retry", label: "重试" } };
    default:
      return {
        text: status.segmentsDone ? `已下载 ${size}，稍后自动接着下` : `未下载（${approxSize(catalog)}），稍后自动下载`,
        warn: false,
        action: { kind: "download", label: "现在下载" }
      };
  }
}

export function describeDict(status: DictStatus, ctx: DictUiContext): DictDescription {
  const size = `${mb(status.bytesDone)} / ${mb(status.bytesTotal)} MB`;
  const reason = status.error ? `（原因：${status.error.message}）` : "";

  if (ctx.switching === "full") {
    return { chip: "正在启用完整词库…", detail: "正在启用完整词库。这一瞬间打的字会在启用后按顺序处理，不会丢。", attention: false };
  }
  if (ctx.switching === "base") {
    return { chip: "正在切回基础词库…", detail: "正在切回基础词库。学习记录不受影响。", attention: false };
  }

  if (status.elsewhere && status.phase !== "active" && status.phase !== "ready" && status.phase !== "paused") {
    return { chip: "完整词库 另一窗口下载中", detail: "另一个 Obsidian 窗口正在下载完整词库，这里等它下完直接使用，不重复下载。", attention: false };
  }

  switch (status.phase) {
    case "active":
      return {
        chip: null,
        detail: ctx.fullLoaded
          ? `完整词库已启用：${status.catalog.label}。之后可离线使用。`
          : "完整词库已下载并校验，下次打开时启用。",
        attention: false
      };
    case "ready":
      return {
        chip: ctx.fullLoaded ? null : "完整词库已下载，结束当前输入后启用",
        detail: ctx.fullLoaded
          ? `完整词库已启用：${status.catalog.label}。之后可离线使用。`
          : "完整词库已下载并校验。结束当前输入、停手约 2 秒后自动启用，不会打断正在打的拼音。",
        attention: false
      };
    case "downloading":
      return {
        chip: `完整词库 ${size}`,
        detail: `正在后台从 ${status.source} 下载完整词库：${size}。可继续输入，基础词库照常工作。国内源慢时会自动改从国外源下。`
          + (status.resuming ? "接着上次已下载并核对过的部分继续，不从头重下。" : ""),
        attention: false
      };
    case "verifying":
      return { chip: "完整词库 校验中", detail: "传输完成，正在逐个核对文件（还没有启用）。", attention: false };
    case "waiting": {
      if (status.error?.kind === "offline") {
        return { chip: "完整词库 等待联网", detail: "设备离线。联网后自动继续，基础词库可正常使用。", attention: false };
      }
      const minutes = status.nextRetryAt ? Math.max(1, Math.ceil((status.nextRetryAt - Date.now()) / 60_000)) : 0;
      const done = status.segmentsDone ? `已下载并核对 ${size}，会接着下。` : "";
      const detail = minutes > 5
        ? `基础词库可正常使用，约 ${minutes} 分钟后自动重试（期间关掉再打开也会按时接着试，不用手动操作）。${done}${reason}`
        : `完整词库暂未下载完成，基础词库可正常使用，将自动重试。${done}${reason}`;
      return { chip: "完整词库 稍后重试", detail, attention: false };
    }
    case "paused":
      if (status.pausedReason === "baseOnly") {
        return {
          chip: null,
          detail: "已选择只用基础词库，不会自动下载。" + (status.segmentsDone === status.segmentsTotal ? "已下载的完整词库仍保留，恢复后无需重下。" : ""),
          attention: false
        };
      }
      return { chip: null, detail: `已暂停，可继续下载。${status.segmentsDone ? `已下载 ${size}，继续后接着下。` : ""}`, attention: false };
    case "error":
      if (status.error?.kind === "storage") {
        return { chip: "完整词库 空间不足", detail: `${status.error.message}。基础词库可正常使用，学习记录不受影响。`, attention: true };
      }
      return {
        chip: "完整词库 已停用",
        detail: `完整词库校验或启用反复失败，已停用这个版本，基础词库可正常使用。可以点「立即重试」重新检查。${reason}`,
        attention: true
      };
    default:
      return {
        chip: null,
        detail: status.segmentsDone
          ? `已下载 ${size}，稍后自动接着下载。`
          : `尚未下载完整词库（${approxSize(status.catalog)}）。基础词库就绪后会在后台自动下载。`,
        attention: false
      };
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
  render(description: DictDescription | null, anchor: DOMRect | null): void {
    const text = description?.chip;
    if (!text || !anchor || !anchor.width) {
      this.el.removeClass("is-visible");
      return;
    }
    this.el.setText(text);
    this.el.toggleClass("is-attention", Boolean(description?.attention));
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
    this.setTitle("完整词库");
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
