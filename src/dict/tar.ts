/**
 * 从 npm 的 tgz 里取出词库文件。
 *
 * npm 包是 gzip 压缩的 ustar 归档，文件都在 package/ 下。这里边解压边解析，只收清单里列出的文件，
 * 并在拿到每个文件时就检查大小。任何不在清单、也不在允许列表里的条目，路径越界、类型不对、
 * 超出预期大小，一律整包拒绝——不能让远端的包往插件里塞别的东西。
 */

export interface ExpectedFile {
  name: string;
  bytes: number;
}

/** npm 包自带、可以出现但不需要的文件。 */
const ALLOWED_EXTRA = new Set(["package.json", "README.md", "LICENSE"]);
/** 允许的额外文件总大小上限，防止借「允许的文件」塞进大数据。 */
const EXTRA_LIMIT = 256 * 1024;

export class TarError extends Error {}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new TarError(`归档头里的数字不合法：${text}`);
  return text ? Number.parseInt(text, 8) : 0;
}

/** 解压并解析 tgz 流，返回清单里每个文件的完整内容。 */
export async function extractTgz(stream: ReadableStream<Uint8Array>, expected: ExpectedFile[]): Promise<Map<string, Uint8Array>> {
  const want = new Map(expected.map((f) => [f.name, f.bytes]));
  const out = new Map<string, Uint8Array>();
  // DecompressionStream 的类型声明写的是 BufferSource，和 Uint8Array 流对不上；运行时就是字节流。
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const reader = stream.pipeThrough(gunzip).getReader();

  let pending = new Uint8Array(0);
  let done = false;
  // 从解压流里凑够 n 字节。
  const take = async (n: number): Promise<Uint8Array | null> => {
    while (pending.length < n && !done) {
      const { value, done: finished } = await reader.read();
      if (finished) { done = true; break; }
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      pending = merged;
    }
    if (pending.length < n) return null;
    const chunk = pending.subarray(0, n);
    pending = pending.subarray(n);
    return chunk;
  };

  let extraBytes = 0;
  try {
    for (;;) {
      const header = await take(512);
      if (!header) throw new TarError("归档不完整：缺少结尾标记");
      if (header.every((b) => b === 0)) break; // 归档结束
      const name = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      const path = prefix ? `${prefix}/${name}` : name;
      const size = readOctal(header, 124, 12);
      const type = String.fromCharCode(header[156] || 48); // '0' 或 NUL＝普通文件

      if (!path.startsWith("package/") || path.includes("..") || path.includes("\\")) {
        throw new TarError(`归档里有越界路径：${path}`);
      }
      const rel = path.slice("package/".length);
      const padded = Math.ceil(size / 512) * 512;

      if (type === "5") continue; // 目录，没有内容
      if (type !== "0") throw new TarError(`归档里有不支持的条目类型 ${type}：${path}`);

      const expectedSize = want.get(rel);
      if (expectedSize !== undefined) {
        if (size !== expectedSize) throw new TarError(`${rel} 大小 ${size} 与清单 ${expectedSize} 不符`);
        // 大文件预先分配好整块内存，按块拷入，避免反复拼接产生多份大缓冲。
        const body = new Uint8Array(size);
        let filled = 0;
        while (filled < size) {
          const chunk = await take(Math.min(size - filled, 1024 * 1024));
          if (!chunk) throw new TarError(`${rel} 内容不完整`);
          body.set(chunk, filled);
          filled += chunk.length;
        }
        if (padded > size && !(await take(padded - size))) throw new TarError(`${rel} 填充不完整`);
        out.set(rel, body);
      } else if (ALLOWED_EXTRA.has(rel)) {
        extraBytes += size;
        if (extraBytes > EXTRA_LIMIT) throw new TarError("归档里的附带文件过大");
        if (!(await take(padded))) throw new TarError(`${rel} 内容不完整`);
      } else {
        throw new TarError(`归档里有清单以外的文件：${rel}`);
      }
    }
  } finally {
    reader.releaseLock();
  }

  for (const f of expected) {
    if (!out.has(f.name)) throw new TarError(`归档里缺少 ${f.name}`);
  }
  return out;
}
