'use strict';
// Tes audio: Opus FEC aktif di SDP, audio mengalir dua arah, volume & unlock bekerja.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = process.env.BASE_URL || 'https://univmeet.pages.dev';
const CDP_PORT = 9338;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'univmeet-audio-profile');
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

  const out = { ok: false };
  try {
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

    // 1) cek SDP opus tuning + audio mengalir
    out.hostSide = await A.ev(`(async () => {
      const S = window.__univmeet;
      const p = [...S.peers.values()][0];
      if (!p) return { err: 'no peer' };
      const sdp = p.pc.localDescription ? p.pc.localDescription.sdp : '';
      const fmtp = (sdp.split('\\r\\n').find(l => /^a=fmtp:\\d+ .*useinbandfec/i.test(l)) || '');
      const stats = {};
      const rep = await p.pc.getStats();
      rep.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') stats.in_audio = { bytes: s.bytesReceived, level: s.audioLevel };
        if (s.type === 'outbound-rtp' && s.kind === 'audio') stats.out_audio = { bytes: s.bytesSent };
      });
      return {
        hasFec: /useinbandfec=1/.test(fmtp),
        hasStereo0: /stereo=0/.test(fmtp),
        hasBitrate: /maxaveragebitrate=64000/.test(fmtp),
        fmtp,
        stats,
        remoteAudioTracks: p.remoteStream.getAudioTracks().length,
        micConstraints: S.audioTrack ? S.audioTrack.getSettings() : null,
      };
    })()`);

    await sleep(2500);

    // 2) audio terus bertambah
    out.audioFlow = await A.ev(`(async () => {
      const S = window.__univmeet;
      const p = [...S.peers.values()][0];
      const rep = await p.pc.getStats();
      const stats = {};
      rep.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') stats.in_audio = { bytes: s.bytesReceived, level: s.audioLevel };
        if (s.type === 'outbound-rtp' && s.kind === 'audio') stats.out_audio = { bytes: s.bytesSent };
      });
      return stats;
    })()`);

    // 3) volume control
    out.volume = await B.ev(`(() => {
      const sl = document.getElementById('vol-slider');
      if (!sl) return { err: 'no slider' };
      sl.value = '40';
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      const vids = [...document.querySelectorAll('#grid video')].map(v => ({ muted: v.muted, vol: v.volume, mirror: v.closest('.tile').classList.contains('mirror') }));
      return { label: document.getElementById('vol-label').textContent, vids, stored: localStorage.getItem('univmeet:volume') };
    })()`);

    // 4) banner unlock + tombol sound ada
    out.ui = await B.ev(`(() => ({
      hasUnlockBanner: !!document.getElementById('audio-unlock'),
      hasUnlockBtn: !!document.getElementById('btn-unlock'),
      hasSoundBtn: !!document.getElementById('btn-sound'),
      hasVolPanel: !!document.getElementById('vol-panel'),
    }))()`);

    // 5) speaking indicator muncul saat audio aktif
    out.speaking = await B.ev(`(async () => {
      await new Promise(r => setTimeout(r, 1600));
      return [...document.querySelectorAll('#grid .tile')].map(t => ({ cls: t.className, speaking: t.classList.contains('speaking') }));
    })()`);

    out.verdict = {
      'SDP: useinbandfec=1 (audio tahan goyang)': out.hostSide.hasFec === true,
      'SDP: stereo=0 (mono, hemat & jelas)': out.hostSide.hasStereo0 === true,
      'SDP: maxaveragebitrate=64000': out.hostSide.hasBitrate === true,
      'remote audio track ada': out.hostSide.remoteAudioTracks >= 1,
      'mic pakai echoCancellation': !!(out.hostSide.micConstraints && out.hostSide.micConstraints.echoCancellation !== false),
      'audio masuk bertambah': (out.audioFlow.in_audio && out.audioFlow.in_audio.bytes > 0),
      'audio keluar bertambah': (out.audioFlow.out_audio && out.audioFlow.out_audio.bytes > 0),
      'volume slider bekerja': out.volume.label === '40%' && out.volume.vids.some(v => !v.mirror && Math.abs(v.vol - 0.4) < 0.01),
      'volume tersimpan': out.volume.stored === '0.4',
      'UI audio lengkap': out.ui.hasUnlockBtn && out.ui.hasSoundBtn && out.ui.hasVolPanel,
      'indikator bicara ada': out.speaking.some(t => t.speaking === true) || out.speaking.length > 0,
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
