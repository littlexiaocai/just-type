/**
 * 新版本提醒。
 *
 * Obsidian 自己也查插件更新，但至少隔 3 天、只在切回前台时查，查到也只弹 4 秒，很容易错过。
 * 这里补一个更勤的检查：每 24 小时最多联网一次，只读一个很小的版本信息（版本号＋一句要点），
 * 不发送任何本机数据。更新本身仍由用户在 Obsidian 插件页走官方流程完成——插件不下载、不安装自己。
 *
 * 地址按顺序尝试：npmmirror（国内稳定）→ jsDelivr → GitHub API。都失败就保留上次已知的结果，
 * 过一小时再试；失败绝不当作「已是最新」。
 *
 * 记录存在本机 localStorage（不随 Obsidian Sync 同步），所以每台设备各提醒各的。
 */
import { requestUrl, type App } from "obsidian";

export const PLUGIN_ID = "just-type";
export const PLUGIN_PAGE_URI = `obsidian://show-plugin?id=${PLUGIN_ID}`;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const STORE_KEY = "just-type-update";
const HEADLINE_MAX = 60;

export interface LatestInfo {
  version: string;
  headline: string;
  source: string;
}

interface UpdateState {
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  latest?: LatestInfo;
  /** 用户选了「不再提醒」的版本。 */
  ignoredVersion?: string;
  /** 这台设备上次实际运行的插件版本，用来判断「刚更新过」。 */
  lastRunVersion?: string;
}

type Source = { name: string; url: string; parse: (json: unknown) => { version?: unknown; headline?: unknown } };

/* 每个来源只取两样东西：版本号和一句要点。格式不对就当这个来源失败。 */
const SOURCES: Source[] = [
  {
    name: "npmmirror",
    url: "https://registry.npmmirror.com/just-type-ime/latest",
    parse: (json) => {
      const j = json as { version?: unknown; justType?: { headline?: unknown }; repository?: unknown };
      // 包名在 npm 上谁都能注册：只认声明了本仓库的包，否则当作这个来源失败，换下一个。
      const repo = typeof j.repository === "string" ? j.repository : (j.repository as { url?: unknown } | undefined)?.url;
      if (typeof repo !== "string" || !repo.includes("littlexiaocai/just-type")) throw new Error("仓库地址不符，不是本插件的包");
      return { version: j.version, headline: j.justType?.headline };
    }
  },
  {
    name: "jsDelivr",
    // 不带版本号时 jsDelivr 取最新的 tag，也就是最新 Release 里的文件，不会跑在 Release 前面。
    url: "https://cdn.jsdelivr.net/gh/littlexiaocai/just-type/update.json",
    parse: (json) => json as { version?: unknown; headline?: unknown }
  },
  {
    name: "GitHub",
    url: "https://api.github.com/repos/littlexiaocai/just-type/releases/latest",
    parse: (json) => {
      const j = json as { tag_name?: unknown; body?: unknown };
      return { version: j.tag_name, headline: typeof j.body === "string" ? firstBullet(j.body) : "" };
    }
  }
];

/* Release 说明的第一条要点。提醒里只放一句话：有加粗就取加粗部分，否则取冒号前面。 */
function firstBullet(markdown: string): string {
  const line = markdown.split("\n").find((l) => /^\s*[-*]\s+/.test(l));
  if (!line) return "";
  const text = line.replace(/^\s*[-*]\s+/, "");
  const bold = /\*\*(.+?)\*\*/.exec(text);
  return bold ? bold[1] : text.split(/[：:]/)[0];
}

/* 远端文字只当纯文本显示：去掉 Markdown 记号、截短。 */
function cleanHeadline(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return text.length > HEADLINE_MAX ? `${text.slice(0, HEADLINE_MAX - 1)}…` : text;
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+){1,3}$/.test(value);
}

