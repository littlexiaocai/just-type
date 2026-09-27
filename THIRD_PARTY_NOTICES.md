# 第三方组件声明

就打个字（Just Type IME）的 RIME 引擎、拼音方案和基础词库全部随 `main.js` 一起分发；完整词库另行下载，见下文。
也就是说，本仓库和每一个 Release 都在**再分发**下列第三方作品，此文件记录它们的
出处与许可证。

构建期的抓取过程见 `scripts/fetch-assets.mjs`；每个文件的来源 URL 与 sha256
记录在 `src/assets/ASSETS.json`。

## 直接内嵌的文件

| 内嵌文件 | 来源 | 版本 | 许可证 |
|---|---|---|---|
| `src/vendor/my-rime-worker.txt` | [`@libreservice/my-rime`](https://www.npmjs.com/package/@libreservice/my-rime) 的 `dist/worker.js` | 0.10.9 | AGPL-3.0-or-later |
| `rime.js`、`rime.wasm`、`rime.data` | 同上，`dist/` | 0.10.9 | AGPL-3.0-or-later |
| `pinyin_simp.{schema.yaml,prism.bin,table.bin,reverse.bin}` | [`@rime-contrib/pinyin-simp`](https://www.npmjs.com/package/@rime-contrib/pinyin-simp)，源自 [rime/rime-pinyin-simp](https://github.com/rime/rime-pinyin-simp) | 0.1.1 | Apache-2.0 |

`pinyin_simp.schema.yaml` 在内嵌前裁掉了笔画反查（`reverse_lookup_translator`、对 `stroke` 的依赖）。二进制词库未改。

许可证全文随仓库分发：

- `THIRD_PARTY_LICENSE_My_RIME.txt`（AGPL-3.0）
- `THIRD_PARTY_LICENSE_rime-pinyin-simp.txt`（Apache-2.0）

## 通过 rime.wasm / rime.data 间接包含的组件

`rime.js`、`rime.wasm` 和 `rime.data` 是 [My RIME](https://github.com/LibreService/my_rime)
项目的 WebAssembly 构建产物，其中静态包含了下列上游库。就打个字没有单独获取或修改
它们，只是原样再分发 My RIME 的构建结果：

- [librime](https://github.com/rime/librime) —— RIME 输入法引擎本体
- [OpenCC](https://github.com/BYVoid/OpenCC) —— 简繁转换
- [Lua](https://www.lua.org/) 与 [librime-lua](https://github.com/hchunhui/librime-lua) —— 方案脚本扩展
- [Boost](https://www.boost.org/)
- [LevelDB](https://github.com/google/leveldb)
- [marisa-trie](https://github.com/s-yata/marisa-trie)
- [yaml-cpp](https://github.com/jbeder/yaml-cpp)

这些组件各自的许可证以其上游项目的声明为准。My RIME 以 AGPL-3.0-or-later 分发
其构建产物，就打个字随之以同一许可证再分发。

## 运行时下载的完整词库（不随插件分发）

基础词库就绪后，插件会下载 npm 包 [`just-type-dict`](https://www.npmjs.com/package/just-type-dict)
（先 npmmirror，备用 npmjs），这是一份单独发布的数据包，不打进 `main.js`：

| 文件 | 来源 | 版本 | 许可证 |
|---|---|---|---|
| `pinyin_simp.{table,prism,reverse}.bin` | [iDvel/rime-ice](https://github.com/iDvel/rime-ice)（雾凇拼音）`cn_dicts/{8105,base,ext,tencent}.dict.yaml`，用 librime 1.17 编译 | commit `9e66b0729083b37d217312294f6d516c8d7234be` | GPL-3.0 |

- 包内带有 GPL-3.0 全文（`LICENSE`）和来源说明（`README.md`）；对应源码即上述提交里的词典文件。
- 可复现构建：`scripts/build-dict.mjs` 固定源文件的提交与 sha256、编译器版本和拼写规则，产物的
  sha256 写进 `src/dict/catalog.json`，插件只接受与之完全一致的数据。
- 包里只有编译好的词表数据，不含任何可执行代码；插件的代码只随插件版本更新。

## 就打个字自身

就打个字以 **AGPL-3.0-or-later** 发布，与其内嵌的 My RIME 一致。完整文本见 `LICENSE`。
