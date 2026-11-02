'use strict';
// Debug: kenapa media host -> peserta nggak ngalir (senders, SDP arah, stats RTP)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const CDP_PORT = 9334;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-dbg-profile');
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
    await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
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
  await A.goto(`${BASE}/`); await A.ev(`localStorage.clear()`); await A.goto(`${BASE}/`);
  await A.ev(`(()=>{document.getElementById('in-name').value='Host';document.getElementById('btn-create').click();return 1})()`);
  await sleep(4000);
  const code = (await A.ev(`location.pathname`)).replace('/r/', '');

  const B = await newPage();
  await B.goto(`${BASE}/`); await B.ev(`localStorage.clear()`);
  await B.goto(`${BASE}/r/${code}`); await sleep(800);
  await B.ev(`(()=>{document.getElementById('in-name').value='Tamu';document.getElementById('btn-join').click();return 1})()`);
  await sleep(8000);

  const DUMP = `(async () => {
    const S = window.__univmeet;
    const p = [...S.peers.values()][0];
    if (!p) return { err: 'no peer' };
    const senders = p.pc.getSenders().map(s => ({
      kind: s.track ? s.track.kind : null,
      enabled: s.track ? s.track.enabled : null,
      readyState: s.track ? s.track.readyState : null,
      muted: s.track ? s.track.muted : null,
    }));
    const sdpDirs = (sdp) => (sdp || '').split('\\n').filter(l => /^m=|^a=sendrecv|^a=recvonly|^a=sendonly|^a=inactive|^a=mid/.test(l)).join(' | ');
    const stats = {};
    const rep = await p.pc.getStats();
    rep.forEach(s => {
      if (s.type === 'outbound-rtp') stats['out_' + s.kind] = { bytes: s.bytesSent, packets: s.packetsSent };
      if (s.type === 'inbound-rtp') stats['in_' + s.kind] = { bytes: s.bytesReceived, packets: s.packetsReceived };
    });
    return {
      conn: p.pc.connectionState,
      senders,
      localSdp: sdpDirs(p.pc.localDescription && p.pc.localDescription.sdp),
      remoteSdp: sdpDirs(p.pc.remoteDescription && p.pc.remoteDescription.sdp),
      stats,
      localTracks: { audio: !!S.audioTrack, video: !!S.videoTrack },
      tracksState: {
        audio: S.audioTrack ? S.audioTrack.readyState + '/' + S.audioTrack.enabled + '/muted=' + S.audioTrack.muted : null,
        video: S.videoTrack ? S.videoTrack.readyState + '/' + S.videoTrack.enabled + '/muted=' + S.videoTrack.muted : null,
      },
    };
  })()`;

  console.log('=== HOST ===');
  console.log(JSON.stringify(await A.ev(DUMP), null, 2));
  console.log('=== GUEST ===');
  console.log(JSON.stringify(await B.ev(DUMP), null, 2));

  ws.close(); chrome.kill();
  await sleep(300);
  process.exit(0);
})();
