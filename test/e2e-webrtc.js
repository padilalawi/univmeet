'use strict';

/**
 * E2E test UnivMeet — 3 tab browser, kamera & mic palsu (fake device).
 * Verifikasi: signaling, peer connection 'connected', video/audio remote benar-benar mengalir,
 * chat, propagasi mute, kunci rapat, dan promosi host.
 *
 * Pakai:
 *   1) node server.js            (terminal lain)
 *   2) node test/e2e-webrtc.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const CDP_PORT = 9333;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-e2e-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT = `(() => {
  const S = window.__univmeet;
  const selfTileId = 'tile-' + S.selfId;
  const remoteTiles = [...document.querySelectorAll('#grid .tile')]
    .filter(t => t.id !== selfTileId)
    .map(t => {
      const v = t.querySelector('video');
      const src = v && v.srcObject;
      return {
        id: t.id,
        w: v ? v.videoWidth : -1,
        h: v ? v.videoHeight : -1,
        hasSrc: !!src,
        tracks: src ? src.getTracks().map(x => x.kind + ':' + x.readyState + ':' + (x.muted ? 'muted' : 'unmuted')) : [],
      };
    });
  return {
    room: S.room,
    selfId: S.selfId,
    isHost: S.isHost,
    locked: S.locked,
    micOn: S.micOn,
    camOn: S.camOn,
    localTracks: { audio: !!S.audioTrack, video: !!S.videoTrack },
    peers: [...S.peers.values()].map(p => ({
      name: p.name,
      muted: p.muted,
      conn: p.pc.connectionState,
      ice: p.pc.iceConnectionState,
      remoteTracks: p.remoteStream.getTracks().map(t => t.kind + ':' + t.readyState + ':' + (t.muted ? 'muted' : 'unmuted')),
    })),
    remoteTiles,
    tiles: document.querySelectorAll('#grid .tile').length,
    people: document.getElementById('people-count').textContent,
    roomHidden: document.getElementById('room').classList.contains('hidden'),
  };
})()`;

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const j = await r.json();
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
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const reqId = ++id;
      pending.set(reqId, { resolve, reject });
      const payload = { id: reqId, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    return {
      targetId,
      sessionId,
      goto: async (url, wait = 1300) => {
        await send('Page.navigate', { url }, sessionId);
        await sleep(wait);
      },
      eval: async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error(`${d.text} ${d.exception ? d.exception.description : ''}`);
        }
        return r.result.value;
      },
      snapshot: async () => {
        const r = await send('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
      },
    };
  }

  const out = { steps: [], verdict: {}, ok: false };

  try {
    /* ---------- 1. host bikin rapat ---------- */
    const A = await newPage();
    await A.goto(`${BASE}/`);
    await A.eval(`localStorage.clear()`);
    await A.goto(`${BASE}/`);
    await A.eval(`(() => {
      document.getElementById('in-name').value = 'Host E2E';
      document.getElementById('in-code').value = '';
      document.getElementById('btn-create').click();
      return true;
    })()`);
    await sleep(4000);

    const code = (await A.eval(`location.pathname`)).replace('/r/', '');
    const snapA1 = await A.snapshot();
    out.steps.push({ step: '1. host buat rapat', code, room: snapA1.room, media: snapA1.localTracks, roomHidden: snapA1.roomHidden });
    if (!snapA1.room || snapA1.room !== code) throw new Error('Host gagal masuk rapat: ' + JSON.stringify(snapA1));

    /* ---------- 2. peserta gabung ---------- */
    const B = await newPage();
    await B.goto(`${BASE}/`);
    await B.eval(`localStorage.clear()`);
    await B.goto(`${BASE}/r/${code}`);
    await sleep(800);
    await B.eval(`(() => {
      document.getElementById('in-name').value = 'Peserta E2E';
      document.getElementById('btn-join').click();
      return true;
    })()`);
    await sleep(7000);

    const snapA2 = await A.snapshot();
    const snapB2 = await B.snapshot();
    out.steps.push({ step: '2a. host lihat peserta', peers: snapA2.peers, remoteTiles: snapA2.remoteTiles, tiles: snapA2.tiles, people: snapA2.people });
    out.steps.push({ step: '2b. peserta lihat host', room: snapB2.room, peers: snapB2.peers, remoteTiles: snapB2.remoteTiles, tiles: snapB2.tiles, people: snapB2.people });

    /* ---------- 3. chat ---------- */
    await A.eval(`(() => {
      const i = document.getElementById('chat-input');
      i.value = 'halo dari host';
      document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);
    await sleep(1200);
    const chatB = await B.eval(`document.getElementById('chat-log').innerText`);
    out.steps.push({ step: '3. chat host -> peserta', chatB });

    /* ---------- 4. propagasi mute ---------- */
    await B.eval(`document.getElementById('btn-mic').click()`);
    await sleep(1800);
    const snapA3 = await A.snapshot();
    const snapB3 = await B.snapshot();
    out.steps.push({
      step: '4. peserta mute -> host lihat',
      guestMicOn: snapB3.micOn,
      hostSeesPeerMuted: snapA3.peers[0] ? snapA3.peers[0].muted : null,
    });

    /* ---------- 5. kunci rapat ---------- */
    await A.eval(`document.getElementById('btn-lock').click()`);
    await sleep(1000);
    const lockA = (await A.snapshot()).locked;

    const C = await newPage();
    await C.goto(`${BASE}/`);
    await C.eval(`localStorage.clear()`);
    await C.goto(`${BASE}/r/${code}`);
    await sleep(800);
    await C.eval(`(() => {
      document.getElementById('in-name').value = 'Orang Ketiga';
      document.getElementById('btn-join').click();
      return true;
    })()`);
    await sleep(2500);
    const snapC = await C.snapshot();
    const hintC = await C.eval(`document.getElementById('land-hint').textContent`);
    out.steps.push({ step: '5. orang ketiga ditolak', locked: lockA, roomHidden: snapC.roomHidden, hint: hintC });

    /* ---------- 6. host keluar -> peserta jadi host ---------- */
    await A.goto('about:blank', 500);
    await sleep(3000);
    const snapB4 = await B.snapshot();
    out.steps.push({ step: '6. host keluar -> peserta promosi', guestIsHost: snapB4.isHost, peersLeft: snapB4.peers.length, people: snapB4.people });

    /* ---------- verdict ---------- */
    const remoteFrames = (snap) => snap.remoteTiles.some((t) => t.w > 0);
    const hasAudio = (snap) => snap.peers.some((p) => p.remoteTracks.some((t) => t.startsWith('audio:live')));
    const hasVideo = (snap) => snap.peers.some((p) => p.remoteTracks.some((t) => t.startsWith('video:live')));

    out.verdict = {
      'host: peer connected': snapA2.peers.length === 1 && snapA2.peers[0].conn === 'connected',
      'guest: peer connected': snapB2.peers.length === 1 && snapB2.peers[0].conn === 'connected',
      'host: audio remote live': hasAudio(snapA2),
      'host: video remote live': hasVideo(snapA2),
      'guest: audio remote live': hasAudio(snapB2),
      'guest: video remote live': hasVideo(snapB2),
      'host: video remote ada frame': remoteFrames(snapA2),
      'guest: video remote ada frame': remoteFrames(snapB2),
      'chat terkirim': /halo dari host/.test(chatB || ''),
      'mute terpropagasi': snapB3.micOn === false && !!snapA3.peers[0] && snapA3.peers[0].muted === true,
      'kunci rapat menolak orang baru': lockA === true && snapC.roomHidden === true && /kunci/i.test(hintC || ''),
      'host keluar -> peserta naik jadi host': snapB4.isHost === true && snapB4.peers.length === 0,
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
