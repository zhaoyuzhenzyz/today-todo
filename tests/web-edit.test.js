/**
 * 浏览器版编辑功能测试（Edge headless + CDP）
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const DIR = path.resolve(__dirname, "..");
const PAGE = "file:///" + DIR + "/today-todo.html";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9261;
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
  const page = list.find((t) => t.type === "page" && t.url.indexOf("today-todo") !== -1)
            || list.find((t) => t.type === "page");
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
  const ud = path.join(os.tmpdir(), "edge-edit-" + Date.now());
  fs.mkdirSync(ud, { recursive: true });
  const child = spawn(EDGE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${ud}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=900,900",
    PAGE
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => out += d);
  child.stderr.on("data", (d) => out += d);

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try { await getJson(`http://127.0.0.1:${PORT}/json/list`); ready = true; break; } catch (e) {}
    }
    if (!ready) throw new Error("Edge 启动失败\n" + out.slice(0, 800));

    let { ws, evl } = await connect();
    await sleep(900);

    await evl("localStorage.clear(); location.reload(); return 1;");
    await sleep(1200);
    ws.close();
    ({ ws, evl } = await connect());
    await sleep(600);

    const add = async (t) => {
      await evl(`document.getElementById('input').value=${JSON.stringify(t)};
        document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1;`);
      await sleep(160);
    };
    const taskTexts = () => evl("return [...document.querySelectorAll('li.item .task')].map(n=>n.textContent).join('|');");
    const stored = () => evl("return JSON.parse(localStorage.getItem('today-todo.v1')||'[]').map(i=>i.text).join('|');");

    await add("原始甲");
    await add("原始乙");

    /* 1 结构 */
    ck("每行有编辑按钮", (await evl("return document.querySelectorAll('li.item .edit-btn').length;")) === 2);
    ck("编辑按钮有 aria-label",
      (await evl("return document.querySelector('.edit-btn').getAttribute('aria-label');")).startsWith("编辑"));
    ck("标题标注双击可编辑",
      (await evl("return document.querySelector('.task').title;")) === "双击编辑");
    ck("标题可键盘聚焦",
      (await evl("return document.querySelector('.task').getAttribute('tabindex');")) === "0");
    ck("铅笔图标已渲染",
      (await evl("return document.querySelectorAll('.edit-btn svg path').length;")) === 4,
      "path=" + (await evl("return document.querySelectorAll('.edit-btn svg path').length;")));

    /* 2 铅笔进入编辑 */
    await evl("document.querySelector('li.item .edit-btn').click(); return 1;");
    await sleep(220);
    ck("点击按钮进入编辑态",
      (await evl("return document.querySelector('li.item').classList.contains('editing');")) === true);
    ck("出现编辑输入框", (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("输入框预填原文本",
      (await evl("return document.querySelector('.edit-input').value;")) === "原始乙",
      await evl("return document.querySelector('.edit-input').value;"));
    ck("编辑时标题被隐藏",
      (await evl("return getComputedStyle(document.querySelector('li.item.editing .task')).display;")) === "none");
    ck("编辑时删除按钮被隐藏",
      (await evl("return getComputedStyle(document.querySelector('li.item.editing .del')).display;")) === "none");

    /* 3 回车保存 */
    await evl(`var i=document.querySelector('.edit-input');
      i.value='改后的乙';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(280);
    ck("回车后退出编辑态", (await evl("return document.querySelectorAll('.edit-input').length;")) === 0);
    ck("标题已更新", (await taskTexts()).includes("改后的乙"), await taskTexts());
    ck("数据已持久化", (await stored()).includes("改后的乙"), await stored());
    ck("编辑后行数不变", (await evl("return document.querySelectorAll('li.item').length;")) === 2);

    /* 4 双击进入 */
    await evl(`var t=document.querySelectorAll('li.item .task')[1];
      t.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1;`);
    await sleep(220);
    ck("双击标题进入编辑", (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("双击的是正确那一行",
      (await evl("return document.querySelector('.edit-input').value;")) === "原始甲",
      await evl("return document.querySelector('.edit-input').value;"));

    /* 5 Esc 取消 */
    await evl(`var i=document.querySelector('.edit-input');
      i.value='不该保存';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return 1;`);
    await sleep(300);
    ck("Esc 退出编辑态", (await evl("return document.querySelectorAll('.edit-input').length;")) === 0);
    ck("Esc 放弃修改",
      (await taskTexts()).includes("原始甲") && !(await taskTexts()).includes("不该保存"), await taskTexts());

    /* 6 无脏写 */
    const before = await stored();
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(200);
    await evl(`var i=document.querySelector('.edit-input');
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(260);
    ck("内容未改则数据一致", (await stored()) === before);
    ck("空操作后行数不变", (await evl("return document.querySelectorAll('li.item').length;")) === 2);

    /* 7 空格裁剪 */
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(200);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='   带空格   ';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(300);
    ck("首尾空格被裁剪", (await taskTexts()).includes("带空格"), await taskTexts());

    /* 8 清空即删除 */
    const n0 = await evl("return document.querySelectorAll('li.item').length;");
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(200);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='  ';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(500);
    const n1 = await evl("return document.querySelectorAll('li.item').length;");
    ck("清空内容则删除该条", n1 === n0 - 1, n0 + " -> " + n1);

    /* 9 单编辑态 */
    await add("第三条");
    await sleep(180);
    await evl("document.querySelectorAll('li.item .edit-btn')[1].click(); return 1;");
    await sleep(200);
    await evl("document.querySelector('.edit-input').value='第一处改动'; return 1;");
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(300);
    ck("切换编辑只保留一个输入框",
      (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    ck("前一处改动被自动提交", (await taskTexts()).includes("第一处改动"), await taskTexts());
    await evl(`var i=document.querySelector('.edit-input');
      if(i) i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return 1;`);
    await sleep(260);

    /* 10 完成态可编辑 */
    await evl("document.querySelector('.check').click(); return 1;");
    await sleep(280);
    ck("任务已标记完成",
      (await evl("return document.querySelector('li.item').classList.contains('done');")) === true);
    await evl("document.querySelector('.edit-btn').click(); return 1;");
    await sleep(220);
    ck("已完成任务也能编辑", (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='完成态改名';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(300);
    ck("完成态改名生效且保持完成",
      (await evl("return document.querySelector('li.item').classList.contains('done');")) === true &&
      (await taskTexts()).includes("完成态改名"), await taskTexts());

    /* 11 刷新保留 */
    const expect = await stored();
    await evl("location.reload(); return 1;");
    await sleep(1400);
    ws.close();
    ({ ws, evl } = await connect());
    await sleep(700);
    ck("刷新后修改仍在", (await stored()) === expect, await stored());

    /* 12 筛选切换不丢改动 */
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(200);
    await evl(`var i=document.querySelector('.edit-input');
      if(i){ i.value='筛选前改动';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); } return 1;`);
    await sleep(280);
    await evl("document.querySelector('[data-filter=active]').click(); return 1;");
    await sleep(260);
    ck("切筛选后改动未丢", (await stored()).includes("筛选前改动"), await stored());
    await evl("document.querySelector('[data-filter=all]').click(); return 1;");
    await sleep(220);

    /* 13 超过 200 字被截断 */
    await evl("document.querySelectorAll('li.item .edit-btn')[0].click(); return 1;");
    await sleep(200);
    ck("编辑框限制 200 字",
      (await evl("return document.querySelector('.edit-input').maxLength;")) === 200);
    await evl(`var i=document.querySelector('.edit-input');
      i.value='x'.repeat(500);
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
    await sleep(300);
    const longLen = await evl("return (JSON.parse(localStorage.getItem('today-todo.v1'))[0].text||'').length;");
    ck("超长内容被截到 200 字", longLen === 200, "len=" + longLen);

    /* 14 无异常 */
    ck("无运行时异常", !/Uncaught|TypeError|ReferenceError/i.test(out), out.slice(0, 300));

    ws.close();
  } catch (err) {
    fail.push("执行异常: " + err.message);
  } finally {
    try { child.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }

  console.log("\n===== 浏览器版编辑功能测试 =====");
  console.log("PASS " + pass.length + " / FAIL " + fail.length + "\n");
  pass.forEach((p) => console.log("  ok   " + p));
  fail.forEach((f) => console.log("  FAIL " + f));
  process.exit(fail.length ? 1 : 0);
})();
