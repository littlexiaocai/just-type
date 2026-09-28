# Just Type · 就打个字

在 Obsidian 里用 iPad 外接键盘顺畅地打中文：插件自带拼音输入法，绕开系统拼音输入法在 Obsidian 里的卡顿。

Type Chinese smoothly in Obsidian with an iPad hardware keyboard: a built-in Pinyin input method that bypasses the lag of the system Pinyin IME.

## 最近更新 · What's new（1.0.0）

### 🎉 词库大升级，打字更畅快：从约 6.5 万条扩充到约 187 万条

三字词、四字成语、常用说法一打就出来，候选更准，少翻页。词库来自[雾凇拼音](https://github.com/iDvel/rime-ice)，第一次打开后在后台自动下载约 26 MB，下载期间照常打字，下好后在你停手时自动换上，之后不用联网。

- **国内从 npmmirror 下载**，不用翻墙；它慢时自动改从国外源下。每一段都核对校验值，断网或中断后自动接着下
- **第一次下载时笔记右上角显示进度**，也可以在设置里暂停
- **换词库不影响**输入法已经记住的你的用词习惯
- **设置页更简洁**：正常时只显示版本；拼音固定显示在光标处，和微信、搜狗一样

### 🎉 A big dictionary upgrade for smoother typing: from about 65 thousand to about 1.87 million entries

Three-character words, four-character idioms and everyday phrases come up right away, with better candidates and less paging. The dictionary comes from [rime-ice](https://github.com/iDvel/rime-ice). On first launch about 26 MB downloads in the background while you keep typing; it is switched in when you pause, then works offline.

- **Downloads from npmmirror** (reachable in mainland China) and switches to the overseas source automatically when it is slow; every segment is checksum-verified and a download interrupted by going offline resumes on its own
- **Progress shows at the top right of the note** during the first download; you can pause it in settings
- **Switching dictionaries keeps** what the input method has learned from you
- **Simpler settings**: normally just the version; Pinyin is always shown at the cursor, like WeChat and Sogou input methods

更早的更新见 [Releases](https://github.com/littlexiaocai/just-type/releases) · Earlier changes: [Releases](https://github.com/littlexiaocai/just-type/releases)

## 怎么用 · How to use

**适用于 iPad ＋ 外接键盘**，这是它要解决的场景，也是实机验证过的场景。装好后第一次打开会弹出使用说明，之后在 **设置 → Just Type IME → 使用说明** 随时能看。

1. **系统键盘切到英文 ABC，Just Type 接手**：可以输入拼音中文或英文。
2. **系统键盘切到中文拼音，Just Type 退出**：按键归还系统输入法。
3. **单独按一下 Shift，切换中英文**：在 Just Type 内部切换，不用来回切系统键盘。切换键可以在插件设置里改成 Control / Option / Command。
4. **选词**：空格选第一个，数字键选第几个，也可以用手指点。
5. **表情**：仍用键盘上的 🌐 地球键调出。能否调出取决于键盘列表里是否启用了「表情符号」，以及 设置 → 通用 → 键盘 → 实体键盘 → 按下 🌐 显示表情符号。

系统键盘在中文拼音时，Shift 归系统输入法（比如微信、搜狗用它切中英），Just Type 不会跟着切换。接手和退出时，Just Type 都会弹出提示：

- 接手时：「Just Type 已就绪——按 Shift 在中英文之间切换」
- 退出时：「系统键盘切到中文了，Just Type 已停止工作。如要继续用 Just Type，请把系统键盘切回英文 ABC。」

**遇到问题**

- 打中文还是卡：确认系统键盘切到了「英文 ABC」，再单独按一下 Shift 切到中文
- 还是不行：请发邮件到 [xxyybear@gmail.com](mailto:xxyybear@gmail.com)

---

**iPad + hardware keyboard** is the setup this plugin is made for and tested on. The first launch shows a short guide; open it again any time from **Settings → Just Type IME → 使用说明**.

1. Switch the system keyboard to **English ABC** and Just Type takes over: type Pinyin Chinese or English.
2. Switch the system keyboard to **Chinese Pinyin** and Just Type steps aside: keys go back to the system IME.
3. Tap **Shift** on its own to switch Chinese and English inside Just Type, without touching the system keyboard. You can change the key to Control / Option / Command in plugin settings.
4. **Pick a candidate** with Space (the first one), a number key, or a tap.
5. **Emoji** still uses the 🌐 globe key. It depends on Emoji being enabled in your keyboard list, and on Settings → General → Keyboard → Hardware Keyboard → Press 🌐 to show Emoji.

While the system keyboard is on Chinese Pinyin, Shift belongs to the system IME and Just Type does not toggle. Just Type shows a notice both when it takes over and when it steps aside.

## 为什么做这个项目 · Why

Just Type is an Obsidian Chinese IME for iPad hardware keyboards. It bypasses the long-standing lag of the system Pinyin IME inside Obsidian.

I only wanted to write Chinese with a keyboard on iPad. I ended up writing an input method first. It only improves typing in Obsidian; it cannot fix the system IME. Other iPad apps still have to wait for Apple.

This is the workaround I made for myself. I hope it becomes unnecessary soon.

### 为什么会有这个项目

Just Type 是一个面向 iPad 外接键盘的 Obsidian 中文输入插件，用来绕开长期存在的中文输入卡顿问题。

我本来只是想在 iPad 上用外接键盘，好好写点中文。没想到，写笔记之前，还得先写个输入法。

不过，它只能改善 Obsidian 内的输入体验，无法修复系统输入法。至于 iPad 上的其他应用，还是得继续等——等，等苹果解决。

这是我给自己想的办法。**希望它早日用不上。**

拼音引擎用 [RIME](https://rime.im/)，通过 [My RIME](https://github.com/LibreService/my_rime) 的 WebAssembly 构建。

## Commands

Command names include English aliases, so they are searchable while the system keyboard is in English.

命令名都带英文别名，系统键盘是英文时也搜得到。

| Command | What it does | 作用 |
|---|---|---|
| 使用说明 (help) | Open the quick guide | 打开使用说明 |
| 切换中英文 (toggle) | Same as Shift | 与 Shift 等价 |
| 切换表情模式 (emoji) | Built-in offline emoji input | 插件内置的离线表情输入 |
| 词库下载状态 (dictionary) | Dictionary download status | 词库下载的详细状态 |
| 重新下载词库（排查问题用）(redownload dictionary) | Delete the local dictionary data and download again; learned words are kept | 删掉本机的词库数据重新下载，学习记录不受影响 |
| 查看最近更新 (what's new) | Recent changes | 最近几个版本改了什么 |
| 检查新版本 (check update) | Check for a new version now | 立即检查新版本 |
| 诊断报告 (report) | Environment, init timing, key capture stats, recent trace | 环境、初始化耗时、按键捕获统计、最近事件轨迹 |
| 诊断：把报告存进 Vault (save report) | Write a note, syncs with Obsidian Sync | 写成笔记，随 Obsidian Sync 到别的设备排查 |
| 诊断：开始/停止记录按键事件 (trace) | Tracing is off by default | 事件轨迹默认关闭，需要排查时才开 |
| 诊断：记录原始按键内容 敏感 (trace raw) | Records actual keys only when this is on | 单独开启才会记录你实际敲了什么 |

Default traces are **redacted**: `key=<letter>` / `code=<letter key>` / `kc=<content>`. Named keys (`Shift`, `Escape`, `Unidentified`) and signals (`keyCode=229`, `code=""`) are kept as-is, enough to judge keyboard behavior without reconstructing what you typed. Redaction happens at write time; turning on sensitive mode later does not expose keys already recorded.

默认记录是**脱敏**的：`key=<字母>` / `code=<字母键>` / `kc=<内容>`。具名键（`Shift`、`Escape`、`Unidentified`）和关键信号（`keyCode=229`、`code=""`）原样保留，足以判断键盘行为，但还原不出输入内容。脱敏发生在写入时刻，事后开启敏感模式不会回溯暴露已记录的按键。

## Network use · 联网说明

Typing never waits for the network: the Pinyin engine and a base dictionary ship with the plugin, and nothing is fetched while you type. The plugin makes two kinds of requests:

1. **Full dictionary (one-time download, about 26 MB).** After the base dictionary is ready, the plugin downloads a larger dictionary in the background, from `registry.npmmirror.com` (reachable in mainland China), falling back to `registry.npmjs.org`. It is the npm package [`just-type-dict`](https://www.npmjs.com/package/just-type-dict): compiled dictionary data from [rime-ice](https://github.com/iDvel/rime-ice) (GPL-3.0), no code. Every 2 MB segment and every file is checked against SHA-256 values built into the plugin before use. It is stored only on this device (not synced by Obsidian Sync) and then works offline. Switching dictionaries does not touch what the input method has learned from you. While it downloads you can pause it in settings (a **词库** row appears there until the dictionary is ready). Nothing about you or your notes is sent.
2. **Update reminder (optional).** At most once every 24 hours it reads the latest version number and a one-line summary from `registry.npmmirror.com`, falling back to `cdn.jsdelivr.net` and then `api.github.com`. Turn it off with the switch on the **版本** row in settings. Updates are always installed by you through Obsidian's own plugin page; the plugin never downloads or installs its own code.

打字从不等网络：拼音引擎和基础词库随插件提供，打字时不联网。插件只有两类联网：

1. **完整词库（一次性下载，约 26 MB）**：基础词库就绪后在后台自动下载更大的词库，来源 `registry.npmmirror.com`（国内可直接访问），备用 `registry.npmjs.org`。它是 npm 包 [`just-type-dict`](https://www.npmjs.com/package/just-type-dict)，内容是由[雾凇拼音](https://github.com/iDvel/rime-ice)（GPL-3.0）编译的词库数据，不含任何代码。每 2 MB 一段、每个文件都先和插件内置的 SHA-256 核对才会使用。只存在这台设备上（不随 Obsidian Sync 同步），下载后离线可用。换词库不影响输入法记住的你的用词习惯。下载期间可以在设置里暂停（词库准备好之前，设置里会多出一行「词库」）。不发送任何关于你或你的笔记的数据。
2. **新版本提醒（可关闭）**：每 24 小时最多一次，从 `registry.npmmirror.com` 读取最新版本号和一句更新要点，失败时依次尝试 `cdn.jsdelivr.net`、`api.github.com`。可在设置里「版本」那一行关闭。更新始终由你在 Obsidian 插件页自己完成，插件不会自己下载或安装自己的代码。

## Feedback

If you run into a problem, please open a GitHub Issue: https://github.com/littlexiaocai/just-type/issues

If GitHub is inconvenient, email me: xxyybear@gmail.com

If you can, include your iPad model, iPadOS version, Obsidian version, and a screenshot or screen recording of the issue.

### 反馈

如果你遇到了问题，欢迎通过 GitHub Issues 提交：https://github.com/littlexiaocai/just-type/issues
不方便使用 GitHub，也可以直接发邮件给我：xxyybear@gmail.com
如果方便，请附上 iPad 型号、iPadOS 版本、Obsidian 版本以及问题截图或录屏。

## 上游项目与许可

- My RIME: https://github.com/LibreService/my_rime
- RIME: https://rime.im/

就打个字以 **AGPL-3.0-or-later** 发布，与其内嵌的 My RIME 一致。

引擎和基础词库随插件提供，这意味着仓库和每个 Release 都在再分发第三方作品；完整词库是单独发布的数据包，插件运行时下载。完整清单、版本与许可证见 `THIRD_PARTY_NOTICES.md`；构建期的抓取过程见 `UPSTREAM.md`。主要的几块：

| 组件 | 许可证 |
|---|---|
| My RIME 0.10.9（Worker、引擎、引擎数据） | AGPL-3.0-or-later |
| rime-pinyin-simp 方案与基础词库（已裁掉笔画反查） | Apache-2.0 |
| 完整词库 `just-type-dict`（雾凇拼音编译，运行时下载） | GPL-3.0 |
