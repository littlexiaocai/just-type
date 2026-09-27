// 可复现地构建「完整词库」npm 包，并生成插件内置的可信清单 src/dict/catalog.json。
//
// 流程：按固定提交下载雾凇拼音 cn_dicts（逐个核对 sha256）→ 用 librime 的 rime_deployer 编译成
// pinyin_simp.{table,prism,reverse}.bin（词典名沿用 pinyin_simp，拼写规则取插件内置方案）→ 组成 npm 包
// 目录（附 GPL-3.0 许可证与出处说明）→ npm pack 成 tgz → 计算整包、分段、单个文件的 sha256。
//
// 插件只信任 catalog.json 里的哈希：下载到的每一段、解包后的每个文件都要和它逐一对上，不信任任何远端自报的哈希。
// 发布时必须发布这里生成的这个 tgz（npm publish dict/<tgz>），npmmirror 会原样同步，哈希才对得上。
//
// 需要：Homebrew librime（提供 rime_deployer）、Node 18+、网络（只在构建时）。
// 用法：node scripts/build-dict.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const PACKAGE_NAME = "just-type-dict";
const PACKAGE_VERSION = "1.0.0";
const SEGMENT_BYTES = 2 * 1024 * 1024;

const RIME_ICE_REPO = "iDvel/rime-ice";
const RIME_ICE_COMMIT = "9e66b0729083b37d217312294f6d516c8d7234be";
/** 源词库文件及其 sha256（与 2026-09-26 性能测试所用完全相同）。 */
const SOURCES = {
  "8105": "1f9a42b91dea6982",
  base: "19f6f96f5dfe5535",
  ext: "f3843fecd2ec69ab",
  tencent: "858a641cef8b22d5"
};

