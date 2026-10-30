"use strict";

/**
 * 今日待办 · 桌面悬浮版 —— 主进程
 *
 * 两种窗口模式：
 *   floating  无边框 / 透明 / 始终置顶 / 可拖动 / 不占任务栏
 *   normal    常规有边框窗口 / 可缩放 / 可最小化 / 占任务栏
 *
 * 位置、尺寸、模式、透明度均持久化到 userData/state.json
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  screen,
  nativeImage,
  shell
} = require("electron");
const path = require("path");
const fs = require("fs");

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const APP_NAME = "今日待办";

const FLOAT_SIZE = { width: 348, height: 470 };
const NORMAL_SIZE = { width: 620, height: 780 };

const MIN_FLOAT = { width: 300, height: 300 };
const MIN_NORMAL = { width: 440, height: 440 };

const SNAP_THRESHOLD = 14;
const DEFAULT_OPACITY = 1;

const stateFile = () => path.join(app.getPath("userData"), "state.json");

const DEFAULT_STATE = {
  mode: "floating",
  opacity: DEFAULT_OPACITY,
  alwaysOnTop: true,
  floatBounds: null,
  normalBounds: null
};

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

let state = { ...DEFAULT_STATE };
let win = null;
let tray = null;
let quitting = false;

// 开机自启（--autostart）时不弹窗，只在托盘待命
let startHidden = process.argv.includes("--autostart");

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      state = {
        ...DEFAULT_STATE,
        ...parsed,
        mode: parsed.mode === "normal" ? "normal" : "floating"
      };
    }
  } catch (err) {
    state = { ...DEFAULT_STATE };
  }
}

function writeState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    /* 落盘失败不应中断运行 */
  }
}

/* ------------------------------------------------------------------ */
/* 几何工具                                                            */
/* ------------------------------------------------------------------ */

function workAreaFor(bounds) {
  try {
    return screen.getDisplayMatching(bounds).workArea;
  } catch (err) {
    return screen.getPrimaryDisplay().workArea;
  }
}

function clampToArea(b, area) {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - height));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function isValidBounds(b) {
  return (
    b &&
    Number.isFinite(b.x) && Number.isFinite(b.y) &&
    Number.isFinite(b.width) && Number.isFinite(b.height) &&
    b.width > 150 && b.height > 150
  );
}

function isOnScreen(b) {
  if (!isValidBounds(b)) return false;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height
  );
}

function defaultFloatBounds() {
  const a = screen.getPrimaryDisplay().workArea;
  return clampToArea(
    {
      x: a.x + a.width - FLOAT_SIZE.width - 30,
      y: a.y + Math.round(a.height * 0.18),
      ...FLOAT_SIZE
    },
    a
  );
}

function defaultNormalBounds() {
  const a = screen.getPrimaryDisplay().workArea;
  return clampToArea(
    {
      x: a.x + Math.round((a.width - NORMAL_SIZE.width) / 2),
      y: a.y + Math.round((a.height - NORMAL_SIZE.height) / 2),
      ...NORMAL_SIZE
    },
    a
  );
}

/* ------------------------------------------------------------------ */
/* 图标                                                                */
/* ------------------------------------------------------------------ */

/**
 * 优先使用打包时随附的 build/icon.png（多尺寸、带抗锯齿）。
 * 找不到时回退到代码绘制的位图，保证任何环境都能显示托盘图标。
 */
let cachedIcon = null;

function appIcon(size) {
  if (!cachedIcon) {
    const candidates = [
      path.join(__dirname, "build", "icon.png"),
      path.join(process.resourcesPath || "", "build", "icon.png"),
      path.join(__dirname, "icon.png")
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          const img = nativeImage.createFromPath(p);
          if (!img.isEmpty()) {
            cachedIcon = img;
            break;
          }
        }
      } catch (err) {
        /* 继续尝试下一个候选路径 */
      }
    }
    if (!cachedIcon) cachedIcon = buildFallbackIcon(256);
  }
  return size && size !== cachedIcon.getSize().width
    ? cachedIcon.resize({ width: size, height: size })
    : cachedIcon;
}

