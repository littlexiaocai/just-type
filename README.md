# Just Type · 就打个字

## 最近更新 · What's new（0.7.21）

- **有新版本时会提醒你**：打开 Obsidian 时右上角提醒，点「去更新」直接跳到插件页（设置里可关闭，见下方「联网说明」）
- **更新后告诉你改了什么**：升级后第一次打开，弹一次「这次更新了什么」

- **Update reminder**: when a new version is out, a notice appears as Obsidian opens; "去更新" jumps to the plugin page (can be turned off; see "Network use" below)
- **What's new after updating**: the first launch after an update shows what changed

### 0.7.20

- **笔记标题里也能打中文了**：新建笔记时直接在标题处打拼音、选词，按 Shift 切换中英文
- **手指点候选词能上屏了**：iPad 上正文和标题都可以直接点选
- **顿号**：中文模式下按 `/` 或 `\` 直接打出「、」
- **中文标点更完整**：？！：单独输入时也是中文标点

---

- **Type Chinese in note titles**: type Pinyin right in the inline title of a new note; Shift switches Chinese / English there too
- **Tap to select candidates**: tapping a candidate on iPad now commits it, in both the note body and the title
- **Enumeration comma**: in Chinese mode, `/` or `\` types 「、」 directly
- **More Chinese punctuation**: ？！： are full-width even when typed on their own

更早的更新见 [Releases](https://github.com/littlexiaocai/just-type/releases) · Earlier changes: [Releases](https://github.com/littlexiaocai/just-type/releases)

## Why

Just Type is an Obsidian Chinese IME for iPad hardware keyboards. It bypasses the long-standing lag of the system Pinyin IME inside Obsidian.

I only wanted to write Chinese with a keyboard on iPad. I ended up writing an input method first. It only improves typing in Obsidian; it cannot fix the system IME. Other iPad apps still have to wait for Apple.

This is the workaround I made for myself. I hope it becomes unnecessary soon.

### 为什么会有这个项目

Just Type 是一个面向 iPad 外接键盘的 Obsidian 中文输入插件，用来绕开长期存在的中文输入卡顿问题。

我本来只是想在 iPad 上用外接键盘，好好写点中文。没想到，写笔记之前，还得先写个输入法。

不过，它只能改善 Obsidian 内的输入体验，无法修复系统输入法。至于 iPad 上的其他应用，还是得继续等——等，等苹果解决。

这是我给自己想的办法。**希望它早日用不上。**

拼音引擎用 [RIME](https://rime.im/)，通过 [My RIME](https://github.com/LibreService/my_rime) 的 WebAssembly 构建。

## How to use

**iPad + hardware keyboard.** That is the problem this plugin exists to solve, and the setup that has been tested on a real device.

1. Switch the system keyboard to **English ABC**. Just Type takes over — keys go to Just Type, and you can type Pinyin Chinese or English.
2. Press **Shift** to switch Chinese and English. Tap it alone, without holding another key. You can change this key to Control / Option / Command in plugin settings.
3. Switch the system keyboard to Pinyin, and Just Type exits — keys go to the system IME, and Just Type stops.
4. Emoji still uses the keyboard 🌐 globe key. Whether it opens the emoji picker depends on Emoji being enabled in your keyboard list, and on Settings → General → Keyboard → Hardware Keyboard → Press 🌐 to show Emoji.

### 适用范围

**iPad + 外接键盘**。这是它要解决的场景，也是实机验证过的场景。

### 怎么用

**1. 把系统键盘切到英文 ABC，Just Type 随即接手** — 按键归Just Type，可以输入拼音中文或英文。

**2.按 Shift 切换中英文** — 单独按一下，中间不夹别的键。切换键可以在插件设置里改成 Control / Option / Command。

**3. 系统键盘切到拼音，Just Type 自动退出** — 按键归系统输入法，Just Type 停止工作。

两种状态 Just Type 都会主动告诉你：

- 接手时：「Just Type 已就绪——按切换键在中英文之间切换」
- 退出时：「系统键盘切到中文了，Just Type 已停止工作——按键现在归系统输入法」

**4. 表情包**，延用键盘的 🌐 地球键调出表情面板。地球键能否调出表情，取决于键盘列表里是否启用了「表情符号」，以及在实体键盘里的设置（设置 → 通用 → 键盘 → 实体键盘 → 按下 🌐 显示表情符号）。

## Commands

Command names include English aliases, so they are searchable while the system keyboard is in English.

命令名都带英文别名，系统键盘是英文时也搜得到。

| Command | What it does | 作用 |
|---|---|---|
| 切换中英文 (toggle) | Same as Shift | 与 Shift 等价 |
| 切换表情模式 (emoji) | Built-in offline emoji input | 插件内置的离线表情输入 |
| 诊断报告 (report) | Environment, init timing, key capture stats, recent trace | 环境、初始化耗时、按键捕获统计、最近事件轨迹 |
| 诊断：把报告存进 Vault (save report) | Write a note, syncs with Obsidian Sync | 写成笔记，随 Obsidian Sync 到别的设备排查 |
| 诊断：开始/停止记录按键事件 (trace) | Tracing is off by default | 事件轨迹默认关闭，需要排查时才开 |
| 诊断：记录原始按键内容 敏感 (trace raw) | Records actual keys only when this is on | 单独开启才会记录你实际敲了什么 |

Default traces are **redacted**: `key=<letter>` / `code=<letter key>` / `kc=<content>`. Named keys (`Shift`, `Escape`, `Unidentified`) and signals (`keyCode=229`, `code=""`) are kept as-is, enough to judge keyboard behavior without reconstructing what you typed. Redaction happens at write time; turning on sensitive mode later does not expose keys already recorded.

默认记录是**脱敏**的：`key=<字母>` / `code=<字母键>` / `kc=<内容>`。具名键（`Shift`、`Escape`、`Unidentified`）和关键信号（`keyCode=229`、`code=""`）原样保留，足以判断键盘行为，但还原不出输入内容。脱敏发生在写入时刻，事后开启敏感模式不会回溯暴露已记录的按键。

## Network use · 联网说明

Typing is fully offline: the Pinyin engine and dictionary ship with the plugin, and nothing is fetched while you type.
The only network access is the optional **update reminder**. At most once every 24 hours it reads the latest version number and a one-line summary from `registry.npmmirror.com`, falling back to `cdn.jsdelivr.net` and then `api.github.com`. No data about you or your vault is sent. Turn it off in settings with **有新版本时提醒**. Updates are always installed by you through Obsidian's own plugin page; the plugin never downloads or installs itself.

输入过程完全离线：拼音引擎和词库都随插件提供，打字时不联网。
唯一的联网行为是可选的**有新版本时提醒**：每 24 小时最多一次，从 `registry.npmmirror.com` 读取最新版本号和一句更新要点，失败时依次尝试 `cdn.jsdelivr.net`、`api.github.com`。不发送任何关于你或你的笔记的数据。可在设置里关闭「有新版本时提醒」。更新始终由你在 Obsidian 插件页自己完成，插件不会自己下载或安装自己。

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

输入所需的引擎和词库都随插件提供、不在运行时下载，这意味着仓库和每个 Release 都在再分发第三方作品。完整清单、版本与许可证见 `THIRD_PARTY_NOTICES.md`；构建期的抓取过程见 `UPSTREAM.md`。主要的两块：

| 组件 | 许可证 |
|---|---|
| My RIME 0.10.9（Worker、引擎、引擎数据） | AGPL-3.0-or-later |
| rime-pinyin-simp 方案（已裁掉笔画反查） | Apache-2.0 |
