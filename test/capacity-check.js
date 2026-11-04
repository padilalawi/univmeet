'use strict';

/**
 * Tes kapasitas ruang: verifikasi batas MAX_PEERS di server.
 * Pakai WebSocket polos (tanpa kamera) -> murah, bisa nembak banyak sekaligus.
 *
 * Pakai:
 *   node test/capacity-check.js                       (lokal, default 20)
 *   BASE_URL=https://univmeet.pages.dev node test/capacity-check.js
 *   EXPECT=30 BASE_URL=... node test/capacity-check.js
 */

const WebSocket = require('ws');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EXPECT = Number(process.env.EXPECT || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsUrl(base, room) {
  const u = new URL('/ws?room=' + encodeURIComponent(room), base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timeout connect')), 15000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function join(ws, room, name, id) {
  return new Promise((resolve) => {
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.e === 'ack' && m.id === id) {
        ws.off('message', onMsg);
        resolve(m.d);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ e: 'join', d: { room, name }, id }));
    setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 12000);
  });
}

(async () => {
  const room = 'kapasitas-' + Math.random().toString(36).slice(2, 7);
  const url = wsUrl(BASE, room);
  const out = { base: BASE, room, expect: EXPECT, joined: 0, rejected: [], verdict: {}, ok: false };

  const sockets = [];
  try {
    // masuk satu per satu sampai ditolak
    for (let i = 1; i <= EXPECT + 3; i++) {
      let ws;
      try {
        ws = await connect(url);
      } catch (e) {
        out.rejected.push({ n: i, reason: 'connect gagal: ' + e.message });
        break;
      }
      const res = await join(ws, room, 'P' + i, i);
      if (res && res.ok) {
        out.joined++;
        sockets.push(ws);
        if (i === 1) out.maxPeersReported = res.maxPeers;
      } else {
        out.rejected.push({ n: i, reason: (res && res.error) || 'unknown' });
        try { ws.close(); } catch (_) {}
        // server menolak -> kapasitas tercapai, berhenti
        break;
      }
      await sleep(120);
    }

    const firstReject = out.rejected[0];
    const fullMsg = firstReject ? String(firstReject.reason) : '';

    out.verdict = {
      [`server melaporkan maxPeers = ${EXPECT}`]: out.maxPeersReported === EXPECT,
      'berhasil masuk sebanyak maxPeers': out.joined === EXPECT,
      [`peserta ke-${EXPECT + 1} ditolak`]: !!firstReject,
      'alasan penolakan menyebut "penuh"': /penuh/i.test(fullMsg),
    };
    out.ok = Object.values(out.verdict).every(Boolean);
  } catch (err) {
    out.error = String(err && err.stack ? err.stack : err);
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch (_) {} }
    console.log(JSON.stringify(out, null, 2));
    await sleep(300);
    process.exit(out.ok ? 0 : 1);
  }
})();
