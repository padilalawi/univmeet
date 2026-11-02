/* ==========================================================================
   UnivMeet client — WebRTC mesh
   - signaling via Socket.IO
   - video/audio P2P (server cuma relay offer/answer/ICE)
   ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const S = {
    socket: null,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    maxPeers: 8,
    room: null,
    name: '',
    selfId: null,
    isHost: false,
    locked: false,
    localStream: null,
    audioTrack: null,
    videoTrack: null,
    micOn: true,
    camOn: true,
    screenStream: null,
    peers: new Map(), // id -> peer
    unread: 0,
    joined: false,
    leaving: false,
    volume: 1,
    audioBlocked: false,
  };

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  const el = {
    landing: $('#landing'),
    room: $('#room'),
    joinForm: $('#join-form'),
    inName: $('#in-name'),
    inCode: $('#in-code'),
    hint: $('#land-hint'),
    btnCreate: $('#btn-create'),
    btnJoin: $('#btn-join'),
    grid: $('#grid'),
    gridEmpty: $('#grid-empty'),
    code: $('#room-code'),
    people: $('#people-count'),
    peopleList: $('#people-list'),
    btnCopy: $('#btn-copy'),
    btnCopy2: $('#btn-copy2'),
    btnLock: $('#btn-lock'),
    btnMic: $('#btn-mic'),
    btnCam: $('#btn-cam'),
    btnScreen: $('#btn-screen'),
    btnChat: $('#btn-chat'),
    btnLeave: $('#btn-leave'),
    chatBadge: $('#chat-badge'),
    side: $('#side'),
    chatLog: $('#chat-log'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    sideClose: $('#btn-side-close'),
    liveDot: $('#live-dot'),
    toast: $('#toast'),
    kick: $('#kick-screen'),
    maxPeers: $('#max-peers'),
    year: $('#year'),
  };

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2400);
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
  }

  function setHint(msg, isErr) {
    el.hint.textContent = msg || '';
    el.hint.classList.toggle('err', !!isErr);
  }

  const WORDS = ['kampus', 'kelas', 'rapat', 'tim', 'dosen', 'mhs', 'lab', 'sidang', 'kelompok', 'prodi', 'diskusi', 'tugas'];

  function newRoomCode() {
    const a = WORDS[Math.floor(Math.random() * WORDS.length)];
    const b = WORDS[Math.floor(Math.random() * WORDS.length)];
    const n = Math.floor(100 + Math.random() * 900);
    return `${a}-${b}-${n}`;
  }

  function cleanCode(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 48);
  }

  function roomFromUrl() {
    const m = location.pathname.match(/^\/r\/([^/?#]+)/);
    if (m) return cleanCode(decodeURIComponent(m[1]));
    const q = new URLSearchParams(location.search).get('room');
    return q ? cleanCode(q) : '';
  }

  /* ------------------------------------------------------------------ */
  /* media                                                              */
  /* ------------------------------------------------------------------ */

  async function acquireMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      attachLocalTracks(stream);
      return true;
    } catch (err) {
      // coba audio saja
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        attachLocalTracks(stream);
        S.camOn = false;
        toast('Kamera tidak bisa diakses — masuk mode suara saja');
        return true;
      } catch (err2) {
        S.camOn = false;
        S.micOn = false;
        toast('Kamera & mikrofon tidak tersedia — masuk tanpa media');
        return false;
      }
    }
  }

  function attachLocalTracks(stream) {
    S.audioTrack = stream.getAudioTracks()[0] || null;
    S.videoTrack = stream.getVideoTracks()[0] || null;
    if (S.audioTrack) S.audioTrack.enabled = S.micOn;
    if (S.videoTrack) S.videoTrack.enabled = S.camOn;
    S.localStream = new MediaStream([S.audioTrack, S.videoTrack].filter(Boolean));
    if (!S.audioTrack) S.micOn = false;
    if (!S.videoTrack) S.camOn = false;
  }

  function currentOutVideoTrack() {
    if (S.screenStream) {
      const t = S.screenStream.getVideoTracks()[0];
      if (t) return t;
    }
    return S.camOn && S.videoTrack ? S.videoTrack : null;
  }

  function pushVideoToPeers() {
    const track = currentOutVideoTrack();
    for (const p of S.peers.values()) {
      if (!p.videoSender) continue;
      try { p.videoSender.replaceTrack(track); } catch (_) {}
    }
  }

  function addRemoteTrack(peer, track) {
    if (!track) return;
    const existing = peer.remoteStream.getTracks().find((t) => t.kind === track.kind);
    if (existing === track) return;
    if (existing) peer.remoteStream.removeTrack(existing);
    peer.remoteStream.addTrack(track);
    if (track.kind === 'video') {
      track.onunmute = () => updateTileState(peer.id, { camOff: false });
      track.onmute = () => updateTileState(peer.id, { camOff: true });
    }
  }

  // Receiver selalu ada untuk setiap m-line; ontrack kadang telat / tanpa MSID,
  // jadi kita rekonsiliasi langsung dari getReceivers().
  function syncRemoteStream(peer) {
    try {
      for (const r of peer.pc.getReceivers()) {
        if (r.track) addRemoteTrack(peer, r.track);
      }
    } catch (_) {}
    setTileVideo(peer.id, peer.remoteStream);
  }

  /* ------------------------------------------------------------------ */
  /* tiles                                                              */
  /* ------------------------------------------------------------------ */

  function tileId(id) { return 'tile-' + id; }

  const ICONS = {
    mic: '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" fill="currentColor" opacity=".45"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    camOff: '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm12 3.4 4-2.4c.5-.3 1.1.05 1.1.63v6.74c0 .58-.6.93-1.1.63l-4-2.4v-3.2z" fill="currentColor" opacity=".45"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  function makeTile(id, { local = false, name = 'Tamu' } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'tile connecting' + (local ? ' mirror' : '');
    wrap.id = tileId(id);

    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = initials(name);

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = local;

    const tag = document.createElement('div');
    tag.className = 'tag';
    const micIco = document.createElement('span');
    micIco.className = 'mini mic';
    micIco.innerHTML = ICONS.mic;
    const camIco = document.createElement('span');
    camIco.className = 'mini cam hidden';
    camIco.innerHTML = ICONS.camOff;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    tag.append(micIco, camIco, nm);

    wrap.append(av, vid, tag);
    return wrap;
  }

  function getTile(id) {
    return document.getElementById(tileId(id));
  }

  function ensureTile(id, opts) {
    let tile = getTile(id);
    if (!tile) {
      tile = makeTile(id, opts || {});
      el.grid.appendChild(tile);
    }
    return tile;
  }

  function setTileVideo(id, stream) {
    const tile = getTile(id);
    if (!tile) return;
    const vid = tile.querySelector('video');
    if (vid && vid.srcObject !== stream) {
      vid.srcObject = stream;
      vid.volume = S.volume;
      const play = vid.play();
      if (play && play.catch) {
        play.catch((err) => {
          // Browser memblokir autoplay audio -> suara tidak keluar tanpa error.
          // Tandai supaya muncul tombol "Aktifkan suara".
          if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
            S.audioBlocked = true;
            showAudioUnlock();
          }
        });
      }
    }
    tile.classList.remove('connecting');
  }

  function showAudioUnlock() {
    const el2 = document.getElementById('audio-unlock');
    if (el2) el2.classList.remove('hidden');
  }

  function hideAudioUnlock() {
    const el2 = document.getElementById('audio-unlock');
    if (el2) el2.classList.add('hidden');
    S.audioBlocked = false;
  }

  // Dipanggil dari klik pengguna -> izinkan browser memutar audio
  async function unlockAudio() {
    let ok = 0;
    for (const vid of document.querySelectorAll('#grid video')) {
      try {
        vid.muted = vid.closest('.tile') && vid.closest('.tile').classList.contains('mirror') ? true : false;
        vid.volume = S.volume;
        await vid.play();
        ok++;
      } catch (_) {}
    }
    hideAudioUnlock();
    toast(ok > 1 ? 'Suara diaktifkan' : 'Suara diaktifkan');
  }

  function setVolume(v) {
    S.volume = Math.min(1, Math.max(0, Number(v)));
    for (const vid of document.querySelectorAll('#grid video')) {
      if (vid.closest('.tile') && vid.closest('.tile').classList.contains('mirror')) continue;
      vid.volume = S.volume;
    }
    const sl = document.getElementById('vol-slider');
    if (sl) sl.value = String(Math.round(S.volume * 100));
    const lbl = document.getElementById('vol-label');
    if (lbl) lbl.textContent = Math.round(S.volume * 100) + '%';
    try { localStorage.setItem('univmeet:volume', String(S.volume)); } catch (_) {}
  }

  function updateTileState(id, { name, muted, camOff, screen, isHost } = {}) {
    const tile = getTile(id);
    if (!tile) return;
    const av = tile.querySelector('.avatar');
    const nm = tile.querySelector('.tag .nm');
    const mic = tile.querySelector('.tag .mini.mic');
    const cam = tile.querySelector('.tag .mini.cam');

    if (typeof name === 'string' && nm) {
      nm.textContent = name;
      if (av) av.textContent = initials(name);
    }
    if (typeof muted === 'boolean' && mic) {
      mic.innerHTML = muted ? ICONS.micOff : ICONS.mic;
      mic.classList.toggle('off', muted);
    }
    if (typeof camOff === 'boolean' && cam) {
      cam.classList.toggle('hidden', !camOff);
    }
    const wantAvatar = !!camOff && !screen;
    if (av) av.style.display = wantAvatar ? 'grid' : 'none';
    tile.classList.toggle('screen', !!screen);

    let hostBadge = tile.querySelector('.badge-host');
    if (isHost && !hostBadge) {
      hostBadge = document.createElement('div');
      hostBadge.className = 'badge-host';
      hostBadge.textContent = 'HOST';
      tile.appendChild(hostBadge);
    } else if (!isHost && hostBadge) {
      hostBadge.remove();
    }

    let screenBadge = tile.querySelector('.badge-screen');
    if (screen && !screenBadge) {
      screenBadge = document.createElement('div');
      screenBadge.className = 'badge-screen';
      screenBadge.textContent = 'LAYAR';
      tile.appendChild(screenBadge);
    } else if (!screen && screenBadge) {
      screenBadge.remove();
    }
  }

  function syncGridCount() {
    const total = 1 + S.peers.size;
    el.grid.dataset.count = String(Math.min(total, 9));
    el.gridEmpty.classList.toggle('hidden', S.peers.size > 0);
    el.people.textContent = `${total} peserta`;
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC peers                                                       */
  /* ------------------------------------------------------------------ */

  // Untuk sisi yang menjawab: pakai transceiver hasil offer, pasang track kita di sana.
  function adoptTransceivers(peer) {
    try {
      for (const tx of peer.pc.getTransceivers()) {
        const kind = tx.receiver && tx.receiver.track ? tx.receiver.track.kind : null;
        if (!kind) continue;
        tx.direction = 'sendrecv';
        if (kind === 'audio') {
          peer.audioTx = tx;
          peer.audioSender = tx.sender;
          try { tx.sender.replaceTrack(S.micOn ? S.audioTrack : null); } catch (_) {}
        } else if (kind === 'video') {
          peer.videoTx = tx;
          peer.videoSender = tx.sender;
          try { tx.sender.replaceTrack(currentOutVideoTrack()); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  function createPeer(id, initiator) {
    if (S.peers.has(id)) return S.peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: S.iceServers, bundlePolicy: 'max-bundle' });
    const peer = {
      id,
      pc,
      initiator,
      name: 'Peserta',
      muted: false,
      camOff: false,
      screen: false,
      remoteStream: new MediaStream(),
      pending: [],
      audioSender: null,
      videoSender: null,
    };

    // Kalau kita yang mulai (initiator): bikin transceiver sendiri + track + MSID.
    // Kalau kita yang menjawab: transceiver diadopsi dari offer (lihat adoptTransceivers),
    // karena transceiver lokal yang dibuat sebelum setRemoteDescription TIDAK terpasang
    // ke m-line offer -> jawaban jadi recvonly (media kita tidak terkirim).
    if (initiator) {
      const ls = S.localStream || new MediaStream();
      peer.audioTx = S.audioTrack
        ? pc.addTransceiver(S.audioTrack, { direction: 'sendrecv', streams: [ls] })
        : pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.videoTx = S.videoTrack
        ? pc.addTransceiver(S.videoTrack, { direction: 'sendrecv', streams: [ls] })
        : pc.addTransceiver('video', { direction: 'sendrecv' });
      peer.audioSender = peer.audioTx.sender;
      peer.videoSender = peer.videoTx.sender;

      try {
        peer.audioSender.replaceTrack(S.micOn ? S.audioTrack : null);
        peer.videoSender.replaceTrack(currentOutVideoTrack());
      } catch (_) {}
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(id, { type: 'candidate', candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
      if (e.track) addRemoteTrack(peer, e.track);
      syncRemoteStream(peer);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        const tile = getTile(id);
        if (tile) tile.classList.remove('connecting');
        syncRemoteStream(peer);
      } else if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        // biarkan UI; cleanup terjadi saat peer-left
      }
    };

    S.peers.set(id, peer);
    const existingTile = ensureTile(id, { name: peer.name });
    // jangan nimpa nama yang sudah diketahui (mis. dari event peer-joined / peers)
    const labelEl = existingTile.querySelector('.tag .nm');
    if (labelEl && labelEl.textContent && labelEl.textContent.trim() && labelEl.textContent !== 'Peserta') {
      peer.name = labelEl.textContent.trim();
    }
    updateTileState(id, { muted: false, camOff: true });
    syncGridCount();

    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          offer.sdp = tuneAudioSdp(offer.sdp);
          await pc.setLocalDescription(offer);
          sendSignal(id, { type: 'offer', sdp: pc.localDescription });
        } catch (err) {
          console.warn('offer failed', err);
        }
      };
    }

    return peer;
  }

  function sendSignal(to, data) {
    if (!S.socket) return;
    S.socket.emit('signal', { to, data });
  }

  async function handleSignal({ from, data }) {
    if (!data) return;

    if (data.type === 'offer') {
      const peer = createPeer(from, false);
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushPending(peer);
        adoptTransceivers(peer);
        syncRemoteStream(peer);
        const answer = await peer.pc.createAnswer();
        answer.sdp = tuneAudioSdp(answer.sdp);
        await peer.pc.setLocalDescription(answer);
        sendSignal(from, { type: 'answer', sdp: peer.pc.localDescription });
      } catch (err) {
        console.warn('answer failed', err);
      }
      return;
    }

    if (data.type === 'answer') {
      const peer = S.peers.get(from);
      if (!peer) return;
      try {
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          await flushPending(peer);
          syncRemoteStream(peer);
        }
      } catch (err) {
        console.warn('setRemote(answer) failed', err);
      }
      return;
    }

    if (data.type === 'candidate') {
      const peer = S.peers.get(from);
      if (!peer) return;
      if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
      } else {
        peer.pending.push(data.candidate);
      }
    }
  }

  async function flushPending(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }

  function destroyPeer(id) {
    const peer = S.peers.get(id);
    if (peer) {
      try { peer.pc.close(); } catch (_) {}
      S.peers.delete(id);
    }
    const tile = getTile(id);
    if (tile) tile.remove();
    syncGridCount();
    renderPeople();
  }

  function destroyAllPeers() {
    for (const id of Array.from(S.peers.keys())) destroyPeer(id);
  }

  /* ------------------------------------------------------------------ */
  /* Audio tuning: Opus FEC supaya suara tetap jelas saat jaringan goyang */
  /* ------------------------------------------------------------------ */

  function tuneAudioSdp(sdp) {
    if (!sdp) return sdp;
    try {
      const lines = sdp.split('\r\n');
      // cari payload type untuk opus
      const opusLine = lines.find((l) => /^a=rtpmap:\d+ opus\/48000/i.test(l));
      if (!opusLine) return sdp;
      const pt = opusLine.match(/^a=rtpmap:(\d+)/)[1];

      let touched = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l.startsWith('a=fmtp:' + pt)) continue;
        const want = ['useinbandfec=1', 'stereo=0', 'sprop-stereo=0', 'maxaveragebitrate=64000'];
        let params = l.slice(('a=fmtp:' + pt).length).trim();
        for (const w of want) {
          const key = w.split('=')[0];
          if (new RegExp('(^|;)' + key + '=').test(params)) {
            params = params.replace(new RegExp(key + '=[^;]*'), w);
          } else {
            params = params ? params + ';' + w : w;
          }
        }
        lines[i] = 'a=fmtp:' + pt + ' ' + params;
        touched = true;
      }
      return touched ? lines.join('\r\n') : sdp;
    } catch (_) {
      return sdp;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Indikator bicara (audioLevel dari getStats)                         */
  /* ------------------------------------------------------------------ */

  let levelTimer = null;

  function startLevelMonitor() {
    if (levelTimer) return;
    levelTimer = setInterval(async () => {
      for (const p of S.peers.values()) {
        try {
          const rep = await p.pc.getStats();
          let level = 0;
          rep.forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number') {
              level = Math.max(level, s.audioLevel);
            }
          });
          const tile = getTile(p.id);
          if (tile) tile.classList.toggle('speaking', level > 0.02);
        } catch (_) {}
      }
    }, 700);
  }

  function stopLevelMonitor() {
    if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* socket                                                             */
  /* ------------------------------------------------------------------ */

  function connectSocket(roomId) {
    if (S.socket && S.socketRoom === roomId) return;
    if (S.socket) {
      try { S.socket.disconnect(); } catch (_) {}
      S.socket = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // room ikut di URL supaya server (Durable Object) bisa langsung pilih ruang yang benar
    const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomId || '')}`;
    const socket = new WSClient(url);
    S.socket = socket;
    S.socketRoom = roomId;
    let hadConnection = false;

    socket.on('connect', () => {
      el.liveDot.classList.remove('off');
      // hanya re-join kalau ini koneksi ULANG (bukan koneksi pertama)
      if (hadConnection && S.joined && S.room) {
        doJoin(S.room, S.name, true);
      }
      hadConnection = true;
    });

    socket.on('disconnect', () => {
      el.liveDot.classList.add('off');
      if (!S.leaving) toast('Koneksi terputus — mencoba menyambung ulang…');
    });

    socket.on('signal', handleSignal);

    socket.on('peer-joined', ({ id, name }) => {
      ensureTile(id, { name });
      updateTileState(id, { name, muted: false, camOff: true });
      syncGridCount();
    });

    socket.on('peer-left', ({ id }) => {
      destroyPeer(id);
      renderPeople();
    });

    socket.on('peer-state', ({ id, muted, camOff, screen }) => {
      const peer = S.peers.get(id);
      if (peer) {
        peer.muted = !!muted;
        peer.camOff = !!camOff;
        peer.screen = !!screen;
        updateTileState(id, { muted: peer.muted, camOff: peer.camOff, screen: peer.screen });
      }
      renderPeople();
    });

    socket.on('peers', ({ peers, host, locked }) => {
      S.isHost = host === S.selfId;
      S.locked = !!locked;
      updateLockUi();
      for (const p of peers) {
        const peer = S.peers.get(p.id);
        if (peer) {
          peer.name = p.name || peer.name;
          peer.muted = !!p.muted;
          peer.camOff = !!p.camOff;
          peer.screen = !!p.screen;
        }
        ensureTile(p.id, { name: p.name });
        updateTileState(p.id, { name: p.name, muted: !!p.muted, camOff: !!p.camOff, screen: !!p.screen, isHost: host === p.id });
      }
      updateTileState(S.selfId, { name: S.name, isHost: host === S.selfId });
      renderPeople();
    });

    socket.on('host', () => {
      S.isHost = true;
      updateLockUi();
      renderPeople();
      toast('Kamu sekarang host rapat');
    });

    socket.on('chat', (msg) => onChat(msg));

    socket.on('kicked', () => {
      S.leaving = true;
      stopAllMedia();
      el.kick.classList.remove('hidden');
      if (S.socket) S.socket.disconnect();
    });
  }

  /* ------------------------------------------------------------------ */
  /* join flow                                                          */
  /* ------------------------------------------------------------------ */

  async function doJoin(room, name, isRejoin) {
    if (S.joined && !isRejoin) {
      if (S.room === room) {
        toast('Kamu sudah ada di rapat ini');
        return;
      }
      hardLeave();
      el.grid.innerHTML = '';
    }

    if (!S.joined) {
      S.room = room;
      S.name = name;
      S.joined = true;
      await acquireMedia();
      buildLocalTile();
    }

    connectSocket(room);
    S.socket.emit('join', { room, name }, (res) => {
      if (!res || !res.ok) {
        const msg = (res && res.error) || 'Gagal masuk rapat.';
        hardLeave();
        el.grid.innerHTML = '';
        if (!isRejoin) backToLanding(msg);
        else toast(msg);
        return;
      }

      if (isRejoin) destroyAllPeers();

      S.selfId = res.selfId;
      if (S.socket) S.socket.id = res.selfId;
      S.isHost = !!res.host;
      S.locked = !!res.locked;
      S.maxPeers = res.maxPeers || S.maxPeers;

      el.room.classList.remove('hidden');
      el.landing.classList.add('hidden');
      el.code.textContent = res.room;
      document.title = `${res.room} · UnivMeet`;
      history.replaceState({}, '', '/r/' + res.room);

      // bersihkan tile lama (rejoin / reconnect / tile preview pra-join)
      destroyAllPeers();
      el.grid.innerHTML = '';

      buildLocalTile();
      updateLockUi();
      syncGridCount();
      markScreenAvailability();

      // peserta yang sudah ada -> kita yang jadi initiator
      for (const p of res.peers || []) {
        ensureTile(p.id, { name: p.name });
        updateTileState(p.id, { name: p.name, muted: p.muted, camOff: p.camOff, screen: p.screen });
        const peer = createPeer(p.id, true);
        peer.name = p.name;
        peer.muted = !!p.muted;
        peer.camOff = !!p.camOff;
        peer.screen = !!p.screen;
        updateTileState(p.id, { name: p.name, muted: !!p.muted, camOff: !!p.camOff, screen: !!p.screen });
      }

      renderPeople();
      syncGridCount();
      markScreenAvailability();
      startLevelMonitor();

      // pulihkan volume terakhir
      try {
        const savedVol = localStorage.getItem('univmeet:volume');
        if (savedVol !== null) setVolume(Number(savedVol));
      } catch (_) {}

      if (!isRejoin) {
        const link = location.origin + '/r/' + res.room;
        addSystemMsg(`Link rapat: ${link}`);
        toast('Rapat siap — copy link buat ngajak orang');
      }
      syncControls();
    });
  }

  function backToLanding(msg) {
    S.joined = false;
    S.room = null;
    S.selfId = null;
    el.room.classList.add('hidden');
    el.landing.classList.remove('hidden');
    document.title = 'UnivMeet — Rapat Online Gratis';
    history.replaceState({}, '', '/');
    if (msg) setHint(msg, true);
    syncControls();
  }

  // keluar total dari state rapat tanpa pindah halaman
  function hardLeave() {
    if (S.socket) S.socket.emit('leave');
    destroyAllPeers();
    stopAllMedia();
    stopLevelMonitor();
    hideAudioUnlock();
    S.joined = false;
    S.room = null;
    S.selfId = null;
    S.isHost = false;
    S.locked = false;
    S.unread = 0;
  }

  function buildLocalTile() {
    const id = S.selfId || 'self';
    const tile = ensureTile(id, { local: true, name: S.name });
    tile.classList.add('mirror');
    const vid = tile.querySelector('video');
    if (vid) vid.muted = true;
    const av = tile.querySelector('.avatar');
    if (av) av.textContent = initials(S.name);
    const nm = tile.querySelector('.tag .nm');
    if (nm) nm.textContent = S.name + ' (kamu)';
    setTileVideo(id, S.localStream);
    updateTileState(id, {
      name: S.name + ' (kamu)',
      muted: !S.micOn,
      camOff: !S.camOn,
      screen: !!S.screenStream,
      isHost: S.isHost,
    });
    syncGridCount();
  }

  /* ------------------------------------------------------------------ */
  /* controls                                                           */
  /* ------------------------------------------------------------------ */

  function syncControls() {
    el.btnMic.classList.toggle('off', !S.micOn);
    el.btnMic.querySelector('span').textContent = S.micOn ? 'Mic' : 'Mute';
    el.btnCam.classList.toggle('off', !S.camOn);
    el.btnCam.querySelector('span').textContent = S.camOn ? 'Kamera' : 'Cam off';
    el.btnScreen.classList.toggle('active', !!S.screenStream);
    el.btnChat.classList.toggle('active', !el.side.classList.contains('hidden'));
  }

  function updateLockUi() {
    el.btnLock.textContent = S.locked ? '🔒 Terkunci' : '🔓 Kunci';
    el.btnLock.title = S.isHost ? 'Klik untuk kunci/buka rapat' : 'Hanya host yang bisa mengunci rapat';
    el.btnLock.style.opacity = S.isHost ? '1' : '.55';
  }

  function broadcastState() {
    if (!S.socket || !S.joined) return;
    S.socket.emit('state', { muted: !S.micOn, camOff: !S.camOn, screen: !!S.screenStream });
    updateTileState(S.selfId, {
      name: S.name + ' (kamu)',
      muted: !S.micOn,
      camOff: !S.camOn,
      screen: !!S.screenStream,
      isHost: S.isHost,
    });
  }

  function toggleMic() {
    S.micOn = !S.micOn;
    if (S.audioTrack) S.audioTrack.enabled = S.micOn;
    for (const p of S.peers.values()) {
      try { p.audioSender.replaceTrack(S.micOn ? S.audioTrack : null); } catch (_) {}
    }
    if (!S.audioTrack) {
      toast('Mikrofon tidak terdeteksi di perangkat ini');
    }
    syncControls();
    broadcastState();
  }

  function toggleCam() {
    if (!S.videoTrack) {
      toast('Kamera tidak terdeteksi di perangkat ini');
      return;
    }
    S.camOn = !S.camOn;
    S.videoTrack.enabled = S.camOn;
    if (!S.screenStream) pushVideoToPeers();
    syncControls();
    broadcastState();
  }

  function isMobileDevice() {
    const ua = navigator.userAgent || '';
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || (coarse && Math.min(screen.width, screen.height) < 820);
  }

  function inIframe() {
    try { return window.self !== window.top; } catch (_) { return true; }
  }

  // Tombol Layar: tandai kalau perangkat ini memang tidak bisa share layar,
  // supaya pengguna tidak menebak-nebak kenapa "tidak terjadi apa-apa".
  function markScreenAvailability() {
    const btn = el.btnScreen;
    if (!btn) return;
    const label = btn.querySelector('span');
    const blockedByIframe = inIframe();
    const noApi = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    const mobile = isMobileDevice();

    if (blockedByIframe || noApi || mobile) {
      btn.classList.add('na');
      btn.title = blockedByIframe
        ? 'Share layar tidak bisa di dalam panel preview — buka di tab browser'
        : mobile
          ? 'Share layar hanya dari laptop/PC, bukan HP'
          : 'Browser ini tidak mendukung share layar';
      if (label && !S.screenStream) label.textContent = 'Layar ✕';
    } else {
      btn.classList.remove('na');
      btn.title = 'Share layar';
      if (label && !S.screenStream) label.textContent = 'Layar';
    }
  }

  async function toggleScreen() {
    if (S.screenStream) return stopScreen();

    const btnLabel = el.btnScreen.querySelector('span');
    const resetBtn = () => { if (btnLabel) btnLabel.textContent = 'Layar'; };
    if (btnLabel) btnLabel.textContent = 'Membuka…';
    setTimeout(resetBtn, 1200);

    // Diagnosa awal: kasih tau user APA yang kurang, jangan diam
    const inIframe = (() => { try { return window.self !== window.top; } catch (_) { return true; } })();
    const diag = {
      secure: window.isSecureContext,
      hasMediaDevices: !!(navigator.mediaDevices),
      hasGetDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      inIframe,
      ua: navigator.userAgent,
      origin: location.origin,
      focused: document.hasFocus(),
    };

    // Share layar DIBLOKIR di dalam iframe (panel preview, embed, dsb).
    // Ini kebijakan browser (Permissions Policy: display-capture), bukan bug app.
    if (inIframe) {
      resetBtn();
      screenFailModal(diag, null);
      return;
    }

    if (!diag.hasGetDisplayMedia) {
      resetBtn();
      screenFailModal(diag, null);
      return;
    }

    // opsi lengkap dulu; kalau browser menolak, ulangi dengan opsi minimal
    let stream = null;
    let lastErr = null;
    const tries = [
      { video: { frameRate: { ideal: 15, max: 30 } }, audio: false, selfBrowserSurface: 'include', surfaceSwitching: 'include', systemAudio: 'exclude' },
      { video: { frameRate: 15 }, audio: false },
      { video: true, audio: false },
    ];
    for (const opts of tries) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(opts);
        break;
      } catch (err) {
        lastErr = err;
        // user membatalkan / izin ditolak -> jangan coba opsi lain
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) break;
      }
    }

    if (!stream) {
      resetBtn();
      screenFailModal(diag, lastErr);
      return;
    }

    try {
      S.screenStream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stopScreen();
        toast('Tidak ada video pada sumber yang dipilih');
        return;
      }
      track.onended = () => stopScreen();

      pushVideoToPeers();

      const tile = getTile(S.selfId);
      if (tile) {
        const vid = tile.querySelector('video');
        if (vid) {
          vid.srcObject = stream;
          const pl = vid.play();
          if (pl && pl.catch) pl.catch(() => {});
        }
        tile.classList.remove('mirror');
      }
      updateTileState(S.selfId, { name: S.name + ' (kamu)', muted: !S.micOn, camOff: false, screen: true, isHost: S.isHost });
      syncControls();
      broadcastState();

      // verifikasi: kalau ada peer yang sender-nya belum ikut track layar, perbaiki
      const t = currentOutVideoTrack();
      for (const p of S.peers.values()) {
        if (!p.videoSender) {
          await repairVideoSender(p, t);
          continue;
        }
        if (p.videoSender.track && t && p.videoSender.track.id !== t.id) {
          try { await p.videoSender.replaceTrack(t); } catch (_) {}
        }
      }

      toast('Sedang share layar');
    } catch (err) {
      console.warn('[univmeet] gagal mulai share layar:', err);
      stopScreen();
      screenFailModal(diag, err);
    }
  }

  // Kalau peer belum punya sender video (mis. dibuat saat kamera mati),
  // tambahkan transceiver lalu negosiasi ulang.
  async function repairVideoSender(peer, track) {
    try {
      const tx = peer.pc.addTransceiver(track || 'video', { direction: 'sendrecv', streams: S.localStream ? [S.localStream] : [] });
      peer.videoTx = tx;
      peer.videoSender = tx.sender;
      if (track) { try { await tx.sender.replaceTrack(track); } catch (_) {} }

      if (peer.initiator) {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        sendSignal(peer.id, { type: 'offer', sdp: peer.pc.localDescription });
      }
    } catch (err) {
      console.warn('[univmeet] repairVideoSender gagal:', err);
    }
  }

  // Modal diagnosa share layar: tampil terus sampai ditutup, isinya penyebab + cara benerin
  async function screenFailModal(diag, err) {
    const nm = err && err.name ? err.name : 'TidakDidukung';
    const msg = err && err.message ? err.message : '';

    let permState = 'tidak diketahui';
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'display-capture' });
        permState = st.state;
      }
    } catch (_) {}

    const ua = diag.ua || navigator.userAgent || '';
    const browser = /Brave/i.test(ua) || navigator.brave ? 'Brave'
      : /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Firefox/i.test(ua) ? 'Firefox'
      : /Chrome/i.test(ua) ? 'Chrome'
      : 'browser ini';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

    const reasons = [];
    if (diag.inIframe) {
      reasons.push('Kamu membuka UnivMeet di dalam <b>panel preview / iframe</b>, bukan di browser. Browser <b>memblokir share layar di dalam iframe</b> — ini aturan keamanan browser, bukan kerusakan aplikasi.');
      reasons.push('Solusi: buka alamatnya di <b>tab browser sungguhan</b> (Chrome/Edge/Brave), lalu share layar dari sana.');
    }
    if (mobile) {
      reasons.push('Browser di HP umumnya <b>tidak mendukung</b> share layar. Pakai laptop/PC.');
    }
    if (!diag.secure) {
      reasons.push('Halaman tidak HTTPS — share layar diblokir. Buka lewat <b>https://</b>.');
    }
    if (permState === 'denied') {
      reasons.push('Izin share layar pernah <b>ditolak</b> dan masih diingat browser, jadi jendela pilih layar tidak muncul lagi.');
    }
    if (nm === 'NotAllowedError' || nm === 'AbortError') {
      reasons.push('Permintaan ditolak / dibatalkan (bisa karena jendela pilih layar ditutup, atau izin diblokir).');
    }
    if (nm === 'NotSupportedError' || nm === 'TidakDidukung') {
      reasons.push('Perangkat/browser ini melaporkan share layar tidak didukung.');
    }
    if (nm === 'InvalidStateError') {
      reasons.push('Permintaan tidak dianggap aksi pengguna. Klik ulang tombol Layar (jangan lewat skrip/otomatis).');
    }
    if (/Brave/i.test(browser)) {
      reasons.push('Di Brave, proteksi Shields kadang memblokir share layar — coba turunkan Shields untuk situs ini.');
    }
    if (!reasons.length) {
      reasons.push('Penyebab belum pasti — lihat detail teknis di bawah.');
    }

    const steps = diag.inIframe
      ? [
          'Copy alamat ini: <code>' + diag.origin + '</code>',
          'Buka di <b>tab browser</b> (Chrome / Edge / Brave) — bukan di panel preview.',
          'Masuk rapat seperti biasa, lalu klik <b>Layar</b>.',
        ]
      : [
          `Klik ikon <b>gembok</b> / <b>tune</b> di kiri alamat <code>${diag.origin}</code>.`,
          'Cari pengaturan <b>Layar / Screen sharing / Display capture</b>, ubah ke <b>Allow / Izinkan</b>.',
          'Kalau tidak ada: buka <code>chrome://settings/content/capture</code> (Brave: <code>brave://settings/content/capture</code>), hapus situs dari daftar blokir.',
          'Tutup tab, buka lagi <code>' + diag.origin + '</code>, lalu klik <b>Layar</b> sekali lagi.',
        ];

    const detail = JSON.stringify({ error: nm, message: msg, permission: permState, ...diag }, null, 2);

    const old = document.getElementById('screen-fail');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = 'screen-fail';
    wrap.className = 'sf-overlay';
    wrap.innerHTML = `
      <div class="sf-card">
        <h3>Share layar gagal</h3>
        <p class="sf-sub">Browser: <b>${browser}</b> · izin: <b>${permState}</b> · error: <b>${nm}</b></p>
        <ul class="sf-reasons">${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
        <div class="sf-steps">
          <div class="sf-steps-title">Cara benerin (${browser})</div>
          <ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        </div>
        <details class="sf-detail"><summary>Detail teknis</summary><pre>${detail.replace(/</g, '&lt;')}</pre></details>
        <div class="sf-actions">
          ${diag.inIframe ? `<a class="btn primary tiny" href="${diag.origin}" target="_blank" rel="noopener">Buka di browser</a>` : ''}
          <button class="btn primary tiny" id="sf-copy">Copy detail</button>
          <button class="btn ghost tiny" id="sf-close">Tutup</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => { try { wrap.remove(); } catch (_) {} };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#sf-close').addEventListener('click', close);
    wrap.querySelector('#sf-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(detail);
        toast('Detail dicopy — tempel ke chat biar gua bisa bantu');
      } catch (_) {
        toast('Gagal copy, salin manual dari Detail teknis');
      }
    });
  }

  function stopScreen() {
    if (!S.screenStream) return;
    for (const t of S.screenStream.getTracks()) {
      try { t.stop(); } catch (_) {}
    }
    S.screenStream = null;
    pushVideoToPeers();

    const tile = getTile(S.selfId);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = S.localStream;
      tile.classList.add('mirror');
    }
    updateTileState(S.selfId, { name: S.name + ' (kamu)', muted: !S.micOn, camOff: !S.camOn, screen: false, isHost: S.isHost });
    syncControls();
    broadcastState();
  }

  function stopAllMedia() {
    for (const stream of [S.localStream, S.screenStream]) {
      if (!stream) continue;
      for (const t of stream.getTracks()) {
        try { t.stop(); } catch (_) {}
      }
    }
    S.localStream = null;
    S.screenStream = null;
    S.audioTrack = null;
    S.videoTrack = null;
  }

  function leave() {
    S.leaving = true;
    if (S.socket) {
      S.socket.emit('leave');
      S.socket.disconnect();
    }
    stopAllMedia();
    destroyAllPeers();
    location.href = '/';
  }

  /* ------------------------------------------------------------------ */
  /* chat + people                                                      */
  /* ------------------------------------------------------------------ */

  function addSystemMsg(text) {
    const div = document.createElement('div');
    div.className = 'msg sys';
    div.textContent = text;
    el.chatLog.appendChild(div);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function onChat(msg) {
    const div = document.createElement('div');
    if (msg.system) {
      div.className = 'msg sys';
      div.textContent = msg.text;
    } else {
      div.className = 'msg' + (msg.id === S.selfId ? ' mine' : '');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.name || 'Peserta';
      div.append(who, document.createTextNode(msg.text));
      if (el.side.classList.contains('hidden') && msg.id !== S.selfId) {
        S.unread += 1;
        el.chatBadge.textContent = String(S.unread);
        el.chatBadge.classList.remove('hidden');
      }
    }
    el.chatLog.appendChild(div);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function renderPeople() {
    const list = el.peopleList;
    if (!list) return;
    list.innerHTML = '';

    const mk = (id, name, flags) => {
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'av';
      av.textContent = initials(name);
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = name + (id === S.selfId ? ' (kamu)' : '');
      const fl = document.createElement('div');
      fl.className = 'fl';
      fl.textContent = `Mic ${flags.muted ? 'off' : 'on'} · Kamera ${flags.camOff ? 'off' : 'on'}`;
      li.append(av, nm, fl);

      if (S.isHost && id !== S.selfId) {
        const kick = document.createElement('button');
        kick.className = 'kick';
        kick.textContent = 'Keluarkan';
        kick.onclick = () => {
          S.socket.emit('kick', { id });
        };
        li.appendChild(kick);
      }
      list.appendChild(li);
    };

    mk(S.selfId, S.name, { muted: !S.micOn, camOff: !S.camOn });
    for (const p of S.peers.values()) {
      mk(p.id, p.name, { muted: p.muted, camOff: p.camOff });
    }
  }

  function openSide(tab) {
    el.side.classList.remove('hidden');
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('#tab-chat').classList.toggle('hidden', tab !== 'chat');
    $('#tab-people').classList.toggle('hidden', tab !== 'people');
    if (tab === 'chat') {
      S.unread = 0;
      el.chatBadge.classList.add('hidden');
      el.chatInput.focus();
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
    }
    renderPeople();
    syncControls();
  }

  function closeSide() {
    el.side.classList.add('hidden');
    syncControls();
  }

  /* ------------------------------------------------------------------ */
  /* events                                                             */
  /* ------------------------------------------------------------------ */

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.inName.value.trim();
    const code = cleanCode(el.inCode.value);
    if (!name) return setHint('Isi nama dulu ya.', true);
    localStorage.setItem('univmeet:name', name);
    setHint('');
    doJoin(code || newRoomCode(), name, false);
  });

  el.btnJoin.addEventListener('click', () => {
    const name = el.inName.value.trim();
    const code = cleanCode(el.inCode.value);
    if (!name) return setHint('Isi nama dulu ya.', true);
    if (!code) return setHint('Isi kode rapat yang mau digabung.', true);
    localStorage.setItem('univmeet:name', name);
    setHint('');
    doJoin(code, name, false);
  });

  el.btnMic.addEventListener('click', toggleMic);
  el.btnCam.addEventListener('click', toggleCam);
  el.btnScreen.addEventListener('click', toggleScreen);
  el.btnLeave.addEventListener('click', leave);
  el.btnChat.addEventListener('click', () => {
    if (el.side.classList.contains('hidden')) openSide('chat');
    else closeSide();
  });
  el.sideClose.addEventListener('click', closeSide);
  $$('.tab').forEach((t) => t.addEventListener('click', () => openSide(t.dataset.tab)));

  el.btnLock.addEventListener('click', () => {
    if (!S.isHost) return toast('Hanya host yang bisa mengunci rapat');
    S.socket.emit('lock', { locked: !S.locked });
  });

  async function copyLink() {
    const link = location.origin + '/r/' + S.room;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link rapat dicopy');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Link rapat dicopy'); } catch (e) { toast(link); }
      ta.remove();
    }
  }
  el.btnCopy.addEventListener('click', copyLink);
  el.btnCopy2.addEventListener('click', copyLink);

  // ---- suara: unlock, volume, panel ----
  const unlockBtn = document.getElementById('btn-unlock');
  if (unlockBtn) unlockBtn.addEventListener('click', unlockAudio);

  const soundBtn = document.getElementById('btn-sound');
  const volPanel = document.getElementById('vol-panel');
  if (soundBtn && volPanel) {
    soundBtn.addEventListener('click', () => {
      volPanel.classList.toggle('hidden');
      soundBtn.classList.toggle('active', !volPanel.classList.contains('hidden'));
    });
  }

  const volSlider = document.getElementById('vol-slider');
  if (volSlider) {
    volSlider.addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));
  }

  // klik pertama di mana saja = kesempatan unlock audio (kebijakan autoplay browser)
  document.addEventListener('click', () => {
    if (!S.audioBlocked) return;
    unlockAudio();
  }, { once: false });

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    S.socket.emit('chat', { text });
    el.chatInput.value = '';
  });

  window.addEventListener('beforeunload', () => {
    if (S.socket && S.joined) S.socket.emit('leave');
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  async function boot() {
    el.year.textContent = String(new Date().getFullYear());
    window.__univmeet = S; // untuk debugging / e2e test
    markScreenAvailability();

    try {
      const cfg = await fetch('/config').then((r) => r.json());
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) S.iceServers = cfg.iceServers;
      if (cfg && cfg.maxPeers) {
        S.maxPeers = cfg.maxPeers;
        el.maxPeers.textContent = String(cfg.maxPeers);
      }
    } catch (_) {}

    const savedName = localStorage.getItem('univmeet:name') || '';
    if (savedName) el.inName.value = savedName;

    const code = roomFromUrl();
    if (code) {
      el.inCode.value = code;
      setHint(`Kamu diundang ke rapat "${code}" — isi nama lalu klik Gabung.`);
    }

    // koneksi WebSocket dibuat saat join (room ikut di URL)

    // undangan 1 klik: kalau nama sudah tersimpan, langsung masuk
    if (code && savedName) {
      doJoin(code, savedName, false);
    }
  }

  boot();
})();
