/**
 * 完整词库的本机存储：IndexedDB「just-type-dict」。
 *
 * - segments：已下载并逐段核对过 sha256 的分段，键为「清单 id#序号」
 * - meta：任务状态（目标版本、暂停意图、重试时间、错误、隔离、启用标记等）
 * - backups：第一次启用完整词库前的用户词典备份
 *
 * 与用户词典（Worker 挂载的 IndexedDB「/rime」）完全分开：这里的任何清理都碰不到学习记录。
 * 存在设备本地，不随 Obsidian Sync 同步，每台设备各下各的。
 */

const DB_NAME = "just-type-dict";
const DB_VERSION = 1;
const SEGMENTS = "segments";
const META = "meta";
const BACKUPS = "backups";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 请求失败"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
  });
}

export class DictStore {
  private dbPromise?: Promise<IDBDatabase>;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const name of [SEGMENTS, META, BACKUPS]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      };
      open.onsuccess = () => {
        const db = open.result;
        // 别的窗口要升级或删除这个库时主动让开，否则对方会一直卡住；下次用到时重新打开。
        db.onversionchange = () => { db.close(); this.dbPromise = undefined; };
        resolve(db);
      };
      open.onerror = () => reject(open.error ?? new Error("打不开词库存储"));
      // 其他窗口占着旧版本数据库时会一直卡住，给出可诊断的错误，由调度器按普通失败重试。
      open.onblocked = () => reject(new Error("词库存储被另一个 Obsidian 窗口占用，稍后重试"));
    });
    this.dbPromise.catch(() => { this.dbPromise = undefined; });
    return this.dbPromise;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    return await request(db.transaction(META, "readonly").objectStore(META).get(key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put(value, key);
    await transactionDone(tx);
  }

  /** 在同一个事务里读改写，给任务锁用：两个 Obsidian 窗口同时抢锁时不会互相覆盖。 */
  async updateMeta<T>(key: string, update: (old: T | undefined) => T): Promise<T> {
    const db = await this.db();
    const tx = db.transaction(META, "readwrite");
    const store = tx.objectStore(META);
    let next: T | undefined;
    // 必须在 get 的回调里同步 put：await 之后 Safari 可能已经提交了事务，读改写就不再原子。
    const get = store.get(key);
    get.onsuccess = () => {
      next = update(get.result as T | undefined);
      store.put(next, key);
    };
    await transactionDone(tx);
    return next as T;
  }

  /** 已保存的分段序号。 */
  async segmentIndexes(catalogId: string): Promise<Set<number>> {
    const db = await this.db();
    const range = IDBKeyRange.bound(`${catalogId}#`, `${catalogId}#￿`);
    const keys = await request(db.transaction(SEGMENTS, "readonly").objectStore(SEGMENTS).getAllKeys(range));
    const out = new Set<number>();
    for (const key of keys) {
      if (typeof key !== "string") continue;
      const index = Number(key.slice(catalogId.length + 1));
      if (Number.isInteger(index)) out.add(index);
    }
    return out;
  }

  async getSegment(catalogId: string, index: number): Promise<ArrayBuffer | undefined> {
    const db = await this.db();
    return await request(db.transaction(SEGMENTS, "readonly").objectStore(SEGMENTS).get(`${catalogId}#${index}`)) as ArrayBuffer | undefined;
  }

  /** 每存好一段就是一个检查点，不把状态推迟到退出时才写。 */
  async putSegment(catalogId: string, index: number, data: ArrayBuffer): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(SEGMENTS, "readwrite");
    tx.objectStore(SEGMENTS).put(data, `${catalogId}#${index}`);
    await transactionDone(tx);
  }

  async deleteSegment(catalogId: string, index: number): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(SEGMENTS, "readwrite");
    tx.objectStore(SEGMENTS).delete(`${catalogId}#${index}`);
    await transactionDone(tx);
  }

  /** 删掉不属于 keepId 的分段（旧版本或放弃的包）。学习记录不在这里，不受影响。 */
  async pruneSegments(keepId?: string): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(SEGMENTS, "readwrite");
    const store = tx.objectStore(SEGMENTS);
    let removed = 0;
    const all = store.getAllKeys();
    all.onsuccess = () => {
      for (const key of all.result) {
        if (!keepId || typeof key !== "string" || !key.startsWith(`${keepId}#`)) { store.delete(key); removed++; }
      }
    };
    await transactionDone(tx);
    return removed;
  }

  async getBackup<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    return await request(db.transaction(BACKUPS, "readonly").objectStore(BACKUPS).get(key)) as T | undefined;
  }

  async putBackup(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(BACKUPS, "readwrite");
    tx.objectStore(BACKUPS).put(value, key);
    await transactionDone(tx);
  }

  close(): void {
    void this.dbPromise?.then((db) => db.close()).catch(() => undefined);
    this.dbPromise = undefined;
  }
}
