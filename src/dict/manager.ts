/**
 * 完整词库的下载、校验、恢复与启用记录。
 *
 * 原则（对应《下一阶段开发与验证计划》6.x）：
 * - 基础词库随插件提供，永远先可用；完整词库只在后台取得，失败不影响输入。
 * - 只信任插件内置的 catalog.json：每一段、每个文件都和它的 sha256 对上才算数。
 * - 进度从已保存并核对过的分段重新计算，不信任任何写下来的百分比或「已安装」标记。
 * - 同一时间只有一个有效任务；暂停、卸载或换任务后，迟到的请求一律作废。
 * - 失败按类别处理：普通网络问题有限重试并持久冷却；空间不足、包不兼容、启用反复失败不盲目重下。
 * - 不碰用户词典（它在另一个 IndexedDB 库里）。
 */
import catalogJson from "./catalog.json";
import { DictStore } from "./store";
import { extractTgz, TarError } from "./tar";

export interface DictCatalog {
  id: string;
  name: string;
  version: string;
  label: string;
  source: string;
  license: string;
  tarball: { filename: string; bytes: number; sha256: string; integrity: string; segmentBytes: number; segments: string[] };
  urls: string[];
  files: { name: string; bytes: number; sha256: string }[];
}

/** 开发测试用：构建时设了 JT_DICT_URLS 才有值，把下载地址换成本机测试服务器。正式构建里是 null。 */
declare const JT_DEV_DICT_URLS: string[] | null;
const DEV_URLS = typeof JT_DEV_DICT_URLS !== "undefined" ? JT_DEV_DICT_URLS : null;

const BUILT_IN: DictCatalog = catalogJson;
export const CATALOG: DictCatalog = DEV_URLS ? { ...BUILT_IN, urls: DEV_URLS } : BUILT_IN;
export const USING_DEV_URLS = Boolean(DEV_URLS);

export type ErrorKind =
  | "offline"      // 明确离线
  | "network"      // 连接失败、中断
  | "timeout"      // 超时
  | "server"       // 5xx
  | "ratelimit"    // 429
  | "missing"      // 404/403/410：文件不在或镜像还没同步
  | "integrity"    // 长度、哈希不符
  | "format"       // 解压、归档格式、与清单不符
  | "storage"      // 存不下
  | "activation";  // 启用时引擎起不来

export type Phase = "none" | "downloading" | "verifying" | "ready" | "active" | "waiting" | "paused" | "error";

export interface DictStatus {
  phase: Phase;
  catalog: DictCatalog;
  segmentsDone: number;
  segmentsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** 下一次自动重试的时刻（等待重试时）。 */
  nextRetryAt?: number;
  error?: { kind: ErrorKind; message: string };
  pausedReason?: "paused" | "baseOnly";
  /** 当前实际在用的完整词库 id（由插件在启用成功后告知）。 */
  activeId?: string;
  /** 启动时已有部分分段，本次是接着下而不是从头下。 */
  resuming: boolean;
  /** 另一个 Obsidian 窗口正在下载，这里等它下完直接用。 */
  elsewhere: boolean;
  /** 最近的下载事件（跨重启保留），供诊断报告。 */
  history: string[];
}

export interface RangeResponse {
  status: number;
  body: ArrayBuffer;
  headers: Record<string, string>;
}
/** 取 [start, end] 这段字节（含两端）。插件里用 Obsidian 的 requestUrl，测试里用 fetch。 */
export type RangeFetcher = (url: string, start: number, end: number) => Promise<RangeResponse>;

export interface DictConfig {
  /** 一轮里失败后的等待：约 30 秒、2 分钟。数组长度＝一轮里最多几次自动恢复。 */
  retryDelaysMs: number[];
  jitter: number;
  /** 一轮用完后的冷却。 */
  cooldownMs: number;
  requestTimeoutMs: number;
  /** 超过这么久没更新的任务锁视为失效（进程被杀、窗口关闭）。 */
  lockStaleMs: number;
  heartbeatMs: number;
  /** 启用失败几次后隔离这个包。 */
  activationFailureLimit: number;
}

