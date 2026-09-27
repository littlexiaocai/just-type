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

/** 解压内嵌资源，每次起引擎时做一次。skipDict：要换成完整词库时不解压内置词库，省一份内存。 */
export async function loadLocalAssets(skipDict = false): Promise<LocalAssets> {
  const binaries: Record<string, ArrayBuffer> = {};
  for (const [name, gz] of Object.entries(COMPRESSED)) {
    if (skipDict && DICT_FILES.has(name)) continue;
    binaries[name] = await gunzip(gz);
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