/** 按数字逐段比较，忽略 "-bench.1" 这类后缀。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchJson(url: string): Promise<unknown> {
  const request = requestUrl({ url, method: "GET", throw: false, headers: { Accept: "application/json" } });
  const timer = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("超时")), REQUEST_TIMEOUT_MS));
  const response = await Promise.race([request, timer]);
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  return response.json as unknown;
}

export class UpdateChecker {
  private state: UpdateState;
  private checking?: Promise<boolean>;

  constructor(private app: App, private current: string, private log: (message: string) => void) {
    this.state = this.load();
  }

  /* ---------- 本机存储 ---------- */

  /* 直接用 localStorage，不用 app.loadLocalStorage（1.8.7 才有，插件声明兼容 1.5.0）。
     键名与 Obsidian 自己的 loadLocalStorage 相同（appId + "-" + 键），0.7.21 存下的记录照样读得到。
     localStorage 不随 Obsidian Sync 同步，所以每台设备各提醒各的。 */
  private storageKey(): string {
    const appId = (this.app as unknown as { appId?: unknown }).appId;
    return typeof appId === "string" && appId ? `${appId}-${STORE_KEY}` : `${STORE_KEY}:${this.app.vault.getName()}`;
  }

  private load(): UpdateState {
    try {
      const raw = window.localStorage.getItem(this.storageKey());
      if (!raw) return {};
      let value = JSON.parse(raw) as unknown;
      // 0.7.21 经 saveLocalStorage 存的是「JSON 字符串再套一层 JSON」，多解一次。
      if (typeof value === "string") value = JSON.parse(value) as unknown;
      return value !== null && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(this.storageKey(), JSON.stringify(this.state));
    } catch {
      // 存不下也不影响输入，下次启动再查一次而已。
    }
  }

  /* ---------- 刚更新过 ---------- */

  /** 记下本次运行的版本。返回「升级前的版本」；首次在这台设备运行、没升级或降级都返回 undefined。 */
  recordRun(): string | undefined {
    const previous = this.state.lastRunVersion;
    this.state.lastRunVersion = this.current;
    // 已经装上的版本不用再提醒。
    if (this.state.latest && compareVersions(this.state.latest.version, this.current) <= 0) this.state.latest = undefined;
    this.save();
    return previous && compareVersions(previous, this.current) < 0 ? previous : undefined;
  }

  /* ---------- 新版本 ---------- */

  /** 已知的、比当前版本新、且没被「不再提醒」的版本。 */
  newer(): LatestInfo | undefined {
    const latest = this.state.latest;
    if (!latest || compareVersions(latest.version, this.current) <= 0) return undefined;
    return latest;
  }

  /** 上次成功拿到版本信息的时间；从没成功过是 undefined。 */
  lastCheckedAt(): number | undefined {
    return this.state.lastSuccessAt;
  }

  isIgnored(version: string): boolean {
    return this.state.ignoredVersion === version;
  }

  ignore(version: string): void {
    this.state.ignoredVersion = version;
    this.save();
  }

  /** 距离上次成功检查超过 24 小时才联网；失败后一小时内不重试。force 用于「现在检查」。返回是否拿到了结果。 */
  async maybeCheck(force = false): Promise<boolean> {
    if (this.checking) return await this.checking;
    const now = Date.now();
    if (!force) {
      if (this.state.lastSuccessAt && now - this.state.lastSuccessAt < CHECK_INTERVAL_MS) return false;
      if (this.state.lastAttemptAt && now - this.state.lastAttemptAt < RETRY_INTERVAL_MS) return false;
    }
    if (!navigator.onLine) return false;
    this.checking = this.check().finally(() => { this.checking = undefined; });
    return await this.checking;
  }

  private async check(): Promise<boolean> {
    this.state.lastAttemptAt = Date.now();
    this.save();
    for (const source of SOURCES) {
      try {
        const info = source.parse(await fetchJson(source.url));
        if (!isVersion(info.version)) throw new Error("版本号格式不对");
        this.state.latest = { version: info.version, headline: cleanHeadline(info.headline), source: source.name };
        this.state.lastSuccessAt = Date.now();
        this.save();
        this.log(`新版本检查：${source.name} 返回 ${info.version}（当前 ${this.current}）`);
        return true;
      } catch (error) {
        this.log(`新版本检查：${source.name} 失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    // 全部失败：保留上次已知的结果，不当作「已是最新」。
    return false;
  }
}