export const DEFAULT_CONFIG: DictConfig = {
  retryDelaysMs: [30_000, 120_000],
  jitter: 0.2,
  cooldownMs: 30 * 60_000,
  requestTimeoutMs: 90_000,
  lockStaleMs: 45_000,
  heartbeatMs: 10_000,
  activationFailureLimit: 2
};

interface PersistedState {
  v: 1;
  paused?: "paused" | "baseOnly";
  /** 当前这一轮已经失败的次数。持久保存：快速重开不能重置。 */
  attempts?: number;
  nextRetryAt?: number;
  lastError?: { kind: ErrorKind; message: string; at: number };
  quarantine?: Record<string, { reason: string; at: number }>;
  /** 启用进行中的标记；启动时还在，说明上次启用途中崩溃或被结束。 */
  activation?: { id: string; startedAt: number };
  /** 当前包连续启用失败的次数（跨重启累计，成功后清零）。 */
  activationFailures?: number;
  activeId?: string;
  /** 已经提示过的一次性通知。 */
  notified?: Record<string, boolean>;
  /** 最近的下载事件，跨重启保留：测试时不用每次退出前都存报告。只有状态和错误类别，没有输入内容。 */
  history?: string[];
}

const HISTORY_LIMIT = 60;
/** 浏览器自带的锁：持有它的页面或进程一结束就自动释放。 */
const WEB_LOCK = "just-type-dict-task";

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface LockRecord { owner: string; at: number }

class FetchFailure extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isStorageError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || /quota|space|storage/i.test(String((error as Error)?.message ?? ""));
}

export class DictManager {
  private state: PersistedState = { v: 1 };
  private present = new Set<number>();
  private phase: Phase = "none";
  private resuming = false;
  private generation = 0;
  private running = false;
  private timer?: number;
  private heartbeat?: number;
  private sourceIndex = 0;
  private listeners = new Set<(status: DictStatus) => void>();
  private readonly owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private disposed = false;
  /** 任务运行中又收到了手动请求（继续、立即重试）：当前任务一结束就再调度一次。 */
  private rerun = false;
  /** 正在退避等待的任务：取消时立刻叫醒，不用等满两分钟。 */
  private wake?: () => void;
  /** 当前处在一轮之内的退避等待（不是 30 分钟冷却）：联网、回到前台时可以提前再试。 */
  private backingOff = false;
  /** 另一个窗口拿着任务锁。 */
  private elsewhere = false;
  /** 用 Web Locks 拿到的锁：调用即释放。 */
  private releaseWebLock?: () => void;

  constructor(
    private store: DictStore,
    private fetcher: RangeFetcher,
    readonly catalog: DictCatalog = CATALOG,
    private config: DictConfig = DEFAULT_CONFIG,
    private log: (message: string) => void = () => undefined,
    private now: () => number = () => Date.now()
  ) {}

  /* ---------------- 状态 ---------------- */

  /** 记一条下载事件：写进插件的诊断日志，也存进跨重启保留的最近事件。 */
  record(message: string): void {
    this.log(message);
    this.state.history = [...(this.state.history ?? []), `${stamp(this.now())} ${message}`].slice(-HISTORY_LIMIT);
    void this.save();
  }

  async init(): Promise<void> {
    try {
      const saved = await this.store.getMeta<PersistedState>("state");
      this.state = saved && saved.v === 1 ? saved : { v: 1 };
    } catch (error) {
      // 状态损坏只重建任务状态；分段和用户词典都不动。
      this.log(`词库状态读取失败，重建：${String(error)}`);
      this.state = { v: 1 };
    }
    // 上次启用途中退出：记一次失败，达到上限就隔离，避免每次开软件都重复同样的崩溃。
    const act = this.state.activation;
    if (act) {
      this.state.activation = undefined;
      this.record(`检测到上次启用 ${act.id} 未完成，记为一次失败`);
      if (act.id === this.catalog.id) this.recordActivationFailure("上次启用途中退出");
    }
    this.present = await this.store.segmentIndexes(this.catalog.id);
    this.resuming = this.present.size > 0 && this.present.size < this.catalog.tarball.segments.length;
    this.phase = this.derivePhase();
    this.record(`启动：阶段 ${this.phase}，已有 ${this.present.size}/${this.catalog.tarball.segments.length} 段${this.state.nextRetryAt ? `，下次重试 ${stamp(this.state.nextRetryAt)}` : ""}`);
    await this.save();
    this.emit();
  }

