/**
 * 安装包 v1.0.2 完整验证（PowerShell 驱动，避免 node spawn 的参数解析问题）
 * 静默安装 → 校验快捷方式与程序 → 启动并验证编辑功能 → 卸载彻底清理
 */
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const DIR = path.resolve(__dirname, "..", "desktop-todo");
const INSTALLER = path.join(DIR, "dist", "今日待办-安装程序-1.0.2.exe");
const PORT = 9281;
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

const DESKTOP = path.join(os.homedir(), "Desktop");
const STARTMENU = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Microsoft", "Windows", "Start Menu", "Programs");
const lnkDesktop = path.join(DESKTOP, "今日待办.lnk");
const lnkStart = path.join(STARTMENU, "今日待办.lnk");

/** 执行 PowerShell 脚本：写入临时 .ps1 后用 -File 运行，彻底规避命令行引号转义问题 */
let psSeq = 0;
function ps(script, timeout = 300000) {
  const f = path.join(os.tmpdir(), `_ps_${process.pid}_${++psSeq}.ps1`);
  fs.writeFileSync(f, "\uFEFF" + script, "utf8");
  try {
    return execFileSync("powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f],
      { encoding: "utf8", timeout }).trim();
  } finally {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

/**
 * 比较 .lnk 的目标与期望路径。
 * 不把中文路径经 stdout 传回（PS 输出为 GBK，node 按 UTF-8 解析会乱码），
 * 让 PowerShell 就地比对并只返回 BOOL / 纯 ASCII 结论。
 */
function lnkMatches(lnk, expectExe, expectWd) {
  const escLnk = lnk.replace(/'/g, "''");
  const escExe = expectExe.replace(/'/g, "''");
  const escWd = (expectWd || "").replace(/'/g, "''");
  const out = ps(
    `$s = New-Object -ComObject WScript.Shell\n` +
    `$l = $s.CreateShortcut('${escLnk}')\n` +
    `$t = $l.TargetPath\n` +
    `$w = $l.WorkingDirectory.TrimEnd('\\')\n` +
    `$i = $l.IconLocation\n` +
    `$te = ('${escExe}'.TrimEnd('\\'))\n` +
    `Write-Output ("TARGET_EQ=" + [int]($t.TrimEnd('\\') -ieq $te))\n` +
    `Write-Output ("WD_EQ=" + [int]($w -ieq '${escWd}'))\n` +
    `Write-Output ("ICON_OK=" + [int]($i -and $i.Length -gt 0))\n` +
    `Write-Output ("EXE_NAME=" + [int]($t -like '*.exe'))\n` +
    `Write-Output ("LEN=" + $t.Length)`
  );
  const res = { targetEq: false, wdEq: false, iconOk: false, exeName: false, len: 0 };
  out.split(/\r?\n/).forEach((line) => {
    const [k, v] = line.split("=");
    if (k === "TARGET_EQ") res.targetEq = v === "1";
    else if (k === "WD_EQ") res.wdEq = v === "1";
    else if (k === "ICON_OK") res.iconOk = v === "1";
    else if (k === "EXE_NAME") res.exeName = v === "1";
    else if (k === "LEN") res.len = parseInt(v, 10) || 0;
  });
  return res;
}

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
    if (r.result.exceptionDetails) throw new Error("eval: " + (r.result.exceptionDetails.exception?.description || ""));
    return r.result.result.value;
  };
  return { ws, evl };
}

(async () => {
  const stamp = Date.now();
  const installDir = `C:\\Temp\\tt-inst-${stamp}`;
  const installDirFs = `C:/Temp/tt-inst-${stamp}`;
  const exeInstalled = path.join(installDirFs, "今日待办.exe");

  if (!fs.existsSync(INSTALLER)) throw new Error("找不到安装包: " + INSTALLER);

  // 先清理旧快捷方式，确保检测到的是本次产生
  [lnkDesktop, lnkStart].forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });

  try {
    /* ---------- 1. 静默安装 ---------- */
    let instOut = "";
    try {
      instOut = ps(`$p = Start-Process -FilePath '${INSTALLER}' -ArgumentList "/S /D=${installDir}" -Wait -PassThru\n` +
        `Start-Sleep -Seconds 6\n` +
        `Write-Output ("EXIT=" + $p.ExitCode)`);
    } catch (e) { instOut = "ERR=" + e.message; }
    ck("静默安装退出码为 0", /EXIT=0/.test(instOut), instOut.slice(0, 120));

    /* ---------- 2. 安装目录 ---------- */
    ck("程序本体已安装到位", fs.existsSync(exeInstalled), exeInstalled);
    if (fs.existsSync(exeInstalled)) {
      const sz = fs.statSync(exeInstalled).size;
      ck("程序体积合理", sz > 100 * 1024 * 1024, (sz / 1048576).toFixed(0) + "MB");
      ck("resources/app.asar 存在", fs.existsSync(path.join(installDirFs, "resources", "app.asar")));
      ck("安装目录结构完整", fs.readdirSync(installDirFs).length >= 18,
        fs.readdirSync(installDirFs).length + " 项");
      ck("卸载程序已生成", fs.existsSync(path.join(installDirFs, "Uninstall 今日待办.exe")));
    }

    /* ---------- 3. 快捷方式 ---------- */
    ck("桌面快捷方式已创建", fs.existsSync(lnkDesktop), lnkDesktop);
    ck("开始菜单快捷方式已创建", fs.existsSync(lnkStart), lnkStart);

    if (fs.existsSync(lnkDesktop)) {
      const d = lnkMatches(lnkDesktop, exeInstalled, installDir);
      ck("桌面快捷方式指向安装目录 exe", d.targetEq);
      ck("桌面快捷方式目标是可执行文件", d.exeName && d.len > 10, "len=" + d.len);
      ck("桌面快捷方式工作目录正确", d.wdEq);
      ck("桌面快捷方式带图标设置", d.iconOk);
    }
    if (fs.existsSync(lnkStart)) {
      const s = lnkMatches(lnkStart, exeInstalled, installDir);
      ck("开始菜单快捷方式指向同一 exe", s.targetEq);
    }

    /* ---------- 4. 启动安装版，验证编辑功能 ---------- */
    const ud = path.join(os.tmpdir(), "tt-inst-run-" + stamp);
    fs.mkdirSync(ud, { recursive: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_PATH;

    const { spawn } = require("child_process");
    const child = spawn(exeInstalled, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`,
      "--disable-gpu", "--disable-gpu-compositing", "--no-sandbox"], {
      cwd: installDirFs, stdio: ["ignore", "pipe", "pipe"], env
    });
    let out = "";
    let spawnErr = "";
    child.on("error", (e) => { spawnErr = e.message; });
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => out += d);

    let ready = false;
    if (!spawnErr && fs.existsSync(exeInstalled)) {
      for (let i = 0; i < 70; i++) {
        await sleep(350);
        if (spawnErr) break;
        try { await getJson(`http://127.0.0.1:${PORT}/json/list`); ready = true; break; } catch (e) {}
      }
    }
    ck("安装版可正常启动", ready, spawnErr || out.slice(0, 150));

    if (ready) {
      let { ws, evl } = await connect();
      await sleep(1200);
      await evl("localStorage.clear(); location.reload(); return 1;");
      await sleep(1300);
      ws.close();
      ({ ws, evl } = await connect());
      await sleep(600);

      await evl(`document.getElementById('input').value='安装版验证';
        document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})); return 1;`);
      await sleep(260);

      ck("安装版存在编辑按钮",
        (await evl("return document.querySelectorAll('.edit-btn').length;")) === 1);

      await evl(`document.querySelector('li.item .task').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 1;`);
      await sleep(240);
      ck("安装版可双击进入编辑",
        (await evl("return document.querySelectorAll('.edit-input').length;")) === 1);

      await evl(`var i=document.querySelector('.edit-input'); i.value='安装版改后';
        i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return 1;`);
      await sleep(330);
      ck("安装版编辑保存成功",
        (await evl("return document.querySelector('li.item .task').textContent;")) === "安装版改后",
        await evl("return document.querySelector('li.item .task').textContent;"));
      ck("安装版编辑已持久化",
        (await evl("return JSON.parse(localStorage.getItem('today-todo.items.v1')||'[]')[0].text;")) === "安装版改后");
      ck("安装版默认悬浮模式",
        (await evl("return document.documentElement.dataset.mode;")) === "floating");
      ck("安装版默认置顶",
        (await evl("return window.desktop.getState();")).alwaysOnTop === true);

      ws.close();
    }
    try { child.kill(); } catch (e) {}
    await sleep(900);
    try { execFileSync("taskkill", ["/F", "/IM", "今日待办.exe"], { stdio: "ignore" }); } catch (e) {}

    /* ---------- 5. 卸载（不带 _?=，与用户从控制面板卸载一致） ---------- */
    const uninstaller = path.join(installDirFs, "Uninstall 今日待办.exe");
    ck("卸载程序存在", fs.existsSync(uninstaller), uninstaller);

    if (fs.existsSync(uninstaller)) {
      let uOut = "";
      try {
        uOut = ps(`$p = Start-Process -FilePath '${uninstaller}' -ArgumentList "/S" -Wait -PassThru\n` +
          `Start-Sleep -Seconds 12\n` +
          `Write-Output ("EXIT=" + $p.ExitCode)`);
      } catch (e) { uOut = "ERR=" + e.message; }
      ck("静默卸载退出码为 0", /EXIT=0/.test(uOut), uOut.slice(0, 120));

      ck("卸载后程序本体已移除", !fs.existsSync(exeInstalled));
      ck("卸载后桌面快捷方式已移除", !fs.existsSync(lnkDesktop));
      ck("卸载后开始菜单项已移除", !fs.existsSync(lnkStart));

      let remaining = [];
      try { remaining = fs.readdirSync(installDirFs); } catch (e) { remaining = []; }
      ck("卸载后安装目录彻底清空",
        !fs.existsSync(installDirFs) || remaining.length === 0,
        remaining.slice(0, 6).join(",") || "(目录已删)");
    }

    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  } catch (err) {
    fail.push("执行异常: " + err.message);
  } finally {
    try { execFileSync("taskkill", ["/F", "/IM", "今日待办.exe"], { stdio: "ignore" }); } catch (e) {}
    try { fs.rmSync(installDirFs, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync("C:/Temp/ttprobe", { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync("C:/Temp/ttprobe2", { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync("C:/Temp/ttprobe3", { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync("C:/Temp/ttprobe4", { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync("C:/Temp/ttprobe5", { recursive: true, force: true }); } catch (e) {}
  }

  console.log("\n===== 安装包 v1.0.2 完整验证 =====");
  console.log("PASS " + pass.length + " / FAIL " + fail.length + "\n");
  pass.forEach((p) => console.log("  ok   " + p));
  fail.forEach((f) => console.log("  FAIL " + f));
  process.exit(fail.length ? 1 : 0);
})();
