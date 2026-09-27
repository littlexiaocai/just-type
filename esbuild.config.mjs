import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "cjs",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  loader: { ".txt": "text", ".gz": "binary" },
  // 发布产物不带 sourcemap：内联会把全部源码 base64 塞进 main.js，
  // 插件要装到 iPad 上，体积直接翻倍不值当。调试时加 --dev。
  sourcemap: process.argv.includes("--dev") ? "inline" : false,
  // 只在本机测试下载流程时设置 JT_DICT_URLS（逗号分隔）；正式构建不设，用 catalog.json 里的地址。
  // 构建时间写进诊断报告：测试期间版本号不变，靠它分辨设备上是不是最新构建。
  define: {
    JT_DEV_DICT_URLS: JSON.stringify(process.env.JT_DICT_URLS ? process.env.JT_DICT_URLS.split(",") : null),
    JT_BUILD_TIME: JSON.stringify(new Date().toLocaleString("zh-CN", { hour12: false }))
  },
  outfile: process.env.JT_OUTFILE || "dist/main.js",
  logLevel: "info"
});