  private derivePhase(): Phase {
    if (this.state.paused) return "paused";
    if (this.isQuarantined()) return "error";
    if (this.state.activeId === this.catalog.id && this.isComplete()) return "active";
    if (this.isComplete()) return "ready";
    if (this.state.lastError?.kind === "storage") return "error";
    if (this.state.nextRetryAt && this.state.nextRetryAt > this.now()) return "waiting";
    return "none";
  }

  isComplete(): boolean {
    return this.present.size === this.catalog.tarball.segments.length;
  }

  isQuarantined(): boolean {
    return Boolean(this.state.quarantine?.[this.catalog.id]);
  }

  status(): DictStatus {
    const seg = this.catalog.tarball.segmentBytes;
    const total = this.catalog.tarball.bytes;
    let done = 0;
    for (const i of this.present) done += Math.min(seg, total - i * seg);
    const err = this.state.lastError;
    return {
      phase: this.phase,
      catalog: this.catalog,
      segmentsDone: this.present.size,
      segmentsTotal: this.catalog.tarball.segments.length,
      bytesDone: done,
      bytesTotal: total,
      nextRetryAt: this.phase === "waiting" ? this.state.nextRetryAt : undefined,
      error: err && (this.phase === "waiting" || this.phase === "error") ? { kind: err.kind, message: err.message } : undefined,
      pausedReason: this.state.paused,
      activeId: this.state.activeId,
      resuming: this.resuming,
      elsewhere: this.elsewhere,
      history: this.state.history ?? []
    };
  }

  onChange(listener: (status: DictStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try { listener(status); } catch { /* 界面出错不影响任务 */ }
    }
  }

  private async save(): Promise<void> {
    try {
      await this.store.setMeta("state", this.state);
    } catch (error) {
      this.log(`词库状态保存失败：${String(error)}`);
    }
  }

  /** 一次性提示：返回 true 表示之前没提示过（并记下已提示）。 */
  async claimNotice(key: string): Promise<boolean> {
    const k = `${this.catalog.id}:${key}`;
    if (this.state.notified?.[k]) return false;
    this.state.notified = { ...(this.state.notified ?? {}), [k]: true };
    await this.save();
    return true;
  }

  /* ---------------- 用户意图 ---------------- */

  async pause(): Promise<void> {
    this.state.paused = "paused";
    this.cancel();
    this.phase = "paused";
    await this.save();
    this.emit();
  }

  /** 只用基础词库：保留已下载的数据，不自动下载，直到用户恢复。 */
  async setBaseOnly(on: boolean): Promise<void> {
    this.state.paused = on ? "baseOnly" : undefined;
    if (on) {
      this.cancel();
      this.state.activeId = undefined;
    }
    this.phase = this.derivePhase();
    await this.save();
    this.emit();
    if (!on) this.schedule("manual");
  }

  async resume(): Promise<void> {
    if (this.state.paused !== "paused") return;
    this.state.paused = undefined;
    this.phase = this.derivePhase();
    await this.save();
    this.emit();
    this.schedule("manual");
  }

  /** 立即重试：开始新的一轮（仍是单任务、有限预算），隔离的包也重新检查一次。 */
  async retryNow(): Promise<void> {
    this.state.attempts = 0;
    this.state.nextRetryAt = undefined;
    this.state.lastError = undefined;
    if (this.state.quarantine?.[this.catalog.id]) {
      const rest = { ...this.state.quarantine };
      delete rest[this.catalog.id];
      this.state.quarantine = rest;
    }
    this.state.activationFailures = 0;
    if (this.state.paused === "paused") this.state.paused = undefined;
    this.phase = this.derivePhase();
    await this.save();
    this.emit();
    this.schedule("manual");
  }

