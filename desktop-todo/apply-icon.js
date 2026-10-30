/**
 * 打包后处理：把自定义图标与版本信息写入 exe。
 *
 * 为什么需要这一步：
 *   本机非管理员权限下，electron-builder 解压 winCodeSign 组件时因 macOS
 *   符号链接失败，只能用 signAndEditExecutable=false 跳过资源编辑，
 *   但该开关同时会跳过图标嵌入。这里用 rcedit 单独补上。
 */
"use strict";

const path = require("path");
const fs = require("fs");
const rceditModule = require("rcedit");
// rcedit v5 改为具名导出，v3 及以前是直接导出函数，两种都兼容
const rcedit = typeof rceditModule === "function" ? rceditModule : rceditModule.rcedit;

const ROOT = __dirname;
const ICON = path.join(ROOT, "build", "icon.ico");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const targets = [
  path.join(ROOT, "dist", "win-unpacked", `${PKG.build.productName}.exe`)
];

(async () => {
  if (!fs.existsSync(ICON)) {
    console.error("找不到图标文件:", ICON);
    process.exit(1);
  }

  let done = 0;

  for (const exe of targets) {
    if (!fs.existsSync(exe)) {
      console.log("跳过（不存在）:", path.basename(exe));
      continue;
    }

    const before = fs.statSync(exe).size;

    await rcedit(exe, {
      icon: ICON,
      "file-version": PKG.version,
      "product-version": PKG.version,
      "version-string": {
        CompanyName: PKG.author || "",
        FileDescription: `${PKG.build.productName} — 桌面悬浮待办`,
        ProductName: PKG.build.productName,
        LegalCopyright: PKG.build.copyright || "",
        OriginalFilename: `${PKG.build.productName}.exe`,
        InternalName: PKG.build.productName
      }
    });

    const after = fs.statSync(exe).size;
    console.log(`✓ ${path.basename(exe)}  ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
    done++;
  }

  console.log(done > 0 ? `\n已为 ${done} 个可执行文件嵌入图标与版本信息` : "\n没有需要处理的文件");
})().catch((err) => {
  console.error("嵌入失败:", err.message);
  process.exit(1);
});
