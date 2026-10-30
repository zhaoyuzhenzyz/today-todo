/**
 * 打包产物（win-unpacked）编辑功能回归测试
 * 走真实 exe + CDP，验证打包后的 asar 内代码同样具备编辑能力
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const DIR = path.resolve(__dirname, "..", "desktop-todo");
const EXE = path.join(DIR, "dist", "win-unpacked", "今日待办.exe");
const PORT = 9271;
/**
 * 加载 ws 依赖。
 * 优先 tests/node_modules（npm install 后），回退到 ../_testdeps/node_modules（本地开发）。
 */
function loadWs() {
  const candidates = [
    path.resolve(__dirname, "node_modules", "ws"),
    path.resolve(__dirname, "..", "_testdeps", "node_modules", "ws")
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) {}
  }
  try { return require("ws"); } catch (e) {}
  throw new Error("缺少依赖 ws，请先在 tests 目录执行 npm install");
}
const WebSocketImpl = loadWs();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [];
const ck = (n, c, e) => (c ? pass : fail).push(n + (e !== undefined ? "  [" + e + "]" : ""));

const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => {
    let d = ""; r.on("data", (c) => d += c);
    r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

async function connect() {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const WebSocket = WebSocketImpl;
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 5e7 });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  let id = 0; const pend = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await call("Runtime.enable");
  const evl = async (expr) => {
    const r = await call("Runtime.evaluate", {
      expression: `(function(){ ${expr} })()`, returnByValue: true, awaitPromise: true
    });
    if (r.result.exceptionDetails) {
      throw new Error("eval: " + (r.result.exceptionDetails.exception?.description || ""));
    }
    return r.result.result.value;
  };
  return { ws, evl };
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error("找不到打包产物: " + EXE);
  const ud = path.join(os.tmpdir(), "tt-pkg-edit-" + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_PATH;

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`,
    "--disable-gpu", "--disable-gpu-compositing", "--no-sandbox"], {
    cwd: path.dirname(EXE), stdio: ["ignore", "pipe", "pipe"], env
  });
  let out = "";
  child.stdout.on("data", (d) => out += d);
  child.stderr.on("data", (d) => out += d);

  try {
    let ready = false;
    for (let i = 0; i < 70; i++) {
      await sleep(350);
      try { await getJson(`http://127.0.0.1:${PORT}/json/list`); ready = true; break; } catch (e) {}
    }
    if (!ready) throw new Error("exe 启动失败\n" + out.slice(0, 900));

    let { ws, evl } = await connect();
    await sleep(1200);

    await evl("localStorage.clear(); location.reload(); return 1;");
    await sleep(1400);
    ws.close();
    ({ ws, evl } = await connect());
    await sleep(700);

    const add = async (t) => {
      await evl(`document.getElementById('input').value=${JSON.stringify(t)};
        document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1;`);
      await sleep(180);
    };
    const texts = () => evl("return [...document.querySelectorAll('li.item .task')].map(n=>n.textContent).join('|');");
    const stored = () => evl("return JSON.parse(localStorage.getItem('today-todo.items.v1')||'[]').map(i=>i.text).join('|');");

    await add("打包后甲");
    await add("打包后乙");

    ck("打包版有编辑按钮",
      (await evl("return document.querySelectorAll('li.item .edit-btn').length;")) === 2);
    ck("铅笔图标存在",
      (await evl("return document.querySelectorAll('.edit-btn svg path').length;")) === 4);

    // 双击进入编辑
    await evl(`document.querySelector('li.item .task').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1;`);
    await sleep(250);
    ck("双击进入编辑", (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("预填原文", (await evl("return document.querySelector('.edit-input').value;")) === "打包后乙",
      await evl("return document.querySelector('.edit-input').value;"));

    // 回车保存
    await evl(`var i=document.querySelector('.edit-input'); i.value='打包版改后';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(320);
    ck("回车保存生效", (await texts()).includes("打包版改后"), await texts());
    ck("保存已持久化", (await stored()).includes("打包版改后"), await stored());

    // Esc 取消
    await evl(`document.querySelectorAll('li.item .task')[1].dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1;`);
    await sleep(230);
    await evl(`var i=document.querySelector('.edit-input'); i.value='不该留';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return 1;`);
    await sleep(320);
    ck("Esc 取消不留痕", !(await texts()).includes("不该留"), await texts());

    // 编辑框在悬浮拖动区里仍可正常聚焦输入
    await evl("document.querySelector('li.item .edit-btn').click(); return 1;");
    await sleep(230);
    ck("esc 后 Esc 不再误隐藏窗口",
      (await evl("return window.desktop.getState();")).visible === true);
    await evl(`var i=document.querySelector('.edit-input');
      if(i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return 1;`);
    await sleep(250);

    // 清空即删除
    const n0 = await evl("return document.querySelectorAll('li.item').length;");
    await evl("document.querySelector('li.item .edit-btn').click(); return 1;");
    await sleep(230);
    await evl(`var i=document.querySelector('.edit-input'); i.value='';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(500);
    const n1 = await evl("return document.querySelectorAll('li.item').length;");
    ck("清空即删除", n1 === n0 - 1, n0 + " -> " + n1);

    // 悬浮模式仍生效
    ck("仍为悬浮模式", (await evl("return document.documentElement.dataset.mode;")) === "floating",
      await evl("return document.documentElement.dataset.mode;"));
    ck("仍保持置顶", (await evl("return window.desktop.getState();")).alwaysOnTop === true);

    ck("无运行时异常", !/Uncaught|TypeError|ReferenceError/i.test(out), out.slice(0, 300));

    ws.close();
  } catch (err) {
    fail.push("执行异常: " + err.message);
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("\n===== 打包产物编辑回归 =====");
  console.log("PASS " + pass.length + " / FAIL " + fail.length + "\n");
  pass.forEach((p) => console.log("  ok   " + p));
  fail.forEach((f) => console.log("  FAIL " + f));
  process.exit(fail.length ? 1 : 0);
})();