  /** 删除已下载的完整词库数据（不影响学习记录）。之后保持「只用基础词库」，不会下一秒又自动下载。 */
  async removeDownloaded(): Promise<void> {
    this.cancel();
    await this.store.pruneSegments();
    this.present.clear();
    this.state.activeId = undefined;
    this.state.paused = "baseOnly";
    this.phase = "paused";
    await this.save();
    this.emit();
  }

  /* ---------------- 调度 ---------------- */

  /**
   * 统一入口：启动、回到前台、网络恢复、定时器、手动重试都只调这一个。
   * 已有任务在跑就什么都不做；冷却没到就只安排定时器。
   */
  schedule(reason: "startup" | "foreground" | "online" | "timer" | "manual"): void {
    if (this.disposed) return;
    if (this.running) {
      if (reason === "manual") { this.rerun = true; this.cancel(); }
      // 一轮之内的退避等待中联网了、回到前台了：提前结束等待马上再试（仍算这一轮的次数，30 分钟冷却不受影响）。
      else if ((reason === "online" || reason === "foreground") && this.backingOff) this.wake?.();
      return;
    }
    if (this.state.paused) return;
    if (this.isComplete()) return;
    if (this.isQuarantined() && reason !== "manual") return;
    if (this.state.lastError?.kind === "storage" && reason !== "manual") return;
    const wait = (this.state.nextRetryAt ?? 0) - this.now();
    if (wait > 0 && reason !== "manual") {
      this.armTimer(wait);
      if (this.phase !== "waiting") { this.phase = "waiting"; this.emit(); }
      return;
    }
    void this.run(reason);
  }