function buildFallbackIcon(size) {
  const mask = [
    "0000000000000000",
    "0001111111110000",
    "0010000000001000",
    "0100000000000100",
    "0100000000000100",
    "0100000000000100",
    "0100000000110100",
    "0100000000010100",
    "0100000000010100",
    "0100000000110100",
    "0100000011000100",
    "0100000110000100",
    "0100001100000100",
    "0100011000000100",
    "0010000000001000",
    "0001111111110000"
  ];

  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = mask[Math.floor((y / size) * 16)][Math.floor((x / size) * 16)] === "1";
      const i = (y * size + x) * 4;
      if (on) {
        buf[i] = 0xff;      // B
        buf[i + 1] = 0x8d;  // G
        buf[i + 2] = 0x4d;  // R
        buf[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

const isFloating = () => state.mode !== "normal";

function rememberBounds() {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
  const b = win.getBounds();
  if (isFloating()) state.floatBounds = b;
  else state.normalBounds = b;
}

function createWindow() {
  const floating = isFloating();

  const saved = floating ? state.floatBounds : state.normalBounds;
  const bounds = isOnScreen(saved)
    ? clampToArea(saved, workAreaFor(saved))
    : floating ? defaultFloatBounds() : defaultNormalBounds();

  const created = new BrowserWindow({
    ...bounds,
    minWidth: floating ? MIN_FLOAT.width : MIN_NORMAL.width,
    minHeight: floating ? MIN_FLOAT.height : MIN_NORMAL.height,
    frame: !floating,
    transparent: floating,
    backgroundColor: floating ? "#00000000" : "#0B0D11",
    resizable: true,
    maximizable: !floating,
    fullscreenable: !floating,
    skipTaskbar: floating,
    alwaysOnTop: floating && state.alwaysOnTop !== false,
    hasShadow: !floating,
    show: false,
    title: APP_NAME,
    icon: appIcon(256),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  });

  win = created;

  if (floating) {
    created.setAlwaysOnTop(state.alwaysOnTop !== false, "floating");
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    created.setAlwaysOnTop(false);
  }

  const op = Number(state.opacity);
  created.setOpacity(Number.isFinite(op) ? Math.min(1, Math.max(0.4, op)) : 1);

  created.loadFile(path.join(__dirname, "renderer", "index.html"));

  created.once("ready-to-show", () => {
    if (created.isDestroyed()) return;
    // 开机自启时不抢焦点、不弹窗，静默驻留托盘
    if (!startHidden) {
      created.show();
      created.focus();
    }
    startHidden = false;
    pushState();
    refreshTrayMenu();
  });

  const persist = debounce(() => {
    rememberBounds();
    writeState();
  }, 320);

  created.on("move", () => {
    snapToEdges(created);
    persist();
  });
  created.on("resize", persist);

  created.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    created.hide();
    if (!tray) createTray();
    refreshTrayMenu();
    pushState();
  });

  created.on("closed", () => {
    // 仅在确实是自己时清空引用，避免切换模式时误伤新窗口
    if (win === created) win = null;
  });

  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  created.webContents.on("did-finish-load", () => {
    refreshTrayMenu();
    pushState();
  });

  return created;
}

/** 悬浮模式下靠近屏幕边缘自动吸附 */
function snapToEdges(w) {
  if (!w || w.isDestroyed() || !isFloating()) return;
  if (w.isMaximized() || w.isFullScreen()) return;

  const b = w.getBounds();
  const a = workAreaFor(b);
  let { x, y } = b;
  let changed = false;

  if (Math.abs(b.x - a.x) < SNAP_THRESHOLD) { x = a.x; changed = true; }
  else if (Math.abs(a.x + a.width - (b.x + b.width)) < SNAP_THRESHOLD) {
    x = a.x + a.width - b.width;
    changed = true;
  }

  if (Math.abs(b.y - a.y) < SNAP_THRESHOLD) { y = a.y; changed = true; }
  else if (Math.abs(a.y + a.height - (b.y + b.height)) < SNAP_THRESHOLD) {
    y = a.y + a.height - b.height;
    changed = true;
  }

  if (changed) {
    w.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  }
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("app:state", {
    mode: isFloating() ? "floating" : "normal",
    alwaysOnTop: isFloating() ? win.isAlwaysOnTop() : false,
    opacity: win.getOpacity(),
    visible: win.isVisible()
  });
}

/** 在悬浮 / 普通模式之间切换：记录旧几何 → 销毁 → 按新模式重建 */
function switchMode(nextMode) {
  const target = nextMode === "normal" ? "normal" : "floating";
  if (target === (isFloating() ? "floating" : "normal")) {
    pushState();
    return;
  }

  rememberBounds();
  state.mode = target;
  writeState();

  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }

  const old = win;
  win = null;

  // 解除 close 拦截，否则 destroy 仍会触发隐藏逻辑
  old.removeAllListeners("close");
  old.destroy();

  createWindow();
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(appIcon(16));
    tray.setToolTip(APP_NAME);
    refreshTrayMenu();
    tray.on("click", toggleVisibility);
  } catch (err) {
    tray = null;
  }
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  refreshTrayMenu();
  pushState();
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  const floating = isFloating();
  const visible = !!win && !win.isDestroyed() && win.isVisible();
  const pinned = !!win && !win.isDestroyed() && win.isAlwaysOnTop();

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? "隐藏窗口" : "显示窗口",
        click: toggleVisibility
      },
      {
        label: "退出悬浮（普通窗口）",
        type: "checkbox",
        checked: floating,
        click: () => {
          switchMode(floating ? "normal" : "floating");
          setTimeout(() => {
            if (!win || win.isDestroyed()) return;
            win.show();
            win.focus();
            refreshTrayMenu();
            pushState();
          }, 300);
        }
      },
      {
        label: "始终置顶",
        type: "checkbox",
        checked: floating && pinned,
        enabled: floating,
        click: () => {
          if (!win || win.isDestroyed()) return;
          const next = !win.isAlwaysOnTop();
          win.setAlwaysOnTop(next, "floating");
          state.alwaysOnTop = next;
          writeState();
          refreshTrayMenu();
          pushState();
        }
      },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    mode: isFloating() ? "floating" : "normal",
    alwaysOnTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : false,
    opacity: win && !win.isDestroyed() ? win.getOpacity() : 1,
    visible: !!win && !win.isDestroyed() && win.isVisible()
  }));

  ipcMain.handle("app:set-mode", (_e, mode) => {
    switchMode(mode);
    return true;
  });

  ipcMain.handle("app:set-always-on-top", (_e, value) => {
    if (!win || win.isDestroyed()) return false;
    const next = Boolean(value);
    win.setAlwaysOnTop(next, isFloating() ? "floating" : "normal");
    if (isFloating()) {
      state.alwaysOnTop = next;
      writeState();
    }
    refreshTrayMenu();
    pushState();
    return next;
  });

  ipcMain.handle("app:set-opacity", (_e, value) => {
    if (!win || win.isDestroyed()) return 1;
    const v = Math.min(1, Math.max(0.4, Number(value) || 1));
    win.setOpacity(v);
    state.opacity = v;
    writeState();
    return v;
  });

  ipcMain.handle("app:hide", () => {
    if (win && !win.isDestroyed()) win.hide();
    if (!tray) createTray();
    refreshTrayMenu();
    return true;
  });

  ipcMain.handle("app:minimize", () => {
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });

  ipcMain.handle("app:quit", () => {
    quitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle("win:get-bounds", () => {
    if (!win || win.isDestroyed()) return null;
    return win.getBounds();
  });

  ipcMain.handle("app:get-auto-launch", () => {
    if (process.platform !== "win32") return false;
    try {
      const opts = app.isPackaged
        ? { path: process.execPath, args: ["--autostart"] }
        : { path: process.execPath, args: [path.resolve(__dirname), "--autostart"] };
      return app.getLoginItemSettings(opts).openAtLogin;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle("app:set-auto-launch", (_e, enabled) => {
    if (process.platform !== "win32") return false;
    try {
      // 安装版直接指向 exe；开发态指向 electron 并带上项目目录
      const isPackaged = app.isPackaged;
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: process.execPath,
        args: isPackaged ? ["--autostart"] : [path.resolve(__dirname), "--autostart"]
      });
      const check = app.isPackaged
        ? { path: process.execPath, args: ["--autostart"] }
        : { path: process.execPath, args: [path.resolve(__dirname), "--autostart"] };
      return app.getLoginItemSettings(check).openAtLogin;
    } catch (err) {
      return false;
    }
  });

  // 自定义缩放手柄（悬浮模式底部右下角）
  ipcMain.on("win:resize-by", (_e, dw, dh) => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isFullScreen()) return;

    const b = win.getBounds();
    const minW = isFloating() ? MIN_FLOAT.width : MIN_NORMAL.width;
    const minH = isFloating() ? MIN_FLOAT.height : MIN_NORMAL.height;
    const a = workAreaFor(b);

    const width = Math.max(minW, Math.min(b.width + Math.round(dw), a.x + a.width - b.x));
    const height = Math.max(minH, Math.min(b.height + Math.round(dh), a.y + a.height - b.y));

    win.setBounds({ x: b.x, y: b.y, width, height });
  });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  if (process.platform === "win32") app.setAppUserModelId("com.xiaozhao.todaytodo");

  app.whenReady().then(() => {
    readState();
    registerIpc();
    createWindow();
    createTray();

    // 拔掉副屏后把窗口拉回主屏可见区域
    screen.on("display-removed", () => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      if (!isOnScreen(b)) {
        win.setBounds(clampToArea(b, screen.getPrimaryDisplay().workArea));
      }
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    rememberBounds();
    writeState();
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return;
    if (quitting) app.quit();
  });

  app.on("activate", () => {
    if (!win || win.isDestroyed()) createWindow();
    else win.show();
  });
}
