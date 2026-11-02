'use strict';

/**
 * UnivMeet — logika protokol rapat (dipakai bersama oleh server Node & Worker).
 * Semua state disimpan dalam satu "room" (di Node: Map, di Worker: Durable Object).
 *
 * Protokol (JSON lewat WebSocket):
 *   client -> server : { e: <event>, d: <data>, id?: <ackId> }
 *   server -> client : { e: 'ack', id: <ackId>, d: <data> }
 *                      { e: <event>, d: <data> }
 */

const MAX_PEERS_DEFAULT = 8;

function cleanRoomId(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48);
}

function publicPeers(peers, exceptId) {
  const out = [];
  for (const [id, p] of peers) {
    if (id === exceptId) continue;
    out.push({ id, name: p.name, muted: !!p.muted, camOff: !!p.camOff, screen: !!p.screen });
  }
  return out;
}

/**
 * Mesin satu ruang rapat.
 * `send(targetId, event, data)` mengirim ke satu peserta.
 * `broadcast(event, data, exceptId)` mengirim ke semua (opsional kecuali satu).
 */
class Room {
  constructor({ maxPeers = MAX_PEERS_DEFAULT, send, broadcast }) {
    this.maxPeers = Math.max(2, Number(maxPeers) || MAX_PEERS_DEFAULT);
    this.send = send;
    this.broadcast = broadcast;
    this.peers = new Map(); // id -> { name, muted, camOff, screen }
    this.host = null;
    this.locked = false;
  }

  get size() {
    return this.peers.size;
  }

  _broadcastPeers() {
    for (const id of this.peers.keys()) {
      this.send(id, 'peers', {
        peers: publicPeers(this.peers, id),
        host: this.host,
        locked: this.locked,
      });
    }
  }

  join(id, { room, name } = {}) {
    if (this.peers.has(id)) {
      return { ok: false, error: 'Kamu sudah ada di rapat ini.' };
    }
    const displayName = String(name || '').trim().slice(0, 32) || 'Tamu';

    if (this.peers.size === 0) {
      // ruang kosong -> host baru, kunci dibuka
      this.host = id;
      this.locked = false;
    }
    if (this.locked && this.host !== id) {
      return { ok: false, error: 'Rapat sedang dikunci oleh host.' };
    }
    if (this.peers.size >= this.maxPeers) {
      return { ok: false, error: `Rapat penuh (maksimal ${this.maxPeers} orang).` };
    }

    this.peers.set(id, { name: displayName, muted: false, camOff: false, screen: false });

    const res = {
      ok: true,
      selfId: id,
      room,
      host: this.host === id,
      locked: this.locked,
      peers: publicPeers(this.peers, id),
      maxPeers: this.maxPeers,
    };

    this.broadcast('peer-joined', { id, name: displayName }, id);
    this.broadcast('chat', { system: true, text: `${displayName} bergabung`, ts: Date.now() }, id);
    this._broadcastPeers();
    return res;
  }

  signal(id, { to, data } = {}) {
    if (!to || !data) return;
    if (!this.peers.has(to)) return;
    this.send(to, 'signal', { from: id, data });
  }

  setState(id, patch = {}) {
    const me = this.peers.get(id);
    if (!me) return;
    if (typeof patch.muted === 'boolean') me.muted = patch.muted;
    if (typeof patch.camOff === 'boolean') me.camOff = patch.camOff;
    if (typeof patch.screen === 'boolean') me.screen = patch.screen;
    this.broadcast('peer-state', { id, muted: me.muted, camOff: me.camOff, screen: me.screen }, id);
    this._broadcastPeers();
  }

  chat(id, { text } = {}) {
    const me = this.peers.get(id);
    if (!me) return;
    const clean = String(text || '').trim().slice(0, 800);
    if (!clean) return;
    this.broadcast('chat', { id, name: me.name, text: clean, ts: Date.now() });
  }

  lock(id, { locked } = {}) {
    if (this.host !== id) return;
    this.locked = !!locked;
    this._broadcastPeers();
    this.broadcast('chat', {
      system: true,
      text: this.locked
        ? 'Host mengunci rapat — peserta baru tidak bisa masuk'
        : 'Host membuka kunci rapat',
      ts: Date.now(),
    });
  }

  kick(id, { id: targetId } = {}) {
    if (this.host !== id || !targetId || targetId === id) return;
    const target = this.peers.get(targetId);
    if (!target) return;

    this.send(targetId, 'kicked', { by: id });
    this.peers.delete(targetId);
    this.broadcast('peer-left', { id: targetId, name: target.name }, targetId);
    this.broadcast('chat', { system: true, text: `${target.name} dikeluarkan host`, ts: Date.now() }, targetId);
    this._broadcastPeers();
  }

  /** Dipanggil saat peserta keluar/putus. Mengembalikan info untuk cleanup. */
  leave(id) {
    const me = this.peers.get(id);
    if (!me) return { empty: this.peers.size === 0, promoted: null };

    this.peers.delete(id);

    if (this.peers.size === 0) {
      this.host = null;
      this.locked = false;
      return { empty: true, promoted: null };
    }

    let promoted = null;
    if (this.host === id) {
      this.host = this.peers.keys().next().value;
      promoted = this.peers.get(this.host);
      this.send(this.host, 'host', { host: true });
      this.broadcast('chat', { system: true, text: `${promoted.name} sekarang jadi host`, ts: Date.now() });
    }

    this.broadcast('peer-left', { id, name: me.name }, id);
    this.broadcast('chat', { system: true, text: `${me.name} keluar`, ts: Date.now() }, id);
    this._broadcastPeers();
    return { empty: false, promoted };
  }
}

function iceServersFromEnv(env = {}) {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turnUrl = (env.TURN_URL || '').trim();
  if (turnUrl) {
    list.push({
      urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
      username: (env.TURN_USER || '').trim(),
      credential: (env.TURN_PASS || '').trim(),
    });
  } else {
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

module.exports = { Room, cleanRoomId, publicPeers, iceServersFromEnv, MAX_PEERS_DEFAULT };
