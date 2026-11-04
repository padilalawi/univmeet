'use strict';
// Debug: kenapa jalur layar (transceiver video ke-2) tidak mengirim.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CDP_PORT = 9341;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-dbg2');
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

  const DUMP = `(async () => {
    const S = window.__univmeet;
    const p = [...S.peers.values()][0];
    if (!p) return { err: 'no peer' };
    const txs = p.pc.getTransceivers().map((t, i) => ({
      i,
      mid: t.mid,
      dir: t.direction,
      cur: t.currentDirection,
      senderTrack: t.sender.track ? t.sender.track.kind + ':' + t.sender.track.readyState + ':enabled=' + t.sender.track.enabled : null,
      recvTrack: t.receiver.track ? t.receiver.track.kind + ':muted=' + t.receiver.track.muted : null,
      stopped: t.stopped,
    }));
    const stats = [];
    const rep = await p.pc.getStats();
    rep.forEach(s => {
      if (s.type === 'outbound-rtp') stats.push({ dir: 'out', kind: s.kind, mid: s.mid, bytes: s.bytesSent, packets: s.packetsSent });
      if (s.type === 'inbound-rtp') stats.push({ dir: 'in', kind: s.kind, mid: s.mid, bytes: s.bytesReceived, frames: s.framesDecoded });
    });
    const sdpMids = (p.pc.localDescription ? p.pc.localDescription.sdp : '').split('\\r\\n')
      .filter(l => /^(m=|a=mid|a=sendrecv|a=sendonly|a=recvonly|a=inactive)/.test(l)).join(' | ');
    return {
      sharing: !!S.screenStream,
      screenTrack: S.screenStream ? S.screenStream.getVideoTracks()[0].readyState : null,
      senderHasTrack: {
        cam: p.videoSender && p.videoSender.track ? p.videoSender.track.kind : null,
        screen: p.screenSender && p.screenSender.track ? p.screenSender.track.kind : null,
      },
      txs, stats, sdpMids,
      peerScreenStreamTracks: p.screenStream.getTracks().map(t => t.kind + ':muted=' + t.muted + ':' + t.readyState),
      gridTiles: [...document.querySelectorAll('#grid .tile')].map(t => ({
        id: t.id,
        cls: t.className,
        hasStream: !!t.querySelector('video').srcObject,
        tracks: t.querySelector('video').srcObject ? [...t.querySelector('video').srcObject.getTracks()].map(x => x.kind + ':muted=' + x.muted) : [],
        w: t.querySelector('video').videoWidth,
      })),
      screenStreamObj: (() => { const q = p.screenStream; return { id: q.id, count: q.getTracks().length }; })(),
    };
  })()`;

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
  await sleep(800);
  await B.ev(`(()=>{document.getElementById('in-name').value='Tamu';document.getElementById('btn-join').click();return 1})()`);
  await sleep(7000);

  await A.ev(`document.getElementById('btn-screen').click()`);
  await sleep(4500);

  console.log('=== HOST (sharing) ===');
  console.log(JSON.stringify(await A.ev(DUMP), null, 2));
  console.log('=== GUEST (menerima) ===');
  console.log(JSON.stringify(await B.ev(DUMP), null, 2));

  ws.close(); chrome.kill();
  await sleep(300);
  process.exit(0);
})();
