/**
 * 编辑功能专项测试
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const ROOT = path.resolve(__dirname, "..", "desktop-todo");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PORT = 9251;
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
  const ud = path.join(os.tmpdir(), "tt-edit-" + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_PATH;

  const child = spawn(ELECTRON, [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`,
    "--disable-gpu", "--disable-gpu-compositing", "--no-sandbox"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env
  });
  let out = "";
  child.stdout.on("data", (d) => out += d);
  child.stderr.on("data", (d) => out += d);

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(350);
      try { await getJson(`http://127.0.0.1:${PORT}/json/list`); ready = true; break; } catch (e) {}
    }
    if (!ready) throw new Error("启动失败\n" + out.slice(0, 800));

    let { ws, evl } = await connect();
    await sleep(1000);

    // 清空数据重载
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

    await add("原始标题一");
    await add("原始标题二");

    const taskTexts = () => evl("return [...document.querySelectorAll('li.item .task')].map(n=>n.textContent).join('|');");
    const stored = () => evl("return JSON.parse(localStorage.getItem('today-todo.items.v1')||'[]').map(i=>i.text).join('|');");

    /* ---------- 1. 结构 ---------- */
    ck("每行有编辑按钮", (await evl("return document.querySelectorAll('li.item .edit-btn').length;")) === 2);
    ck("编辑按钮有 aria-label",
      (await evl("return document.querySelector('.edit-btn').getAttribute('aria-label');")).startsWith("编辑"));
    ck("标题标注双击可编辑",
      (await evl("return document.querySelector('.task').title;")) === "双击编辑");
    ck("标题可键盘聚焦",
      (await evl("return document.querySelector('.task').getAttribute('tabindex');")) === "0");

    /* ---------- 2. 点击铅笔按钮进入编辑 ---------- */
    await evl("document.querySelector('li.item .edit-btn').click(); return 1;");
    await sleep(250);
    ck("点击按钮进入编辑态",
      (await evl("return document.querySelector('li.item').classList.contains('editing');")) === true);
    ck("出现编辑输入框",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("输入框预填原文本",
      (await evl("return document.querySelector('.edit-input').value;")) === "原始标题二",
      await evl("return document.querySelector('.edit-input').value;"));
    ck("编辑时标题被隐藏",
      (await evl("return getComputedStyle(document.querySelector('li.item.editing .task')).display;")) === "none");

    /* ---------- 3. 回车保存 ---------- */
    await evl(`var i=document.querySelector('.edit-input');
      i.value='修改后的标题二';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return 1;`);
    await sleep(300);
    ck("回车后退出编辑态",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 0);
    ck("标题已更新", (await taskTexts()).includes("修改后的标题二"), await taskTexts());
    ck("数据已持久化", (await stored()).includes("修改后的标题二"), await stored());
    ck("编辑后行数不变", (await evl("return document.querySelectorAll('li.item').length;")) === 2);

    /* ---------- 4. 双击进入编辑 ---------- */
    await evl(`var t=document.querySelectorAll('li.item .task')[1];
      t.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1;`);
    await sleep(250);
    ck("双击标题进入编辑",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("双击的是正确那一行",
      (await evl("return document.querySelector('.edit-input').value;")) === "原始标题一",
      await evl("return document.querySelector('.edit-input').value;"));

    /* ---------- 5. Esc 取消不保存 ---------- */
    await evl(`var i=document.querySelector('.edit-input');
      i.value='不该保存的内容';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      return 1;`);
    await sleep(350);
    ck("Esc 退出编辑态",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 0);
    ck("Esc 放弃修改", (await taskTexts()).includes("原始标题一") && !(await taskTexts()).includes("不该保存的内容"),
      await taskTexts());
    ck("Esc 未隐藏窗口",
      (await evl("return window.desktop.getState();")).visible === true);

    /* ---------- 6. 内容不变不产生脏写 ---------- */
    const beforeSame = await stored();
    await evl("document.querySelectorAll('li.item .edit-btn')[1].click(); return 1;");
    await sleep(220);
    await evl(`var i=document.querySelector('.edit-input');
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(300);
    ck("内容未改则数据保持一致", (await stored()) === beforeSame);

    /* ---------- 7. 首尾空格裁剪 ---------- */
    await evl("document.querySelectorAll('li.item .edit-btn')[1].click(); return 1;");
    await sleep(220);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='   带空格新标题   ';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(320);
    ck("编辑内容首尾空格被裁剪",
      (await taskTexts()).includes("带空格新标题"), await taskTexts());

    /* ---------- 8. 清空内容等于删除 ---------- */
    const beforeDel = await evl("return document.querySelectorAll('li.item').length;");
    await evl("document.querySelectorAll('li.item .edit-btn')[1].click(); return 1;");
    await sleep(220);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='   ';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(450);
    ck("清空内容则删除该条",
      (await evl("return document.querySelectorAll('li.item').length;")) === beforeDel - 1,
      beforeDel + " -> " + (await evl("return document.querySelectorAll('li.item').length;")));

    /* ---------- 9. 同时只能一处编辑 ---------- */
    await add("第三条测试");
    await sleep(200);
    await evl("document.querySelectorAll('li.item .edit-btn')[1].click(); return 1;");
    await sleep(220);
    await evl(`var i=document.querySelector('.edit-input'); i.value='第一处改动'; return 1;`);
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(320);
    ck("切换编辑时只保留一个输入框",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 1,
      "count=" + (await evl("return document.querySelectorAll('.edit-input').length;")));
    ck("前一处的改动被自动提交", (await taskTexts()).includes("第一处改动"), await taskTexts());

    // 收尾退出
    await evl(`var i=document.querySelector('.edit-input');
      if(i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      return 1;`);
    await sleep(300);

    /* ---------- 10. 勾选态仍可编辑 ---------- */
    await evl("document.querySelector('.check').click(); return 1;");
    await sleep(300);
    ck("任务已标记完成", (await evl("return document.querySelector('li.item').classList.contains('done');")) === true);
    await evl("document.querySelector('.edit-btn').click(); return 1;");
    await sleep(250);
    ck("已完成任务也能编辑",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    await evl(`var i=document.querySelector('.edit-input'); i.value='完成态改名';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(320);
    ck("完成态改名生效且保持完成",
      (await evl("return document.querySelector('li.item').classList.contains('done');")) === true &&
      (await taskTexts()).includes("完成态改名"),
      await taskTexts());

    /* ---------- 11. 刷新后仍保留 ---------- */
    const expect = await stored();
    await evl("location.reload(); return 1;");
    await sleep(1500);
    ws.close();
    ({ ws, evl } = await connect());
    await sleep(800);
    ck("刷新后修改仍在", (await stored()) === expect, await stored());

    /* ---------- 12. 无异常 ---------- */
    ck("无运行时异常", !/Uncaught|TypeError|ReferenceError/i.test(out), out.slice(0, 300));

    ws.close();
  } catch (err) {
    fail.push("执行异常: " + err.message);
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("\n===== 编辑功能测试 =====");
  console.log("PASS " + pass.length + " / FAIL " + fail.length + "\n");
  pass.forEach((p) => console.log("  ok   " + p));
  fail.forEach((f) => console.log("  FAIL " + f));
  process.exit(fail.length ? 1 : 0);
})();
