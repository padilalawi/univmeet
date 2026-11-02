'use strict';

/**
 * UnivMeet signaling server
 * - Serve file statis (public/)
 * - WebSocket signaling (Socket.IO) untuk WebRTC mesh
 * - Video/audio mengalir P2P antar browser (server cuma atur "siapa ketemu siapa")
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = Math.max(2, Number(process.env.MAX_PEERS || 8));
const TURN_URL = (process.env.TURN_URL || '').trim();
const TURN_USER = (process.env.TURN_USER || '').trim();
const TURN_PASS = (process.env.TURN_PASS || '').trim();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingTimeout: 25000,
});

/* ------------------------------------------------------------------ */
/* ICE servers                                                         */
/* ------------------------------------------------------------------ */

function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (TURN_URL) {
    list.push({ urls: TURN_URL.split(',').map((u) => u.trim()).filter(Boolean), username: TURN_USER, credential: TURN_PASS });
  } else {
    // TURN publik (openrelay) — cukup untuk NAT ketat, kalau mau stabil pakai TURN sendiri
    list.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** roomId -> { peers: Map<socketId, peer>, host: socketId, locked: bool, createdAt } */
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { peers: new Map(), host: null, locked: false, createdAt: Date.now() };
    rooms.set(id, room);
  }
  return room;
}

function publicPeers(room, exceptId) {
  const out = [];
  for (const [id, p] of room.peers) {
    if (id === exceptId) continue;
    out.push({ id, name: p.name, muted: p.muted, camOff: p.camOff, screen: p.screen });
  }
  return out;
}

function broadcastPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id] of room.peers) {
    io.to(id).emit('peers', { peers: publicPeers(room, id), host: room.host, locked: room.locked });
  }
}

function cleanRoomId(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

app.get('/config', (req, res) => {
  res.json({ iceServers: iceServers(), maxPeers: MAX_PEERS });
});

app.get('/healthz', (req, res) => {
  let people = 0;
  for (const r of rooms.values()) people += r.peers.size;
  res.json({ ok: true, rooms: rooms.size, people, uptime: Math.round(process.uptime()) });
});

// link rapat: /r/kode-rapat
app.get(['/r/:code', '/r/:code/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

/* ------------------------------------------------------------------ */
/* Socket.IO signaling                                                 */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', (payload, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    try {
      const id = cleanRoomId(payload && payload.room);
      const name = String((payload && payload.name) || '').trim().slice(0, 32) || 'Tamu';
      if (!id) return ack({ ok: false, error: 'Kode rapat tidak valid.' });

      if (roomId) return ack({ ok: false, error: 'Kamu sudah ada di rapat lain.' });

      const room = getRoom(id);

      // room kosong -> reset total (host lama sudah keluar, kunci dibuka)
      if (room.peers.size === 0) {
        room.locked = false;
        room.host = socket.id;
      }

      if (room.locked && room.host !== socket.id) {
        return ack({ ok: false, error: 'Rapat sedang dikunci oleh host.' });
      }
      if (room.peers.size >= MAX_PEERS) {
        return ack({ ok: false, error: `Rapat penuh (maksimal ${MAX_PEERS} orang).` });
      }

      roomId = id;
      socket.join(id);
      room.peers.set(socket.id, { name, muted: false, camOff: false, screen: false });
      if (!room.host) room.host = socket.id;

      ack({
        ok: true,
        selfId: socket.id,
        room: id,
        host: room.host === socket.id,
        locked: room.locked,
        peers: publicPeers(room, socket.id),
        maxPeers: MAX_PEERS,
      });

      socket.to(id).emit('peer-joined', { id: socket.id, name });
      socket.to(id).emit('chat', {
        system: true,
        text: `${name} bergabung`,
        ts: Date.now(),
      });
      broadcastPeers(id);
    } catch (err) {
      ack({ ok: false, error: 'Gagal masuk rapat.' });
    }
  });

  // WebRTC signaling relay (offer / answer / candidate)
  socket.on('signal', ({ to, data } = {}) => {
    if (!roomId || !to || !data) return;
    const room = rooms.get(roomId);
    if (!room || !room.peers.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // status mic / kamera / share screen
  socket.on('state', (patch = {}) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    const me = room && room.peers.get(socket.id);
    if (!me) return;
    if (typeof patch.muted === 'boolean') me.muted = patch.muted;
    if (typeof patch.camOff === 'boolean') me.camOff = patch.camOff;
    if (typeof patch.screen === 'boolean') me.screen = patch.screen;
    socket.to(roomId).emit('peer-state', { id: socket.id, muted: me.muted, camOff: me.camOff, screen: me.screen });
    broadcastPeers(roomId);
  });

  socket.on('chat', ({ text } = {}) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    const me = room && room.peers.get(socket.id);
    if (!me) return;
    const clean = String(text || '').trim().slice(0, 800);
    if (!clean) return;
    io.to(roomId).emit('chat', { id: socket.id, name: me.name, text: clean, ts: Date.now() });
  });

  socket.on('lock', ({ locked } = {}) => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return;
    room.locked = !!locked;
    broadcastPeers(roomId);
    io.to(roomId).emit('chat', {
      system: true,
      text: room.locked ? 'Host mengunci rapat — peserta baru tidak bisa masuk' : 'Host membuka kunci rapat',
      ts: Date.now(),
    });
  });

  socket.on('kick', ({ id } = {}) => {
    if (!roomId || !id) return;
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || id === socket.id) return;
    const target = room.peers.get(id);
    if (!target) return;
    io.to(id).emit('kicked', { by: socket.id });
    io.to(id).socketsLeave(roomId);
    room.peers.delete(id);
    socket.to(roomId).emit('peer-left', { id, name: target.name });
    io.to(roomId).emit('chat', { system: true, text: `${target.name} dikeluarkan host`, ts: Date.now() });
    broadcastPeers(roomId);
  });

  socket.on('leave', () => {
    leaveRoom();
  });

  socket.on('disconnect', () => {
    leaveRoom();
  });

  function leaveRoom() {
    if (!roomId) return;
    const id = roomId;
    roomId = null;
    const room = rooms.get(id);
    if (!room) return;
    const me = room.peers.get(socket.id);
    room.peers.delete(socket.id);
    socket.leave(id);

    if (room.peers.size === 0) {
      rooms.delete(id);
      return;
    }

    if (room.host === socket.id) {
      room.host = room.peers.keys().next().value;
      const newHost = room.peers.get(room.host);
      io.to(room.host).emit('host', { host: true });
      io.to(id).emit('chat', { system: true, text: `${newHost.name} sekarang jadi host`, ts: Date.now() });
    }

    socket.to(id).emit('peer-left', { id: socket.id, name: me ? me.name : 'Peserta' });
    if (me) {
      socket.to(id).emit('chat', { system: true, text: `${me.name} keluar`, ts: Date.now() });
    }
    broadcastPeers(id);
  }
});

server.listen(PORT, () => {
  console.log(`[univmeet] listening on http://localhost:${PORT}  (max ${MAX_PEERS}/room)`);
  console.log(`[univmeet] TURN: ${TURN_URL ? TURN_URL : 'openrelay (public)'}`);
});
