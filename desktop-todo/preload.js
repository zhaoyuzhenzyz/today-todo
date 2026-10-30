"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * 渲染层可用的受限 API。
 * 不暴露 Node，不暴露 ipcRenderer 原始对象。
 */
contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,

  getState: () => ipcRenderer.invoke("app:get-state"),
  setMode: (mode) => ipcRenderer.invoke("app:set-mode", mode),
  setAlwaysOnTop: (v) => ipcRenderer.invoke("app:set-always-on-top", v),
  setOpacity: (v) => ipcRenderer.invoke("app:set-opacity", v),
  hide: () => ipcRenderer.invoke("app:hide"),
  minimize: () => ipcRenderer.invoke("app:minimize"),
  quit: () => ipcRenderer.invoke("app:quit"),

  getBounds: () => ipcRenderer.invoke("win:get-bounds"),
  getAutoLaunch: () => ipcRenderer.invoke("app:get-auto-launch"),
  setAutoLaunch: (v) => ipcRenderer.invoke("app:set-auto-launch", v),
  moveBy: (dx, dy) => ipcRenderer.send("win:move-by", dx, dy),
  resizeBy: (dw, dh) => ipcRenderer.send("win:resize-by", dw, dh),
  snap: () => ipcRenderer.send("win:snap"),

  onState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("app:state", handler);
    return () => ipcRenderer.removeListener("app:state", handler);
  }
});
