'use strict';
// Verifikasi: (1) share layar normal masih jalan, (2) kalau izin ditolak -> modal diagnosa muncul.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.BASE_URL || 'https://univmeet.pages.dev';
const CDP_PORT = 9337;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-modal-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
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

  const out = { ok: false };
  try {
    const A = await newPage();
    await A.goto(`${BASE}/`);
    await A.ev(`localStorage.clear()`);
    await A.goto(`${BASE}/`);
    await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
    await sleep(4000);

    // cek versi script yang termuat (pastikan bukan cache lama)
    out.scriptVersion = await A.ev(`[...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src'))`);

    // (1) normal
    await A.ev(`document.getElementById('btn-screen').click()`);
    await sleep(3500);
    out.normal = await A.ev(`(()=>{const S=window.__univmeet;return {screen:!!S.screenStream, modal:!!document.getElementById('screen-fail')};})()`);

    // stop dulu
    await A.ev(`document.getElementById('btn-screen').click()`);
    await sleep(1500);

    // (2) paksa gagal: getDisplayMedia throw NotAllowedError
    out.denied = await A.ev(`(async () => {
      const orig = navigator.mediaDevices.getDisplayMedia;
      navigator.mediaDevices.getDisplayMedia = async () => { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; };
      document.getElementById('btn-screen').click();
      await new Promise(r => setTimeout(r, 1500));
      const m = document.getElementById('screen-fail');
      const res = {
        modal: !!m,
        title: m ? m.querySelector('h3').textContent : null,
        sub: m ? m.querySelector('.sf-sub').textContent : null,
        reasons: m ? [...m.querySelectorAll('.sf-reasons li')].map(li => li.textContent) : [],
        steps: m ? [...m.querySelectorAll('.sf-steps li')].length : 0,
        hasCopy: !!(m && m.querySelector('#sf-copy')),
        hasClose: !!(m && m.querySelector('#sf-close')),
      };
      navigator.mediaDevices.getDisplayMedia = orig;
      return res;
    })()`);

    // tutup modal
    out.closed = await A.ev(`(()=>{const b=document.querySelector('#sf-close'); if(b){b.click(); return !document.getElementById('screen-fail');} return false;})()`);

    out.verdict = {
      'share normal jalan': out.normal.screen === true,
      'normal tidak memunculkan modal': out.normal.modal === false,
      'izin ditolak -> modal muncul': out.denied.modal === true,
      'modal sebut NotAllowedError': /NotAllowedError/.test(out.denied.sub || ''),
      'modal kasih alasan': (out.denied.reasons || []).length > 0,
      'modal kasih langkah benerin': out.denied.steps >= 3,
      'tombol copy & tutup ada': out.denied.hasCopy && out.denied.hasClose,
      'modal bisa ditutup': out.closed === true,
      'script versi baru termuat': (out.scriptVersion || []).some(s => /v=3/.test(s)),
    };
    out.ok = Object.values(out.verdict).every(Boolean);
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  } finally {
    console.log(JSON.stringify(out, null, 2));
    try { ws.close(); } catch (_) {}
    chrome.kill();
    await sleep(400);
    process.exit(out.ok ? 0 : 1);
  }
})();
