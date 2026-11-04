'use strict';
// Debug: apakah setParameters benar-benar menerapkan maxBitrate?
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CDP_PORT = 9346;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-dbg-br');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
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

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    return {
      goto: async (u, w = 1300) => { await send('Page.navigate', { url: u }, sessionId); await sleep(w); },
      ev: async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
        return r.result.value;
      },
    };
  }

  const A = await newPage();
  await A.goto(`${BASE}/`);
  await A.ev(`localStorage.clear()`);
  await A.goto(`${BASE}/`);
  await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
  await sleep(4000);
  const code = (await A.ev(`location.pathname`)).replace('/r/', '');

  const B = await newPage();
  await B.goto(`${BASE}/`);
  await B.ev(`localStorage.clear()`);
  await B.goto(`${BASE}/r/${code}`);
  await sleep(700);
  await B.ev(`(()=>{document.getElementById('in-name').value='Tamu';document.getElementById('btn-join').click();return 1})()`);
  await sleep(7000);

  // coba set langsung di browser + baca balik
  const res = await A.ev(`(async () => {
    const S = window.__univmeet;
    const p = [...S.peers.values()][0];
    if (!p) return { err: 'no peer' };
    const snd = p.videoSender;
    const before = snd.getParameters();
    const log = [];
    // coba 1: seperti kode sekarang
    try {
      const prm = snd.getParameters();
      log.push({ step: 'encodings-count', value: (prm.encodings || []).length });
      if (prm.encodings && prm.encodings.length) {
        prm.encodings[0].maxBitrate = 1234000;
        await snd.setParameters(prm);
        log.push({ step: 'set 1234k', ok: true });
      } else {
        log.push({ step: 'set skipped: encodings kosong', ok: false });
      }
    } catch (e) {
      log.push({ step: 'set 1234k', ok: false, error: e.name + ': ' + e.message });
    }
    const after = snd.getParameters();
    // cek stats outbound
    const rep = await p.pc.getStats();
    let outb = null;
    rep.forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'video') outb = { bytes: s.bytesSent, targetBitrate: s.targetBitrate, qualityLimitationReason: s.qualityLimitationReason, frameWidth: s.frameWidth, frameHeight: s.frameHeight }; });
    return {
      beforeEnc: before.encodings ? before.encodings.map(e => ({ maxBitrate: e.maxBitrate, scale: e.scaleResolutionDownBy })) : null,
      afterEnc: after.encodings ? after.encodings.map(e => ({ maxBitrate: e.maxBitrate, scale: e.scaleResolutionDownBy })) : null,
      log, outbound: outb,
      tierNow: { peers: S.peers.size },
    };
  })()`);

  console.log(JSON.stringify(res, null, 2));
  ws.close(); chrome.kill();
  await sleep(300);
  process.exit(0);
})();
