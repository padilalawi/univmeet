/**
 * UnivMeet — Cloudflare Worker
 * - Menyajikan file statis (public/) lewat binding ASSETS
 * - WebSocket signaling di /ws?room=<kode> -> diteruskan ke Durable Object per-ruang
 *
 * Gratis di Workers Free plan (Durable Objects tersedia di free plan).
 */

import protocol from '../lib/protocol.js';

const { Room, cleanRoomId, iceServersFromEnv } = protocol;

// `env` tidak tersedia di scope modul (Workers), jadi dihitung di dalam handler.
function maxPeersFrom(env) {
  const n = Number(env && env.MAX_PEERS);
  if (!Number.isFinite(n)) return 20;
  return Math.max(2, Math.min(30, n));
}

/* ==================================================================== */
/* Durable Object: satu instance = satu ruang rapat                      */
/* ==================================================================== */

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
  }

  /** Bangun ulang state Room dari WebSocket yang masih hidup (hibernation-safe). */
  async ensureRoom() {
    if (this.room) return this.room;

    const sockets = this.state.getWebSockets();
    const peers = new Map();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() || {};
      if (att.id) {
        peers.set(att.id, {
          name: att.name || 'Tamu',
          muted: !!att.muted,
          camOff: !!att.camOff,
          screen: !!att.screen,
        });
      }
    }

    const meta = (await this.state.storage.get('meta')) || {};

    const room = new Room({
      maxPeers: maxPeersFrom(this.env),
      send: (clientId, event, data) => this.sendTo(clientId, event, data),
      broadcast: (event, data, exceptId) => this.broadcastAll(event, data, exceptId),
    });
    room.peers = peers;
    room.host = meta.host && peers.has(meta.host) ? meta.host : (peers.keys().next().value || null);
    room.locked = !!meta.locked;

    this.room = room;
    return room;
  }

  findSocket(clientId) {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id === clientId) return ws;
    }
    return null;
  }

  sendTo(clientId, event, data) {
    const ws = this.findSocket(clientId);
    if (!ws) return;
    try { ws.send(JSON.stringify({ e: event, d: data })); } catch (_) {}
  }

  broadcastAll(event, data, exceptId) {
    const payload = JSON.stringify({ e: event, d: data });
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (exceptId && att.id === exceptId) continue;
      try { ws.send(payload); } catch (_) {}
    }
  }

  async persistMeta() {
    const room = this.room;
    if (!room) return;
    await this.state.storage.put('meta', { host: room.host, locked: room.locked });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      const room = await this.ensureRoom();
      return new Response(JSON.stringify({ ok: true, room: url.searchParams.get('room'), peers: room.peers.size }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch (_) { return; }
    if (!msg || typeof msg.e !== 'string') return;

    const room = await this.ensureRoom();
    const att = ws.deserializeAttachment() || {};
    const data = msg.d || {};
    const ackId = msg.id;

    const reply = (event, payload) => {
      try { ws.send(JSON.stringify({ e: event, d: payload })); } catch (_) {}
    };
    const ack = (payload) => {
      if (ackId === undefined || ackId === null) return;
      try { ws.send(JSON.stringify({ e: 'ack', id: ackId, d: payload })); } catch (_) {}
    };

    if (msg.e === 'join') {
      if (att.id && room.peers.has(att.id)) {
        return ack({ ok: false, error: 'Kamu sudah ada di rapat ini.' });
      }
      const id = cleanRoomId(data.room);
      if (!id) return ack({ ok: false, error: 'Kode rapat tidak valid.' });

      // pasang identitas DULU supaya broadcast tidak memantul ke diri sendiri
      const clientId = att.id || ('p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
      ws.serializeAttachment({ id: clientId, name: String(data.name || '').trim().slice(0, 32) || 'Tamu', muted: false, camOff: false, screen: false });

      const res = room.join(clientId, { room: id, name: data.name });
      if (!res.ok) {
        ws.serializeAttachment({ id: null });
        return ack(res);
      }

      const me = room.peers.get(clientId);
      ws.serializeAttachment({
        id: clientId,
        name: me ? me.name : 'Tamu',
        muted: false,
        camOff: false,
        screen: false,
      });
      await this.persistMeta();
      return ack(res);
    }

    if (!att.id) return;
    const me = room.peers.get(att.id);
    if (!me) return;

    switch (msg.e) {
      case 'signal':
        room.signal(att.id, data);
        break;
      case 'state': {
        room.setState(att.id, data);
        ws.serializeAttachment({
          id: att.id,
          name: me.name,
          muted: !!me.muted,
          camOff: !!me.camOff,
          screen: !!me.screen,
        });
        break;
      }
      case 'chat':
        room.chat(att.id, data);
        break;
      case 'lock':
        room.lock(att.id, data);
        await this.persistMeta();
        break;
      case 'kick': {
        const targetId = data && data.id;
        room.kick(att.id, data);
        if (targetId) {
          const targetWs = this.findSocket(targetId);
          if (targetWs) {
            try { targetWs.close(4001, 'kicked'); } catch (_) {}
          }
        }
        break;
      }
      case 'leave':
        await this.handleLeave(ws);
        break;
      default:
        break;
    }
  }

  async handleLeave(ws) {
    const att = ws.deserializeAttachment() || {};
    const room = await this.ensureRoom();
    if (!att.id) return;
    const res = room.leave(att.id);
    ws.serializeAttachment({ id: null });
    if (res.empty) {
      try { await this.state.storage.deleteAll(); } catch (_) {}
    } else {
      await this.persistMeta();
    }
    try { ws.close(1000, 'left'); } catch (_) {}
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (!att.id) return;
    const room = await this.ensureRoom();
    const res = room.leave(att.id);
    if (res.empty) {
      try { await this.state.storage.deleteAll(); } catch (_) {}
    } else {
      await this.persistMeta();
    }
  }

  async webSocketError(ws) {
    try { await this.webSocketClose(ws); } catch (_) {}
  }
}

/* ==================================================================== */
/* Worker utama                                                          */
/* ==================================================================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- WebSocket signaling ---
    if (url.pathname === '/ws') {
      const room = cleanRoomId(url.searchParams.get('room'));
      if (!room) {
        return new Response('room wajib diisi', { status: 400 });
      }
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response(JSON.stringify({ ok: true, ws: 'butuh upgrade' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // --- konfigurasi ICE ---
    if (url.pathname === '/config') {
      return new Response(
        JSON.stringify({ iceServers: iceServersFromEnv(env), maxPeers: maxPeersFrom(env) }),
        { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
      );
    }

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, runtime: 'cloudflare-worker' }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    // --- link rapat: /r/kode-rapat -> index.html ---
    if (/^\/r\/[^/]+\/?$/.test(url.pathname)) {
      const indexUrl = new URL('/', url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    // --- file statis ---
    return env.ASSETS.fetch(request);
  },
};
