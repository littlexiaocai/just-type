// 发版时同步版本信息：manifest.json 与 update.json 的版本必须一致，再生成 npm/ 下的 package.json。
// 用法：node scripts/release-meta.mjs   然后在 npm/ 里执行 npm publish（先发 GitHub Release，再发 npm）。
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const update = JSON.parse(readFileSync("update.json", "utf8"));
if (manifest.version !== update.version) {
  throw new Error(`manifest.json（${manifest.version}）与 update.json（${update.version}）版本不一致`);
}
if (typeof update.headline !== "string" || !update.headline.trim()) throw new Error("update.json 缺少 headline");

const pkg = {
  name: "just-type-ime",
  version: manifest.version,
  description: "Version info for the Just Type IME Obsidian plugin (read by its update reminder). Not a library.",
  license: "AGPL-3.0-or-later",
  author: "littlexiaocai",
  homepage: "https://github.com/littlexiaocai/just-type",
  repository: { type: "git", url: "git+https://github.com/littlexiaocai/just-type.git" },
  files: ["manifest.json", "update.json"],
  justType: { headline: update.headline }
};
writeFileSync("npm/package.json", JSON.stringify(pkg, null, 2) + "\n");
copyFileSync("manifest.json", "npm/manifest.json");
copyFileSync("update.json", "npm/update.json");
copyFileSync("LICENSE", "npm/LICENSE");
console.log(`npm/package.json → just-type-ime@${pkg.version}「${update.headline}」`);
