/**
 * 随插件内置的更新说明：升级后第一次启动时展示一次，也可用命令「查看最近更新」回看。
 * 与 README 顶部「最近更新」、GitHub Release 说明是同一份文字，每次发版一起改。新版本加在最前面。
 */
export interface ReleaseNote {
  version: string;
  items: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.7.21",
    items: [
      "有新版本时，打开 Obsidian 会在右上角提醒你，点「去更新」直接跳到插件页（设置里可关闭）",
      "更新之后，会像现在这样弹一次「这次更新了什么」"
    ]
  },
  {
    version: "0.7.20",
    items: [
      "笔记标题里也能打中文了：新建笔记时直接在标题处打拼音、选词，按 Shift 切换中英文",
      "手指点候选词能上屏了：iPad 上正文和标题都可以直接点选",
      "顿号：中文模式下按 / 或 \\ 直接打出「、」",
      "中文标点更完整：？！：单独输入时也是中文标点"
    ]
  }
];