  private armTimer(ms: number): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; this.schedule("timer"); }, Math.max(0, ms));
  }

  private cancel(): void {
    this.generation += 1;
    if (this.timer !== undefined) { window.clearTimeout(this.timer); this.timer = undefined; }
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer = 0;
      const done = (): void => {
        window.clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      timer = window.setTimeout(done, ms);
      this.wake = done;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.stopHeartbeat();
    void this.releaseLock();
    this.listeners.clear();
  }

  /* ---------------- 任务锁 ---------------- */

  /**
   * 同一台设备同一时间只有一个下载任务。优先用 Web Locks：持有者（窗口、进程）一结束锁就自动释放，
   * iPad 上划掉 Obsidian 再打开能立刻接着下。没有这个接口时退回 IndexedDB 租约＋心跳，过期后接管。
   */
  private async acquireLock(): Promise<boolean> {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks && typeof locks.request === "function") {
      const release = await new Promise<(() => void) | null>((resolve) => {
        locks.request(WEB_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return undefined;
          }
          return new Promise<void>((done) => resolve(done));
        }).catch(() => resolve(null));
      });
      if (!release) return false;
      this.releaseWebLock = release;
      return true;
    }
    const now = this.now();
    const lock = await this.store.updateMeta<LockRecord | undefined>("lock", (old) => {
      if (!old || old.owner === this.owner || now - old.at > this.config.lockStaleMs) return { owner: this.owner, at: now };
      return old;
    });
    return lock?.owner === this.owner;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.releaseWebLock) return; // Web Locks 不需要心跳
    this.heartbeat = window.setInterval(() => {
      void this.store.updateMeta<LockRecord | undefined>("lock", (old) => (old?.owner === this.owner ? { owner: this.owner, at: this.now() } : old)).catch(() => undefined);
    }, this.config.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) { window.clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }

  private async releaseLock(): Promise<void> {
    if (this.releaseWebLock) {
      this.releaseWebLock();
      this.releaseWebLock = undefined;
      return;
    }
    try {
      await this.store.updateMeta<LockRecord | undefined>("lock", (old) => (old?.owner === this.owner ? undefined : old));
    } catch { /* 锁会自己过期 */ }
  }

  /* ---------------- 下载 ---------------- */

  private async run(reason: string): Promise<void> {
    const gen = ++this.generation;
    this.running = true;
    try {
      if (!(await this.acquireLock())) {
        if (!this.elsewhere) this.record("另一个 Obsidian 窗口正在下载完整词库，这里不重复下载");
        this.elsewhere = true;
        this.emit();
        this.armTimer(this.config.lockStaleMs);
        return;
      }
      if (this.elsewhere) { this.elsewhere = false; this.emit(); }
      this.startHeartbeat();
      this.present = await this.store.segmentIndexes(this.catalog.id);
      this.record(`完整词库任务开始（${reason}），已有 ${this.present.size}/${this.catalog.tarball.segments.length} 段`);

      while (gen === this.generation) {
        const missing = this.catalog.tarball.segments.map((_, i) => i).filter((i) => !this.present.has(i));
        if (missing.length) {
          // 离线信号只当提示：定时器到点时照样试一次，免得永远卡在误判的离线里。
          if (!navigator.onLine && reason !== "timer") {
            if (this.state.lastError?.kind !== "offline") this.record("设备离线，等联网后自动继续（不计入重试次数）");
            this.setWaiting({ kind: "offline", message: "设备离线，联网后自动继续" }, undefined);
            this.armTimer(5 * 60_000);
            return;
          }
          this.phase = "downloading";
          this.emit();
          try {
            await this.fetchSegment(missing[0], gen);
          } catch (error) {
            if (gen !== this.generation) return;
            if (!(await this.handleFailure(error, gen))) return;
          }
          continue;
        }

        // 全部分段到齐：整体解包并逐个核对文件。
        this.phase = "verifying";
        this.emit();
        const result = await this.verifyInstalled();
        if (gen !== this.generation) return;
        if (result === "ok") {
          this.state.attempts = 0;
          this.state.nextRetryAt = undefined;
          this.state.lastError = undefined;
          this.phase = "ready";
          await this.save();
          this.record("完整词库下载并校验完成，等待启用");
          this.emit();
          return;
        }
        if (result === "quarantined") return;
        // 有坏段被丢弃：计一次失败，按同样的退避补下这些段。
        if (!(await this.handleFailure(new FetchFailure("integrity", "下载的数据校验不符，重新下载损坏的部分"), gen))) return;
      }
    } finally {
      this.running = false;
      this.stopHeartbeat();
      await this.releaseLock();
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        this.schedule("manual");
      }
    }
  }

  private segmentRange(index: number): [number, number] {
    const seg = this.catalog.tarball.segmentBytes;
    const start = index * seg;
    return [start, Math.min(start + seg, this.catalog.tarball.bytes) - 1];
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new FetchFailure("timeout", "下载超时")), this.config.requestTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async fetchSegment(index: number, gen: number): Promise<void> {
    const url = this.catalog.urls[this.sourceIndex % this.catalog.urls.length];
    const [start, end] = this.segmentRange(index);
    let res: RangeResponse;
    try {
      res = await this.withTimeout(this.fetcher(url, start, end));
    } catch (error) {
      if (error instanceof FetchFailure) throw error;
      throw new FetchFailure("network", `连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (gen !== this.generation) return; // 迟到的响应：任务已被取消或换代

    const { status } = res;
    if (status === 429) {
      const retryAfter = Number(res.headers["retry-after"] ?? res.headers["Retry-After"]);
      throw new FetchFailure("ratelimit", "服务器限流", Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 6 * 3600) * 1000 : undefined);
    }
    if (status === 404 || status === 403 || status === 410) throw new FetchFailure("missing", `文件不在这个地址（HTTP ${status}），可能镜像还没同步`);
    if (status >= 500) throw new FetchFailure("server", `服务器错误（HTTP ${status}）`);

    if (status === 200 && res.body.byteLength === this.catalog.tarball.bytes) {
      // 服务器不支持分段、直接给了整包：按段切开，逐段核对后全部保存。
      for (let i = 0; i < this.catalog.tarball.segments.length; i++) {
        if (gen !== this.generation) return;
        const [s, e] = this.segmentRange(i);
        await this.storeVerified(i, res.body.slice(s, e + 1));
      }
      return;
    }
    if (status !== 206 && status !== 200) throw new FetchFailure("server", `意外的响应（HTTP ${status}）`);
    const expected = end - start + 1;
    if (res.body.byteLength !== expected) {
      const type = res.headers["content-type"] ?? res.headers["Content-Type"] ?? "";
      throw new FetchFailure("integrity", `长度不符：收到 ${res.body.byteLength} 字节，应为 ${expected}${/html/i.test(type) ? "（服务器返回了网页，不是词库数据）" : ""}`);
    }
    await this.storeVerified(index, res.body);
  }

  private async storeVerified(index: number, body: ArrayBuffer): Promise<void> {
    const hash = await sha256Hex(body);
    if (hash !== this.catalog.tarball.segments[index]) throw new FetchFailure("integrity", `第 ${index + 1} 段校验不符`);
    try {
      await this.store.putSegment(this.catalog.id, index, body);
    } catch (error) {
      throw new FetchFailure(isStorageError(error) ? "storage" : "network", `保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.present.add(index);
    this.emit();
  }

  /** 返回 true 表示本轮还能继续（已按退避等待过）；false 表示本轮结束。 */
  private async handleFailure(error: unknown, gen: number): Promise<boolean> {
    const failure = error instanceof FetchFailure ? error : new FetchFailure("network", String(error));
    this.record(`下载失败：${failure.kind} ${failure.message}（navigator.onLine=${String(navigator.onLine)}）`);

    // 请求失败时设备已离线：这是网络没了，不是下载源的问题，不消耗重试次数，等联网（或 5 分钟后）再试。
    if ((failure.kind === "network" || failure.kind === "timeout") && !navigator.onLine) {
      this.setWaiting({ kind: "offline", message: "设备离线，联网后自动继续" }, undefined);
      this.armTimer(5 * 60_000);
      return false;
    }

    if (failure.kind === "storage") {
      this.state.lastError = { kind: "storage", message: "存储空间不足或无法写入，释放空间后在设置里点「立即重试」", at: this.now() };
      this.phase = "error";
      await this.save();
      this.emit();
      return false;
    }

    const attempts = (this.state.attempts ?? 0) + 1;
    this.state.attempts = attempts;
    // 换到下一个下载地址也算一次恢复尝试，不另外叠加重试次数。
    if (["missing", "integrity", "server", "network", "timeout"].includes(failure.kind) && this.catalog.urls.length > 1) {
      this.sourceIndex = (this.sourceIndex + 1) % this.catalog.urls.length;
    }

    if (attempts > this.config.retryDelaysMs.length) {
      // 一轮用完：持久冷却，下次打开或回到前台时到期才开新一轮。
      const cooldown = Math.max(this.config.cooldownMs, failure.retryAfterMs ?? 0);
      this.state.attempts = 0;
      this.record(`这一轮重试用完，冷却到 ${stamp(this.now() + cooldown)}`);
      this.setWaiting({ kind: failure.kind, message: failure.message }, this.now() + cooldown);
      return false;
    }

    const base = this.config.retryDelaysMs[attempts - 1];
    const jittered = base * (1 + (Math.random() * 2 - 1) * this.config.jitter);
    const delay = Math.max(jittered, failure.retryAfterMs ?? 0);
    this.setWaiting({ kind: failure.kind, message: failure.message }, this.now() + delay);
    this.backingOff = true;
    try {
      await this.sleep(delay);
    } finally {
      this.backingOff = false;
    }
    return gen === this.generation;
  }

  private setWaiting(error: { kind: ErrorKind; message: string }, nextRetryAt: number | undefined): void {
    this.state.lastError = { ...error, at: this.now() };
    this.state.nextRetryAt = nextRetryAt;
    this.phase = "waiting";
    void this.save();
    if (nextRetryAt !== undefined && this.state.attempts === 0) this.armTimer(nextRetryAt - this.now());
    this.emit();
  }

  /* ---------------- 校验与取出 ---------------- */

  /**
   * 把已下载的分段拼回 tgz，解包，逐个核对文件 sha256。成功返回文件内容。
   * 失败时找出坏掉的分段删掉（下次只补这些），整包格式不对则隔离，不无限重下。
   */
  async extractInstalled(): Promise<Map<string, Uint8Array> | null> {
    const buffers: ArrayBuffer[] = [];
    const bad: number[] = [];
    for (let i = 0; i < this.catalog.tarball.segments.length; i++) {
      const data = await this.store.getSegment(this.catalog.id, i);
      if (!data || (await sha256Hex(data)) !== this.catalog.tarball.segments[i]) { bad.push(i); continue; }
      buffers.push(data);
    }
    if (bad.length) {
      for (const i of bad) { await this.store.deleteSegment(this.catalog.id, i); this.present.delete(i); }
      this.state.activeId = undefined;
      this.record(`完整词库有 ${bad.length} 段缺失或损坏，已丢弃，稍后自动补下`);
      this.phase = this.derivePhase();
      await this.save();
      this.emit();
      return null;
    }
    try {
      const files = await extractTgz(new Blob(buffers).stream(), this.catalog.files);
      for (const f of this.catalog.files) {
        const body = files.get(f.name)!;
        if ((await sha256Hex(body)) !== f.sha256) throw new TarError(`${f.name} 校验不符`);
      }
      return files;
    } catch (error) {
      // 分段都对、整包却解不开：说明包本身和插件不兼容，隔离，等新版插件或用户手动复查。
      this.quarantine(`格式或内容与清单不符：${error instanceof Error ? error.message : String(error)}`, "format");
      await this.save();
      this.emit();
      return null;
    }
  }

  private async verifyInstalled(): Promise<"ok" | "repair" | "quarantined"> {
    const files = await this.extractInstalled();
    if (files) return "ok";
    return this.isQuarantined() ? "quarantined" : "repair";
  }

  private quarantine(reason: string, kind: ErrorKind): void {
    this.state.quarantine = { ...(this.state.quarantine ?? {}), [this.catalog.id]: { reason, at: this.now() } };
    this.state.lastError = { kind, message: reason, at: this.now() };
    this.state.activeId = undefined;
    this.phase = "error";
    this.record(`完整词库 ${this.catalog.id} 已隔离：${reason}`);
  }

  /* ---------------- 启用记录 ---------------- */

  /** 插件开始用完整词库初始化引擎之前调用：留下标记，启动途中崩溃下次就能识别。 */
  async beginActivation(): Promise<void> {
    this.state.activation = { id: this.catalog.id, startedAt: this.now() };
    await this.save();
  }

  async endActivation(ok: boolean, message = ""): Promise<void> {
    this.state.activation = undefined;
    if (ok) {
      this.state.activeId = this.catalog.id;
      this.state.activationFailures = 0;
      this.state.lastError = undefined;
      this.phase = "active";
      // 新包启用成功后才清理旧版本的分段，保证任何时候都至少有一个可恢复的状态。
      void this.store.pruneSegments(this.catalog.id).catch(() => undefined);
    } else {
      this.recordActivationFailure(message || "引擎加载失败");
    }
    await this.save();
    this.emit();
  }

  /** 连续失败达到上限就隔离这个包：不在每次开软件时重复同样的失败，手动「立即重试」可以解除。 */
  private recordActivationFailure(reason: string): void {
    const failures = (this.state.activationFailures ?? 0) + 1;
    this.state.activationFailures = failures;
    this.state.activeId = undefined;
    if (failures >= this.config.activationFailureLimit) {
      this.quarantine(`启用失败 ${failures} 次：${reason}`, "activation");
    } else {
      this.state.lastError = { kind: "activation", message: reason, at: this.now() };
      this.phase = this.derivePhase();
    }
  }

  /** 这台设备上完整词库是否可以直接启用（已下载齐、未隔离、未选择只用基础词库）。 */
  canActivate(): boolean {
    return this.isComplete() && !this.isQuarantined() && !this.state.paused;
  }
}
