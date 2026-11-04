'use strict';

/**
 * Tes SKALA KUALITAS: bitrate harus turun otomatis saat peserta bertambah.
 * Juga memastikan semua peserta saling terhubung (mesh) dan tile muncul.
 *
 * Pakai:
 *   node test/quality-scale.js                  (lokal)
 *   BASE_URL=https://univmeet.pages.dev node test/quality-scale.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TABLES = Number(process.env.TABS || 4); // jumlah tab peserta
const CDP_PORT = 9345;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-quality');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAP = `(async () => {
  const S = window.__univmeet;
  const out = { peers: S.peers.size, maxPeers: S.maxPeers, bitrates: {}, badge: null, tiles: 0 };
  const p = [...S.peers.values()][0];
  if (p) {
    for (const [label, snd] of [['cam', p.videoSender], ['screen', p.screenSender], ['audio', p.audioSender]]) {
      if (!snd) continue;
      try {
        const prm = snd.getParameters();
        const enc = (prm.encodings && prm.encodings[0]) || {};
        out.bitrates[label] = { maxBitrate: enc.maxBitrate || 0, scale: enc.scaleResolutionDownBy || 1 };
      } catch (_) {}
    }
  }
  const q = document.getElementById('quality-badge');
  out.badge = q ? q.textContent : null;
  out.tiles = document.querySelectorAll('#grid .tile').length;
  out.gridCount = document.getElementById('grid').dataset.count;
  return out;
})()`;

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

  const out = { steps: [], verdict: {}, ok: false };
  try {
    const pages = [];

    // tab 1 = host
    const A = await newPage();
    await A.goto(`${BASE}/`);
    await A.ev(`localStorage.clear()`);
    await A.goto(`${BASE}/`);
    await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
    await sleep(4000);
    const code = (await A.ev(`location.pathname`)).replace('/r/', '');
    pages.push(A);
    out.steps.push({ step: '1. host bikin rapat', code });

    // masuk bertahap, catat bitrate tiap tahap
    for (let i = 2; i <= TABLES; i++) {
      const P = await newPage();
      await P.goto(`${BASE}/`);
      await P.ev(`localStorage.clear()`);
      await P.goto(`${BASE}/r/${code}`);
      await sleep(700);
      await P.ev(`(()=>{document.getElementById('in-name').value='P${i}';document.getElementById('btn-join').click();return 1})()`);
      await sleep(6000);
      pages.push(P);

      const snap = await A.ev(SNAP);
      out.steps.push({
        step: `2.${i - 1} setelah ${i} peserta`,
        peersSeenByHost: snap.peers,
        bitrateCam: snap.bitrates.cam ? snap.bitrates.cam.maxBitrate : null,
        scale: snap.bitrates.cam ? snap.bitrates.cam.scale : null,
        badge: snap.badge,
        tilesAtHost: snap.tiles,
      });
    }

    const finalSnap = await A.ev(SNAP);
    await sleep(2600); // beri waktu loop periodik menyamakan bitrate
    const settled = await A.ev(SNAP);

    // hipotesis: tuneAllSenders() tidak terpanggil tepat waktu -> panggil manual & baca lagi
    const afterManual = await A.ev(`(async () => {
      const S = window.__univmeet;
      // panggil ulang tuning seperti yang seharusnya dilakukan saat peserta berubah
      if (window.__tuneAll) window.__tuneAll();
      await new Promise(r => setTimeout(r, 1200));
      const p = [...S.peers.values()][0];
      if (!p) return null;
      const prm = p.videoSender.getParameters();
      const enc = (prm.encodings && prm.encodings[0]) || {};
      return { maxBitrate: enc.maxBitrate || 0, scale: enc.scaleResolutionDownBy || 1, peers: S.peers.size };
    })()`);
    out.steps.push({ step: '3. setelah panggil tuneAll manual', afterManual });
    const hostPeers = settled.peers;
    const totalPeople = hostPeers + 1;
    const camBitrate = settled.bitrates.cam ? settled.bitrates.cam.maxBitrate : 0;

    // hitung tier yang diharapkan (sama dengan qualityTier() di app.js)
    const n = hostPeers;
    let expectCam;
    if (n <= 2) expectCam = 2500;
    else if (n <= 4) expectCam = 1400;
    else if (n <= 6) expectCam = 900;
    else if (n <= 8) expectCam = 600;
    else if (n <= 12) expectCam = 380;
    else if (n <= 16) expectCam = 260;
    else if (n <= 20) expectCam = 190;
    else expectCam = 140;

    // ambil bitrate dari tahap awal (2 peserta) untuk bukti penurunan
    const firstStage = out.steps.find((s) => /setelah 2 peserta/.test(s.step));
    const firstBitrate = firstStage ? firstStage.bitrateCam : null;

    out.verdict = {
      [`maxPeers dilaporkan 20`]: finalSnap.maxPeers === 20,
      [`semua ${TABLES} peserta saling terhubung`]: hostPeers === TABLES - 1,
      [`tile di host = ${TABLES}`]: finalSnap.tiles >= TABLES,
      [`bitrate sesuai tier untuk ${n} peer`]: camBitrate === expectCam * 1000,
      'bitrate turun saat peserta nambah': firstBitrate === null || camBitrate < firstBitrate || n <= 2,
      'badge kualitas tampil': typeof finalSnap.badge === 'string' && finalSnap.badge.length > 3,
      [`grid count = ${totalPeople}`]: finalSnap.gridCount === String(totalPeople),
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
