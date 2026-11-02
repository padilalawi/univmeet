'use strict';

/**
 * Tes MULTI-SHARE: dua peserta share layar BERSAMAAN.
 * Bukti yang dicari:
 *  - tiap orang punya tile layar sendiri (tile-screen-*) berisi frame
 *  - kamera masing-masing TETAP terlihat (tidak tertimpa layar)
 *  - bitrate video/audio sudah dinaikkan (bukan default kecil)
 *  - saat satu berhenti, tile layarnya hilang tapi layar yang lain tetap
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CDP_PORT = 9340;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-multishare');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
    '--allow-http-screen-capture', '--enable-usermedia-screen-capturing',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break; } catch (_) {}
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome CDP tidak siap');

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

  const SNAP = `(async () => {
    const S = window.__univmeet;
    const tiles = [...document.querySelectorAll('#grid .tile')].map(t => {
      const v = t.querySelector('video');
      const isScreenTile = t.classList.contains('screen-tile');
      const isSelf = isScreenTile
        ? t.id === 'tile-screen-self'
        : t.id === 'tile-' + S.selfId;
      return {
        id: t.id,
        isScreenTile,
        isSelf,
        w: v ? v.videoWidth : -1,
        h: v ? v.videoHeight : -1,
      };
    });
    const senders = [];
    for (const p of S.peers.values()) {
      for (const [label, snd] of [['cam', p.videoSender], ['screen', p.screenSender], ['audio', p.audioSender]]) {
        if (!snd) continue;
        try {
          const prm = snd.getParameters();
          const enc = (prm.encodings && prm.encodings[0]) || {};
          senders.push({ label, maxBitrate: enc.maxBitrate || 0, maxFramerate: enc.maxFramerate || 0, degradation: prm.degradationPreference || null });
        } catch (_) {}
      }
    }
    const screenTrack = S.screenStream ? S.screenStream.getVideoTracks()[0] : null;
    return {
      selfId: S.selfId,
      sharing: !!S.screenStream,
      screenContentHint: screenTrack ? screenTrack.contentHint : null,
      camContentHint: S.videoTrack ? S.videoTrack.contentHint : null,
      peers: [...S.peers.values()].map(p => ({ id: p.id, name: p.name, conn: p.pc.connectionState, screenFlag: p.screen })),
      tiles,
      screenTiles: tiles.filter(t => t.isScreenTile),
      camTiles: tiles.filter(t => !t.isScreenTile),
      senders,
    };
  })()`;

  const out = { steps: [], verdict: {}, ok: false };
  try {
    /* A = host */
    const A = await newPage();
    await A.goto(`${BASE}/`);
    await A.ev(`localStorage.clear()`);
    await A.goto(`${BASE}/`);
    await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
    await sleep(4000);
    const code = (await A.ev(`location.pathname`)).replace('/r/', '');

    /* B = peserta */
    const B = await newPage();
    await B.goto(`${BASE}/`);
    await B.ev(`localStorage.clear()`);
    await B.goto(`${BASE}/r/${code}`);
    await sleep(800);
    await B.ev(`(()=>{document.getElementById('in-name').value='Tamu';document.getElementById('btn-join').click();return 1})()`);
    await sleep(7000);
    out.steps.push({ step: '1. dua peserta terhubung', a: await A.ev(`[...window.__univmeet.peers.values()].map(p=>p.pc.connectionState)`), b: await B.ev(`[...window.__univmeet.peers.values()].map(p=>p.pc.connectionState)`) });

    /* A share layar */
    await A.ev(`document.getElementById('btn-screen').click()`);
    await sleep(4000);
    out.steps.push({ step: '2. host mulai share', snap: await A.ev(SNAP) });
    out.steps.push({ step: '2b. tamu lihat layar host', snap: await B.ev(SNAP) });

    /* B share layar JUGA (bersamaan) */
    await B.ev(`document.getElementById('btn-screen').click()`);
    await sleep(4500);
    const snapA = await A.ev(SNAP);
    const snapB = await B.ev(SNAP);
    out.steps.push({ step: '3a. host (share + lihat layar tamu)', snap: snapA });
    out.steps.push({ step: '3b. tamu (share + lihat layar host)', snap: snapB });

    /* A berhenti share */
    await A.ev(`document.getElementById('btn-screen').click()`);
    await sleep(3500);
    const afterA = await B.ev(SNAP);
    out.steps.push({ step: '4. host berhenti, tamu masih share', snap: afterA });

    /* verdict */
    const aScreen = snapA.screenTiles.filter((t) => !t.isSelf);
    const bScreen = snapB.screenTiles.filter((t) => !t.isSelf);
    const aSelfScreen = snapA.screenTiles.filter((t) => t.isSelf);
    const bSelfScreen = snapB.screenTiles.filter((t) => t.isSelf);
    const aCam = snapA.camTiles.filter((t) => !t.isSelf);
    const bCam = snapB.camTiles.filter((t) => !t.isSelf);
    const videoSender = snapA.senders.find((s) => s.label === 'cam');
    const screenSender = snapA.senders.find((s) => s.label === 'screen');
    const audioSender = snapA.senders.find((s) => s.label === 'audio');

    out.verdict = {
      'host punya tile layar tamu': aScreen.length >= 1,
      'tile layar tamu ada frame': aScreen.some((t) => t.w > 0),
      'tamu punya tile layar host': bScreen.length >= 1,
      'tile layar host ada frame': bScreen.some((t) => t.w > 0),
      'host punya tile layar sendiri': aSelfScreen.length >= 1 && aSelfScreen.some((t) => t.w > 0),
      'tamu punya tile layar sendiri': bSelfScreen.length >= 1 && bSelfScreen.some((t) => t.w > 0),
      'kamera host tetap terlihat': aCam.length >= 1 && aCam.some((t) => t.w > 0),
      'kamera tamu tetap terlihat': bCam.length >= 1 && bCam.some((t) => t.w > 0),
      'bitrate kamera dinaikkan (>1 Mbps)': (videoSender && videoSender.maxBitrate >= 1000000),
      'bitrate layar tinggi (>=1 Mbps)': (screenSender && screenSender.maxBitrate >= 1000000),
      'bitrate audio 64 kbps': (audioSender && audioSender.maxBitrate === 64000),
      'layar pakai contentHint=detail': snapA.screenContentHint === 'detail',
      'kamera pakai contentHint=motion': snapA.camContentHint === 'motion',
      'host berhenti -> tile layar host hilang di tamu': afterA.screenTiles.filter((t) => !t.isSelf).length === 0,
      'tamu tetap share setelah host berhenti': afterA.sharing === true,
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
