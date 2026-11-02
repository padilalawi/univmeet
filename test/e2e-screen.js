'use strict';

/**
 * Tes khusus SHARE LAYAR.
 * Chrome dijalankan dengan --auto-select-desktop-capture-source supaya
 * getDisplayMedia() jalan tanpa dialog (headless).
 *
 * Pakai:
 *   node server.js                                   (terminal lain)
 *   node test/e2e-screen.js                          (lokal)
 *   BASE_URL=https://univmeet.pages.dev node test/e2e-screen.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CDP_PORT = 9336;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-screen-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // izin getDisplayMedia otomatis + langsung pilih layar
    '--auto-select-desktop-capture-source=Entire screen',
    '--allow-http-screen-capture',
    '--enable-usermedia-screen-capturing',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (_) {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome CDP tidak siap');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const rid = ++id;
    pending.set(rid, { resolve, reject });
    const pl = { id: rid, method, params };
    if (sessionId) pl.sessionId = sessionId;
    ws.send(JSON.stringify(pl));
  });

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
    /* host */
    const A = await newPage();
    await A.goto(`${BASE}/`);
    await A.ev(`localStorage.clear()`);
    await A.goto(`${BASE}/`);
    await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
    await sleep(4000);
    const code = (await A.ev(`location.pathname`)).replace('/r/', '');
    out.steps.push({ step: '1. host buat rapat', code });

    /* guest */
    const B = await newPage();
    await B.goto(`${BASE}/`);
    await B.ev(`localStorage.clear()`);
    await B.goto(`${BASE}/r/${code}`);
    await sleep(800);
    await B.ev(`(()=>{document.getElementById('in-name').value='Tamu';document.getElementById('btn-join').click();return 1})()`);
    await sleep(6000);

    const before = await B.ev(`(async () => {
      const S = window.__univmeet;
      const p = [...S.peers.values()][0];
      const stats = {};
      if (p) {
        const rep = await p.pc.getStats();
        rep.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') stats.frames = s.framesDecoded, stats.w = s.frameWidth; });
      }
      return { trackIds: p ? p.remoteStream.getTracks().map(t => t.kind + ':' + t.id) : [], stats };
    })()`);
    out.steps.push({ step: '2. kondisi awal (sebelum share)', before });

    /* host klik share layar */
    const shareResult = await A.ev(`(async () => {
      document.getElementById('btn-screen').click();
      await new Promise(r => setTimeout(r, 3500));
      const S = window.__univmeet;
      const p = [...S.peers.values()][0];
      const selfTile = document.getElementById('tile-' + S.selfId);
      const btnActive = document.getElementById('btn-screen').classList.contains('active');
      const selfScreenTile = document.getElementById('tile-screen-self');
      // bukti share layar benar-benar sampai: framesDecoded bertambah SETELAH share,
      // dan resolusi video tamu ikut berubah (kamera 1280x720 -> layar 800x450).
      const stats = {};
      if (p) {
        const rep = await p.pc.getStats();
        rep.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') { stats.frames = s.framesDecoded; stats.w = s.frameWidth; stats.bytes = s.bytesReceived; } });
      }
      return {
        screenStream: !!S.screenStream,
        senderMatchesScreen: !!(p && p.screenSender && p.screenSender.track && S.screenStream && p.screenSender.track.id === S.screenStream.getVideoTracks()[0].id),
        localScreenTile: !!selfScreenTile,
        localScreenTileW: selfScreenTile ? selfScreenTile.querySelector('video').videoWidth : 0,
        camTileStillVideo: !!(selfTile && selfTile.querySelector('video').srcObject),
        btnActive,
        stats,
      };
    })()`);
    out.steps.push({ step: '3. host klik share layar', shareResult });

    await sleep(3500);

    /* guest lihat apa */
    const guestView = await B.ev(`(async () => {
      const S = window.__univmeet;
      const p = [...S.peers.values()][0];
      const stats = {};
      if (p) {
        const rep = await p.pc.getStats();
        rep.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'video') stats.in_video = { bytes: s.bytesReceived, frames: s.framesDecoded, w: s.frameWidth }; });
      }
      const vids = [...document.querySelectorAll('#grid video')].map(v => ({ w: v.videoWidth, h: v.videoHeight }));
      const guestScreenTiles = [...document.querySelectorAll('#grid .tile.screen-tile')].map(t => ({
        id: t.id,
        isSelf: t.id === 'tile-screen-self',
        w: t.querySelector('video').videoWidth,
      }));
      return {
        remoteTrackIds: p ? p.remoteStream.getTracks().map(t => t.kind + ':' + t.id) : [],
        peerScreenFlag: p ? p.screen : null,
        stats,
        vids,
        guestScreenTiles,
        tileClasses: [...document.querySelectorAll('#grid .tile')].map(t => t.className),
      };
    })()`);
    out.steps.push({ step: '4. tampilan tamu saat host share', guestView });

    /* hentikan share */
    await A.ev(`document.getElementById('btn-screen').click()`);
    await sleep(2500);
    const afterStop = await B.ev(`(()=>{const S=window.__univmeet;const p=[...S.peers.values()][0];return {trackIds:p?p.remoteStream.getTracks().map(t=>t.kind+':'+t.id):[], screen:p?p.screen:null};})()`);
    out.steps.push({ step: '5. setelah share dihentikan', afterStop });

    /* verdict */
    // replaceTrack mempertahankan transceiver, jadi track id di penerima TIDAK berubah.
    // Bukti share layar sampai = resolusi/frame berubah + framesDecoded terus naik.
    const beforeStats = before.stats || {};
    const afterStats = (guestView.stats && guestView.stats.in_video) || {};
    const framesGrew = (afterStats.frames || 0) > (beforeStats.frames || 0);
    const resChanged = !!(afterStats.w && beforeStats.w && afterStats.w !== beforeStats.w);
    out.verdict = {
      'getDisplayMedia dapat stream': !!shareResult.screenStream,
      'sender host pakai track layar': shareResult.senderMatchesScreen === true,
      'tile lokal pakai stream layar': shareResult.localScreenTile === true && shareResult.localScreenTileW > 0,
      'tile kamera tetap jalan saat share': shareResult.camTileStillVideo === true,
      'tombol layar jadi aktif': shareResult.btnActive === true,
      'tamu: frame terus bertambah': framesGrew,
      'tamu punya tile layar host': (guestView.guestScreenTiles || []).some(t => !t.isSelf && t.w > 0),
      'tamu: frameWidth > 0': !!(afterStats.w > 0),
      'flag screen sampai ke tamu': guestView.peerScreenFlag === true,
      'badge LAYAR muncul di tile tamu': (guestView.tileClasses || []).some((c) => /screen/.test(c)),
      'setelah stop, share berhenti': afterStop.screen === false,
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
}

main();