const ROOT = process.cwd();
const WORK = join(ROOT, ".dict-build");
const OUT = join(ROOT, "dict");
const PKG = join(OUT, "package");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function librimeVersion() {
  try {
    return execFileSync("brew", ["list", "--versions", "librime"], { encoding: "utf8" }).trim();
  } catch {
    return "librime（版本未知）";
  }
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(PKG, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(PKG, { recursive: true });

  // 1. 源词库：按固定提交下载，逐个核对 sha256 前缀（与测试记录一致）。
  const sourceHashes = {};
  let entries = 0;
  for (const [name, prefix] of Object.entries(SOURCES)) {
    const buf = await fetchBuffer(`https://raw.githubusercontent.com/${RIME_ICE_REPO}/${RIME_ICE_COMMIT}/cn_dicts/${name}.dict.yaml`);
    const hash = sha256(buf);
    if (!hash.startsWith(prefix)) throw new Error(`${name}.dict.yaml 的 sha256 ${hash} 与固定值 ${prefix}… 不符`);
    writeFileSync(join(WORK, `${name}.dict.yaml`), buf);
    sourceHashes[`cn_dicts/${name}.dict.yaml`] = hash;
    // 词条数：YAML 头（到 "..." 为止）之后的非空、非注释行。
    const body = buf.toString("utf8").split("\n...\n")[1] ?? "";
    entries += body.split("\n").filter((line) => line.trim() && !line.startsWith("#")).length;
    console.log(`源词库 ${name}.dict.yaml  ${buf.length} B  ${hash}`);
  }

  // 2. 编译：词典名 pinyin_simp，拼写规则取插件内置方案，保证与插件的 prism 一致。
  const schema = gunzipSync(readFileSync(join(ROOT, "src/assets/pinyin_simp.schema.yaml.gz"))).toString("utf8");
  const speller = schema.slice(schema.indexOf("\nspeller:") + 1, schema.indexOf("\nswitches:"));
  if (!speller.startsWith("speller:")) throw new Error("没在内置方案里找到 speller 段");
  writeFileSync(join(WORK, "pinyin_simp.dict.yaml"), ["---", "name: pinyin_simp", `version: "just-type-dict-${PACKAGE_VERSION}"`, "sort: by_weight", "import_tables:", ...Object.keys(SOURCES).map((n) => `  - ${n}`), "..."].join("\n") + "\n");
  writeFileSync(join(WORK, "pinyin_simp.schema.yaml"), ["schema:", "  schema_id: pinyin_simp", "  name: pinyin_simp", speller.trimEnd(), "translator:", "  dictionary: pinyin_simp"].join("\n") + "\n");
  mkdirSync(join(WORK, "out"), { recursive: true });
  // rime_deployer 会把源文件的修改时间写进编译用的方案，prism 里又存了它的校验值。
  // 固定所有源文件的修改时间，同样的输入才能得到逐字节相同的输出。
  const FIXED_TIME = new Date("2026-01-01T00:00:00Z");
  for (const name of readdirSync(WORK)) if (name.endsWith(".yaml")) utimesSync(join(WORK, name), FIXED_TIME, FIXED_TIME);
  execFileSync("rime_deployer", ["--compile", "pinyin_simp.schema.yaml", "out", ".", "out"], { cwd: WORK, stdio: "ignore" });

  const files = [];
  for (const kind of ["table", "prism", "reverse"]) {
    const name = `pinyin_simp.${kind}.bin`;
    const buf = readFileSync(join(WORK, "out", name));
    copyFileSync(join(WORK, "out", name), join(PKG, name));
    files.push({ name, bytes: buf.length, sha256: sha256(buf) });
    console.log(`编译 ${name}  ${buf.length} B  ${sha256(buf)}`);
  }

  // 3. 许可证与出处：GPL-3.0 要求附许可证全文并说明源码出处。
  writeFileSync(join(PKG, "LICENSE"), await fetchBuffer(`https://raw.githubusercontent.com/${RIME_ICE_REPO}/${RIME_ICE_COMMIT}/LICENSE`));
  const librime = librimeVersion();
  writeFileSync(join(PKG, "README.md"), `# ${PACKAGE_NAME}

Full Pinyin dictionary for the [Just Type IME](https://github.com/littlexiaocai/just-type) Obsidian plugin.
The plugin downloads this package once and then works offline. This package contains **data only**
(compiled RIME dictionary tables); no code.

Just Type IME 插件的完整词库。插件首次使用时下载一次，之后离线使用。本包只含数据（编译好的 RIME 词表），不含任何代码。

## Source / 来源

- Dictionary data: [${RIME_ICE_REPO}](https://github.com/${RIME_ICE_REPO}) (雾凇拼音) at commit \`${RIME_ICE_COMMIT}\`,
  files \`${Object.keys(SOURCES).map((n) => `cn_dicts/${n}.dict.yaml`).join("`, `")}\`
- License: GPL-3.0 (see LICENSE). Corresponding source: the files above at that commit.
- Compiled with ${librime} \`rime_deployer --compile\`, dictionary name \`pinyin_simp\`,
  spelling rules from Just Type's bundled \`pinyin_simp.schema.yaml\`.
- Build script: \`scripts/build-dict.mjs\` in https://github.com/littlexiaocai/just-type
`);
  writeFileSync(join(PKG, "package.json"), JSON.stringify({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description: "Full Pinyin dictionary (compiled RIME tables, data only) for the Just Type IME Obsidian plugin.",
    license: "GPL-3.0",
    author: "littlexiaocai",
    homepage: "https://github.com/littlexiaocai/just-type",
    repository: { type: "git", url: "git+https://github.com/littlexiaocai/just-type.git" },
    files: files.map((f) => f.name),
    justTypeDict: { format: 1, dictionary: "pinyin_simp", source: `${RIME_ICE_REPO}@${RIME_ICE_COMMIT}` }
  }, null, 2) + "\n");

  // 4. 打包：npm pack 会把文件时间固定下来，同样的内容得到同样的 tgz。
  const packed = JSON.parse(execFileSync("npm", ["pack", PKG, "--json", "--pack-destination", OUT], { encoding: "utf8" }))[0];
  const tgzPath = join(OUT, packed.filename);
  const tgz = readFileSync(tgzPath);
  const segments = [];
  for (let offset = 0; offset < tgz.length; offset += SEGMENT_BYTES) {
    segments.push(sha256(tgz.subarray(offset, Math.min(offset + SEGMENT_BYTES, tgz.length))));
  }

  // 5. 插件内置的可信清单。
  const catalog = {
    id: `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    label: "完整词库（雾凇拼音 字表＋基础＋扩充＋腾讯）",
    entries,
    source: `${RIME_ICE_REPO}@${RIME_ICE_COMMIT}`,
    license: "GPL-3.0",
    compiler: librime,
    tarball: {
      filename: packed.filename,
      bytes: tgz.length,
      sha256: sha256(tgz),
      integrity: packed.integrity,
      segmentBytes: SEGMENT_BYTES,
      segments
    },
    // 下载地址按顺序尝试，同一个 tgz，哈希必须一致。
    urls: [
      `https://registry.npmmirror.com/${PACKAGE_NAME}/-/${packed.filename}`,
      `https://registry.npmjs.org/${PACKAGE_NAME}/-/${packed.filename}`
    ],
    files,
    sourceHashes
  };
  mkdirSync(join(ROOT, "src/dict"), { recursive: true });
  writeFileSync(join(ROOT, "src/dict/catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\n打包 ${packed.filename}  ${tgz.length} B  sha256 ${catalog.tarball.sha256}`);
  console.log(`分段 ${segments.length} 段 × ${SEGMENT_BYTES} B，清单已写入 src/dict/catalog.json`);
  if (!existsSync(tgzPath)) throw new Error("tgz 不存在");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
