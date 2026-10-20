/**
 * 内嵌的 RIME 引擎与词库。
 *
 * 引擎和基础词库不在运行时下载（完整词库另见 src/dict/）。引擎、引擎数据和方案文件在构建期由 scripts/fetch-assets.mjs
 * 抓到 src/assets/，再由 esbuild 一并打进 main.js：二进制走 binary loader，
 * rime.js 走 text loader 保持原文可读。
 *
 * 二进制在构建期 gzip，运行时用浏览器内置的 DecompressionStream 解开——只为压体积，
 * 不做任何加密或混淆。
 *
 * 不内嵌 stroke：产品只用拼音。笔画反查会经 stroke 拖进 luna_pinyin，体积翻倍。
 */
import rimeScript from "./assets/rime.js.txt";
import rimeWasmGz from "./assets/rime.wasm.gz";
import rimeDataGz from "./assets/rime.data.gz";
import pinyinSchemaGz from "./assets/pinyin_simp.schema.yaml.gz";
import pinyinPrismGz from "./assets/pinyin_simp.prism.bin.gz";
import pinyinTableGz from "./assets/pinyin_simp.table.bin.gz";
import pinyinReverseGz from "./assets/pinyin_simp.reverse.bin.gz";
import assetManifest from "./assets/ASSETS.json";

/** 键是文件名。Worker 请求资源时按 URL 的最后一段来找。 */
const COMPRESSED: Record<string, Uint8Array> = {
  "rime.wasm": rimeWasmGz,
  "rime.data": rimeDataGz,
  "pinyin_simp.schema.yaml": pinyinSchemaGz,
  "pinyin_simp.prism.bin": pinyinPrismGz,
  "pinyin_simp.table.bin": pinyinTableGz,
  "pinyin_simp.reverse.bin": pinyinReverseGz
};

export const RIME_SCRIPT = rimeScript;

export interface LocalAssets {
  script: string;
  binaries: Record<string, ArrayBuffer>;
}

async function gunzip(data: Uint8Array): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前环境不支持 gzip 解压（需要 Safari 16.4+ / 对应版本的 Obsidian）。");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

/** 内置基础词库的三个文件；用完整词库时由下载的同名文件替换。 */
export const DICT_FILES = new Set(["pinyin_simp.table.bin", "pinyin_simp.prism.bin", "pinyin_simp.reverse.bin"]);

/*
 * 中文模式下的标点，对齐微信输入法（Mac 版 2026-10 实测）：按下直接出，不弹候选菜单。
 * 上游方案里不少键是候选菜单（比如 | 有 8 个），或者出的是半角符号（` ~ 等），这里改掉。
 * 只改 half_shape（默认是半角状态）；/ 和 \ 保留「、」打头的菜单，由插件立即确认（见 main.ts confirmComma）。
 * 引号 " ' 保留成对交替。
 */
export const PUNCT_COMMITS: Record<string, string> = {
  "`": "·", "~": "～", "@": "@", "#": "#", "$": "￥", "%": "%", "&": "&", "*": "*",
  "(": "（", ")": "）", "_": "——", "-": "-", "+": "+", "=": "=",
  "[": "【", "]": "】", "{": "「", "}": "」", "|": "｜", "<": "《", ">": "》"
};

/** yaml 里键的写法：. 和 _ 不加引号，其余加引号（反斜杠、双引号要转义）。 */
function yamlKey(key: string): string {
  if (key === "_" || key === ".") return key;
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 返回改好的方案和实际改到的键数；某个键没找到就保留原样，绝不因此让引擎起不来。 */
export function patchPunctuation(yaml: string): { yaml: string; patched: number } {
  const start = yaml.indexOf("\n  half_shape:\n");
  if (start < 0) return { yaml, patched: 0 };
  const rest = yaml.slice(start + 1);
  const endRel = rest.search(/\n {2}[a-z_]+:/);
  const end = endRel < 0 ? yaml.length : start + 1 + endRel;
  let block = yaml.slice(start, end);
  let patched = 0;
  for (const [key, out] of Object.entries(PUNCT_COMMITS)) {
    const prefix = `\n    ${yamlKey(key)}: `;
    const at = block.indexOf(prefix);
    if (at < 0) continue;
    const lineEnd = block.indexOf("\n", at + 1);
    block = `${block.slice(0, at)}${prefix}{commit: ${JSON.stringify(out)}}${lineEnd < 0 ? "" : block.slice(lineEnd)}`;
    patched += 1;
  }
  return { yaml: yaml.slice(0, start) + block + yaml.slice(end), patched };
}

/** 解压内嵌资源，每次起引擎时做一次。skipDict：要换成完整词库时不解压内置词库，省一份内存。 */
export async function loadLocalAssets(skipDict = false): Promise<LocalAssets> {
  const binaries: Record<string, ArrayBuffer> = {};
  for (const [name, gz] of Object.entries(COMPRESSED)) {
    if (skipDict && DICT_FILES.has(name)) continue;
    binaries[name] = await gunzip(gz);
  }
  const schema = binaries["pinyin_simp.schema.yaml"];
  if (schema) {
    const { yaml } = patchPunctuation(new TextDecoder().decode(schema));
    binaries["pinyin_simp.schema.yaml"] = new TextEncoder().encode(yaml).buffer;
  }
  return { script: rimeScript, binaries };
}

/** 供诊断报告用：内嵌了哪些资源、各多大。 */
export function assetSummary(): string {
  const rows = Object.entries(COMPRESSED).map(([name, gz]) => `    ${name}：${(gz.byteLength / 1024).toFixed(0)} KB（已压缩）`);
  return [`    rime.js：${(rimeScript.length / 1024).toFixed(0)} KB（未压缩）`, ...rows].join("\n");
}

/** 内置基础词库的身份：来源版本和每个文件解压后的完整 sha256（构建期由 fetch-assets 记录）。 */
export interface DictIdentity {
  label: string;
  source: string;
  files: { name: string; bytes: number; sha256: string }[];
}

export function embeddedDictIdentity(): DictIdentity {
  const files = Object.entries(assetManifest.files as Record<string, { bytes: number; sha256: string }>)
    .filter(([name]) => /^pinyin_simp\.(table|prism|reverse)\.bin/.test(name))
    .map(([name, info]) => ({ name: name.replace(/\.gz$/, ""), bytes: info.bytes, sha256: info.sha256 }));
  return {
    label: "内置基础词库",
    source: `rime-pinyin-simp @rime-contrib/pinyin-simp@${assetManifest.schemas["pinyin-simp"]}`,
    files
  };
}
