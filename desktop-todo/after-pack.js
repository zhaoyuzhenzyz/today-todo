/**
 * electron-builder afterPack 钩子
 *
 * 在「应用目录已打包完成、安装程序尚未生成」的时间点，用 rcedit 把自定义图标
 * 与版本信息写入 exe。这样 NSIS 安装包与 portable 包都会拿到带图标的可执行文件。
 *
 * 背景：本机非管理员权限下 winCodeSign 组件解压失败（macOS 符号链接），
 * 只能用 signAndEditExecutable=false 跳过 electron-builder 的资源编辑，
 * 但那会连带跳过图标嵌入，所以在钩子里自行补上。
 */
"use strict";

const path = require("path");
const fs = require("fs");

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName !== "win32") return;

  const productName = packager.appInfo.productFilename;
  const exePath = path.join(appOutDir, `${productName}.exe`);
  const iconPath = path.join(packager.projectDir, "build", "icon.ico");

  if (!fs.existsSync(exePath)) {
    console.warn("[afterPack] 未找到可执行文件:", exePath);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.warn("[afterPack] 未找到图标:", iconPath);
    return;
  }

  const rceditModule = require("rcedit");
  const rcedit = typeof rceditModule === "function" ? rceditModule : rceditModule.rcedit;

  const version = packager.appInfo.version;
  const copyright = (packager.config && packager.config.copyright) || "";

  await rcedit(exePath, {
    icon: iconPath,
    "file-version": version,
    "product-version": version,
    "version-string": {
      CompanyName: "小赵",
      FileDescription: `${productName} — 桌面悬浮待办`,
      ProductName: productName,
      LegalCopyright: copyright,
      OriginalFilename: `${productName}.exe`,
      InternalName: productName
    }
  });

  const size = (fs.statSync(exePath).size / 1048576).toFixed(1);
  console.log(`  • 已嵌入图标与版本信息  ${path.basename(exePath)}  ${size}MB`);
};
