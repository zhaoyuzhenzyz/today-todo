# 测试

自动化测试通过 CDP（Chrome DevTools Protocol）驱动**真实的** Electron 窗口和 Edge 浏览器，不是 DOM 模拟。

## 准备

```bash
cd tests
npm install                    # 安装 ws

# 桌面端测试需要先装依赖
cd ../desktop-todo && npm install
```

`_web_edit_test.js` 依赖系统安装的 Microsoft Edge，路径在脚本顶部的 `EDGE` 常量里，换机器时需要改。

## 运行

| 命令 | 测什么 | 前置条件 | 断言数 |
|---|---|---|---|
| `npm run test:edit` | 桌面版编辑功能 | `desktop-todo` 已 `npm install` | 27 |
| `npm run test:web` | 浏览器版编辑功能 | 系统有 Edge | 32 |
| `npm run test:pkg` | 打包产物（win-unpacked） | 先 `npm run dist` | 12 |
| `npm run test:install` | 安装→使用→卸载全流程 | 先 `npm run dist` | 26 |

```bash
npm run test:edit
# ===== 编辑功能测试 =====
# PASS 27 / FAIL 0
```

全部通过时退出码为 0，有失败项时为 1，可直接接 CI。

## 各脚本覆盖范围

### `edit.test.js` — 桌面版编辑

在真实 Electron 窗口里验证：铅笔按钮 / 双击两种入口、输入框预填原文、编辑时标题隐藏、`Enter` 保存并持久化、`Esc` 取消且不误隐藏窗口、内容未改不产生脏写、首尾空格裁剪、清空即删除、单编辑态互斥与自动提交、完成态可改名、刷新后保留。

### `web-edit.test.js` — 浏览器版编辑

Edge headless + CDP。除了上述编辑逻辑，额外覆盖：铅笔图标 DOM 渲染、编辑时删除按钮隐藏、切换筛选不丢改动、`maxLength` 截断到 200 字。

### `pkg-edit.test.js` — 打包产物回归

直接启动 `dist/win-unpacked/今日待办.exe`，确认 asar 内的代码同样具备编辑能力，同时校验悬浮模式与置顶状态未被破坏。

### `install.test.js` — 安装全流程

PowerShell 驱动（node 直接 spawn NSIS 会崩）。静默安装 → 校验程序本体与 app.asar 到位 → 解析快捷方式 `.lnk` 的目标路径/工作目录/图标设置 → 启动安装版并实测编辑功能 → 静默卸载 → 确认程序、快捷方式、安装目录全部清除。

### `verify_pe.py` — 图标与版本资源

手工解析 PE 资源目录，统计 `RT_ICON` / `RT_GROUP_ICON` / `RT_VERSION` 条目数与各帧字节长度，确认三个 exe 都嵌入了 9 帧图标和正确版本号。

```bash
python verify_pe.py
```

## 已知环境坑

这些在 Windows 上踩过，脚本里已有对应处理，改动时别删：

1. **`ELECTRON_RUN_AS_NODE`** —— 宿主环境存在该变量时 electron.exe 会以纯 Node 模式启动，`require('electron')` 解析到 npm 包而非内置模块。启动前必须 `delete env.ELECTRON_RUN_AS_NODE`，同时清 `NODE_PATH`。

2. **GPU 进程沙箱崩溃** —— 加 `--disable-gpu --disable-gpu-compositing --no-sandbox` 绕过。不影响用户实际运行。

3. **`Page.enable` 会超时** —— 用 `Runtime.enable` + `Runtime.evaluate` 即可。切换窗口模式后渲染进程重建，必须重新连 `/json/list` 取新 target。

4. **node spawn NSIS 会崩** —— `execFileSync` 直接调安装器报 `0xC0000005`，且 Git Bash 会把 `/D=C:\Temp\x` 转成正斜杠。改用 PowerShell `Start-Process`，参数**整体作为一个字符串**传入。

5. **`[Console]::OutputEncoding = UTF8` 会让 NSIS 崩溃** —— 加了就 100% 失败。中文路径不要经 stdout 回传，让 PowerShell 就地比对后只输出 `BOOL` 或纯 ASCII。

6. **NSIS 卸载的 `_?=` 参数会残留卸载器自身** —— 它不复制到临时目录，删不掉自己。不加 `_?=` 才是从控制面板卸载的真实行为。

7. **`reg.exe` 在安全策略黑名单里** —— 查卸载注册表项会被拒。改用 `WScript.Shell` COM 解析 `.lnk`。

8. **测试顺序要贴合真实状态机** —— 曾把「设置面板」用例排在「隐藏到托盘」之后，窗口已隐藏导致假失败。
