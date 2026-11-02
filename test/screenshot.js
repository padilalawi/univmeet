'use strict';
// Ambil screenshot landing + ruang rapat (2 peserta) untuk verifikasi visual.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const CDP_PORT = 9335;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-shot-profile');
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break; } catch (_) {}
    await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const rid = ++id; pend.set(rid, { resolve, reject }); const pl = { id: rid, method, params }; if (sessionId) pl.sessionId = sessionId; ws.send(JSON.stringify(pl)); });

  async function newPage(w = 1440, h = 900, mobile = false) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile,
    }, sessionId);
    return {
      goto: async (u, t = 1400) => { await send('Page.navigate', { url: u }, sessionId); await sleep(t); },
      ev: async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      },
      shot: async (name) => {
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
        const p = path.join(OUT, name);
        fs.writeFileSync(p, Buffer.from(data, 'base64'));
        return p;
      },
    };
  }

  const A = await newPage();
  await A.goto(`${BASE}/`);
  await A.ev(`localStorage.clear()`);
  await A.goto(`${BASE}/`);
  await sleep(600);
  console.log('shot:', await A.shot('01-landing.png'));

  await A.ev(`(()=>{document.getElementById('in-name').value='Robi';document.getElementById('btn-create').click();return 1})()`);
  await sleep(4000);
  const code = (await A.ev(`location.pathname`)).replace('/r/', '');

  const B = await newPage();
  await B.goto(`${BASE}/`);
  await B.ev(`localStorage.clear()`);
  await B.goto(`${BASE}/r/${code}`);
  await sleep(700);
  await B.ev(`(()=>{document.getElementById('in-name').value='Tamu Undangan';document.getElementById('btn-join').click();return 1})()`);
  await sleep(7000);

  // chat biar panel kelihatan isi
  await B.ev(`(()=>{const i=document.getElementById('chat-input');i.value='Halo, sudah bisa lihat layar saya?';document.getElementById('chat-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return 1})()`);
  await sleep(800);
  await A.ev(`document.getElementById('btn-chat').click()`);
  await sleep(900);
  console.log('shot:', await A.shot('02-room-2peserta.png'));

  // tampilan peserta
  console.log('shot:', await B.shot('03-room-peserta.png'));

  // mobile
  const M = await newPage(390, 844, true);
  await M.goto(`${BASE}/`);
  await M.ev(`localStorage.clear()`);
  await M.goto(`${BASE}/`);
  await sleep(700);
  console.log('shot:', await M.shot('04-mobile-landing.png'));

  ws.close(); chrome.kill();
  await sleep(300);
  process.exit(0);
})();
