'use strict';

/**
 * UnivMeet signaling server (Node.js)
 * - Serve file statis (public/)
 * - WebSocket signaling di /ws untuk WebRTC mesh
 * - Video/audio mengalir P2P antar browser (server cuma atur "siapa ketemu siapa")
 *
 * Protokol sama dengan versi Cloudflare Worker (lihat lib/protocol.js).
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Room, cleanRoomId, iceServersFromEnv, MAX_PEERS_DEFAULT } = require('./lib/protocol');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = Math.max(2, Number(process.env.MAX_PEERS || MAX_PEERS_DEFAULT));
const ICE = iceServersFromEnv(process.env);

const app = express();
const server = http.createServer(app);

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

app.get('/config', (req, res) => {
  res.json({ iceServers: ICE, maxPeers: MAX_PEERS });
});

app.get('/healthz', (req, res) => {
  let people = 0;
  for (const entry of rooms.values()) people += entry.room.size;
  res.json({ ok: true, rooms: rooms.size, people, uptime: Math.round(process.uptime()) });
});

// link rapat: /r/kode-rapat
app.get(['/r/:code', '/r/:code/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** roomId -> { room: Room, conns: Map<clientId, ws> } */
const rooms = new Map();

function getEntry(roomId) {
  let entry = rooms.get(roomId);
  if (!entry) {
    const conns = new Map();
    const room = new Room({
      maxPeers: MAX_PEERS,
      send: (clientId, event, data) => {
        const ws = conns.get(clientId);
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ e: event, d: data })); } catch (_) {}
        }
      },
      broadcast: (event, data, exceptId) => {
        for (const [clientId, ws] of conns) {
          if (clientId === exceptId) continue;
          if (ws.readyState !== 1) continue;
          try { ws.send(JSON.stringify({ e: event, d: data })); } catch (_) {}
        }
      },
    });
    entry = { room, conns };
    rooms.set(roomId, entry);
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* WebSocket signaling                                                 */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1e6 });

wss.on('connection', (ws) => {
  const clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let roomId = null;

  const ack = (id, data) => {
    if (id === undefined || id === null) return;
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ e: 'ack', id, d: data })); } catch (_) {}
  };

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.e !== 'string') return;
    const data = msg.d || {};
    const ackId = msg.id;

    if (msg.e === 'join') {
      if (roomId) return ack(ackId, { ok: false, error: 'Kamu sudah ada di rapat lain.' });
      const id = cleanRoomId(data.room);
      if (!id) return ack(ackId, { ok: false, error: 'Kode rapat tidak valid.' });

      const entry = getEntry(id);
      const res = entry.room.join(clientId, { room: id, name: data.name });
      if (!res.ok) {
        if (entry.room.size === 0) rooms.delete(id);
        return ack(ackId, res);
      }
      roomId = id;
      entry.conns.set(clientId, ws);
      return ack(ackId, res);
    }

    if (!roomId) return;
    const entry = rooms.get(roomId);
    if (!entry) return;

    switch (msg.e) {
      case 'signal': entry.room.signal(clientId, data); break;
      case 'state': entry.room.setState(clientId, data); break;
      case 'chat': entry.room.chat(clientId, data); break;
      case 'lock': entry.room.lock(clientId, data); break;
      case 'kick': entry.room.kick(clientId, data); break;
      case 'leave': leave(); break;
      default: break;
    }
  });

  ws.on('close', leave);
  ws.on('error', () => { try { ws.close(); } catch (_) {} });

  function leave() {
    if (!roomId) return;
    const id = roomId;
    roomId = null;
    const entry = rooms.get(id);
    if (!entry) return;
    entry.conns.delete(clientId);
    const res = entry.room.leave(clientId);
    if (res.empty) rooms.delete(id);
  }
});

// bersihkan koneksi mati
const sweeper = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);
sweeper.unref();

server.listen(PORT, () => {
  console.log(`[univmeet] listening on http://localhost:${PORT}  (max ${MAX_PEERS}/room)`);
  console.log(`[univmeet] TURN: ${process.env.TURN_URL || 'openrelay (public)'}`);
});
