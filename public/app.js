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
      // Kualitas tinggi: minta 720p30 (WebRTC default hanya ~640x480 & bitrate kecil)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        },
        video: {
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 360 },
          frameRate: { ideal: 30, min: 15, max: 30 },
          facingMode: 'user',
          resizeMode: 'none',
        },
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
    // kamera
    for (const p of S.peers.values()) {
      if (!p.videoSender) continue;
      try { p.videoSender.replaceTrack(camTrack()); } catch (_) {}
    }
    // layar (jalur terpisah -> tidak menimpa kamera)
    pushScreenToPeers();
    applyContentHint();
    tuneAllSenders();
  }

  function pushScreenToPeers() {
    const t = screenTrack();
    for (const p of S.peers.values()) {
      if (!p.screenSender) continue;
      try { p.screenSender.replaceTrack(t); } catch (_) {}
    }
  }

  /* ------------------------------------------------------------------ */
  /* Kualitas media: WebRTC default cuma ~300 kbps -> gambar jelek        */
  /* Kita naikkan maxBitrate + atur prioritas & resolusi                  */
  /* ------------------------------------------------------------------ */

  const QUALITY = { camKbps: 2500, screenKbps: 4000, audioKbps: 64 };

  /**
   * Mesh: tiap orang upload ke SEMUA orang lain.
   * Jadi bitrate per-stream HARUS turun tajam saat peserta bertambah,
   * kalau tidak uplink habis dan semua peserta dapat gambar rusak.
   * Tabel di bawah = anggaran per stream (kbps) berdasarkan jumlah peserta.
   */
  function qualityTier(n) {
    if (n <= 2) return { cam: 2500, screen: 4000, maxH: 720, scale: 1.0 };
    if (n <= 4) return { cam: 1400, screen: 2500, maxH: 720, scale: 1.0 };
    if (n <= 6) return { cam: 900, screen: 1800, maxH: 720, scale: 1.0 };
    if (n <= 8) return { cam: 600, screen: 1200, maxH: 540, scale: 1.0 };
    if (n <= 12) return { cam: 380, screen: 900, maxH: 480, scale: 1.0 };
    if (n <= 16) return { cam: 260, screen: 700, maxH: 480, scale: 1.5 };
    if (n <= 20) return { cam: 190, screen: 550, maxH: 360, scale: 2.0 };
    return { cam: 140, screen: 420, maxH: 360, scale: 2.5 };
  }

  function currentTier() {
    return qualityTier(Math.max(1, S.peers.size));
  }

  async function tuneSender(sender, kind, attempt = 0) {
    if (!sender || typeof sender.getParameters !== 'function') return false;

    let params;
    try { params = sender.getParameters(); } catch (_) { return false; }

    // Sebelum negosiasi selesai, encodings masih kosong. JANGAN bikin encodings
    // palsu (Chrome menolak: InvalidModificationError) -> tunggu lalu coba lagi.
    if (!params.encodings || params.encodings.length === 0) {
      if (attempt < 8) {
        setTimeout(() => tuneSender(sender, kind, attempt + 1), 300 * (attempt + 1));
      }
      return false;
    }

    try {
      const tier = currentTier();
      const isScreen = kind === 'screen';
      const kbps = kind === 'audio' ? QUALITY.audioKbps : (isScreen ? tier.screen : tier.cam);
      const wantBitrate = kbps * 1000;
      const wantScale = kind === 'audio' ? 1 : (isScreen ? 1.0 : tier.scale);

      // sudah sesuai -> tidak perlu setParameters (hindari kerja sia-sia)
      const enc0 = params.encodings[0];
      if (enc0 && enc0.maxBitrate === wantBitrate && (kind === 'audio' || enc0.scaleResolutionDownBy === wantScale)) {
        return true;
      }

      for (const enc of params.encodings) {
        enc.maxBitrate = wantBitrate;
        if (kind !== 'audio') {
          enc.maxFramerate = 30;
          // kamera: turunkan resolusi saat peserta banyak (layar jangan, teks jadi burem)
          enc.scaleResolutionDownBy = wantScale;
        }
        if ('priority' in enc) enc.priority = 'high';
        if ('networkPriority' in enc) enc.networkPriority = 'high';
      }
      if (kind !== 'audio' && 'degradationPreference' in params) {
        params.degradationPreference = isScreen ? 'maintain-resolution' : 'balanced';
      }

      await sender.setParameters(params);
      return true;
    } catch (err) {
      // gagal (mis. transceiver belum siap) -> coba lagi dengan jeda
      if (attempt < 8) {
        setTimeout(() => tuneSender(sender, kind, attempt + 1), 300 * (attempt + 1));
      } else {
        console.warn('[univmeet] setParameters gagal:', kind, err && err.name);
      }
      return false;
    }
  }

  function tuneAllSenders() {
    for (const p of S.peers.values()) {
      if (p.audioSender) tuneSender(p.audioSender, 'audio');
      if (p.videoSender) tuneSender(p.videoSender, 'video');
      if (p.screenSender) tuneSender(p.screenSender, 'screen');
    }
    updateQualityBadge();
  }

  /** Tampilkan kualitas yang sedang dipakai (biar tidak ada teka-teki). */
  function updateQualityBadge() {
    const elq = document.getElementById('quality-badge');
    if (!elq) return;
    const n = Math.max(1, S.peers.size);
    const tier = currentTier();
    const label = S.screenStream ? `layar ${tier.screen}k` : `kamera ${tier.cam}k`;
    elq.textContent = `${n} orang · ${label}`;
    elq.title = n >= 12
      ? 'Peserta banyak: kualitas diturunkan otomatis supaya semua tetap lancar (batas upload).'
      : 'Kualitas menyesuaikan jumlah peserta.';
  }

  function applyContentHint() {
    if (S.videoTrack) { try { S.videoTrack.contentHint = 'motion'; } catch (_) {} }
    if (S.screenStream) {
      const t = S.screenStream.getVideoTracks()[0];
      if (t) { try { t.contentHint = 'detail'; } catch (_) {} } // teks layar tetap tajam
    }
  }

  function addRemoteTrack(peer, track, which = 'cam') {
    if (!track) return;
    const target = which === 'screen' ? peer.screenStream : peer.remoteStream;
    const existing = target.getTracks().find((t) => t.kind === track.kind);
    if (existing === track) return;
    if (existing) target.removeTrack(existing);
    target.addTrack(track);

    if (which === 'screen') {
      // layar: tampilkan tile khusus saat track hidup, sembunyikan saat berhenti.
      // CATATAN: event mute/unmute bisa kelewat (mis. track sudah unmute sebelum
      // handler dipasang), jadi reconcileScreenTiles() juga dipanggil periodik.
      const sync = () => { reconcileScreenTiles(); };
      track.onunmute = sync;
      track.onmute = sync;
      track.onended = sync;
      sync();
      return;
    }

    if (track.kind === 'video') {
      track.onunmute = () => updateTileState(peer.id, { camOff: false });
      track.onmute = () => updateTileState(peer.id, { camOff: true });
    }
  }

  // Receiver selalu ada untuk setiap m-line; ontrack kadang telat / tanpa MSID,
  // jadi kita rekonsiliasi langsung dari getReceivers().
  // Urutan video: pertama = kamera, kedua = layar.
  function syncRemoteStream(peer) {
    try {
      let videoIndex = 0;
      for (const r of peer.pc.getReceivers()) {
        if (!r.track) continue;
        if (r.track.kind === 'audio') {
          addRemoteTrack(peer, r.track, 'cam');
        } else if (r.track.kind === 'video') {
          addRemoteTrack(peer, r.track, videoIndex === 0 ? 'cam' : 'screen');
          videoIndex++;
        }
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

  /* ---------- tile khusus share layar ---------- */

  function screenTileId(id) { return 'tile-screen-' + id; }

  function getScreenTile(id) { return document.getElementById(screenTileId(id)); }

  function ensureScreenTile(id, name) {
    let tile = getScreenTile(id);
    if (tile) return tile;

    tile = document.createElement('div');
    tile.className = 'tile screen-tile';
    tile.id = screenTileId(id);

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true; // audio tetap dari tile kamera (hindari dobel suara)

    const tag = document.createElement('div');
    tag.className = 'tag';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (name || 'Peserta') + ' — layar';
    tag.appendChild(nm);

    const badge = document.createElement('div');
    badge.className = 'badge-screen';
    badge.textContent = 'LAYAR';

    tile.append(vid, tag, badge);
    el.grid.appendChild(tile);
    return tile;
  }

  function setScreenTileVideo(id, stream) {
    const tile = getScreenTile(id);
    if (!tile) return;
    const vid = tile.querySelector('video');
    if (vid && vid.srcObject !== stream) {
      vid.srcObject = stream;
      const pl = vid.play();
      if (pl && pl.catch) pl.catch(() => {});
    }
  }

  function removeScreenTile(id) {
    const tile = getScreenTile(id);
    if (tile) tile.remove();
  }

  function showLocalScreenTile() {
    if (!S.screenStream) return;
    const tile = ensureScreenTile('self', S.name);
    setScreenTileVideo('self', S.screenStream);
    const vid = tile.querySelector('video');
    if (vid) vid.muted = true; // jangan dengar diri sendiri
  }

  function hideLocalScreenTile() {
    removeScreenTile('self');
  }

  /**
   * Sinkronkan tile layar dengan kenyataan (tidak bergantung event mute/unmute).
   * Dipanggil periodik + setiap kali ada perubahan track.
   */
  function reconcileScreenTiles() {
    for (const p of S.peers.values()) {
      // p.screen datang dari server (peer-state) -> sumber kebenaran, instan saat berhenti.
      // Kalau server bilang tidak share, tile langsung dibuang (hindari gambar beku).
      if (!p.screen) {
        removeScreenTile(p.id);
        continue;
      }
      const track = p.screenStream.getVideoTracks()[0];
      if (track && track.readyState === 'live') {
        ensureScreenTile(p.id, p.name);
        setScreenTileVideo(p.id, p.screenStream);
      }
    }
    // tile layar milik sendiri
    if (S.screenStream) {
      showLocalScreenTile();
    } else {
      removeScreenTile('self');
    }
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

    let hostBadge = tile.querySelector('.badge-host');
    if (isHost && !hostBadge) {
      hostBadge = document.createElement('div');
      hostBadge.className = 'badge-host';
      hostBadge.textContent = 'HOST';
      tile.appendChild(hostBadge);
    } else if (!isHost && hostBadge) {
      hostBadge.remove();
    }
  }

  function syncGridCount() {
    const total = 1 + S.peers.size;
    el.grid.dataset.count = String(total);
    el.gridEmpty.classList.toggle('hidden', S.peers.size > 0);
    el.people.textContent = `${total} peserta`;
    updateQualityBadge();
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC peers                                                       */
  /* ------------------------------------------------------------------ */

  // Untuk sisi yang menjawab: pakai transceiver hasil offer, pasang track kita di sana.
  // Urutan m-line: 0 = audio, 1 = kamera, 2 = layar (dibuat di createPeer).
  function adoptTransceivers(peer) {
    try {
      let videoIndex = 0;
      for (const tx of peer.pc.getTransceivers()) {
        const kind = tx.receiver && tx.receiver.track ? tx.receiver.track.kind : null;
        if (!kind) continue;
        tx.direction = 'sendrecv';
        if (kind === 'audio') {
          peer.audioTx = tx;
          peer.audioSender = tx.sender;
          try { tx.sender.replaceTrack(S.micOn ? S.audioTrack : null); } catch (_) {}
        } else if (kind === 'video') {
          if (videoIndex === 0) {
            peer.videoTx = tx;
            peer.videoSender = tx.sender;
            try { tx.sender.replaceTrack(camTrack()); } catch (_) {}
          } else {
            peer.screenTx = tx;
            peer.screenSender = tx.sender;
            try { tx.sender.replaceTrack(screenTrack()); } catch (_) {}
          }
          videoIndex++;
        }
      }
    } catch (_) {}
  }

  function camTrack() {
    return S.camOn && S.videoTrack ? S.videoTrack : null;
  }

  function screenTrack() {
    if (!S.screenStream) return null;
    return S.screenStream.getVideoTracks()[0] || null;
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
      screenStream: new MediaStream(),
      pending: [],
      audioSender: null,
      videoSender: null,
      screenSender: null,
    };

    // Kalau kita yang mulai (initiator): bikin transceiver sendiri + track + MSID.
    // Kalau kita yang menjawab: transceiver diadopsi dari offer (lihat adoptTransceivers),
    // karena transceiver lokal yang dibuat sebelum setRemoteDescription TIDAK terpasang
    // ke m-line offer -> jawaban jadi recvonly (media kita tidak terkirim).
    //
    // PENTING: jalur video DIPISAH — kamera dan layar punya transceiver sendiri.
    // Dengan begitu banyak orang bisa share layar bersamaan tanpa saling menimpa kamera.
    if (initiator) {
      const ls = S.localStream || new MediaStream();
      peer.audioTx = S.audioTrack
        ? pc.addTransceiver(S.audioTrack, { direction: 'sendrecv', streams: [ls] })
        : pc.addTransceiver('audio', { direction: 'sendrecv' });
      peer.videoTx = S.videoTrack
        ? pc.addTransceiver(S.videoTrack, { direction: 'sendrecv', streams: [ls] })
        : pc.addTransceiver('video', { direction: 'sendrecv' });
      // jalur khusus share layar (kosong kalau tidak share)
      peer.screenTx = pc.addTransceiver('video', { direction: 'sendrecv' });
      peer.audioSender = peer.audioTx.sender;
      peer.videoSender = peer.videoTx.sender;
      peer.screenSender = peer.screenTx.sender;

      try {
        peer.audioSender.replaceTrack(S.micOn ? S.audioTrack : null);
        peer.videoSender.replaceTrack(camTrack());
        peer.screenSender.replaceTrack(screenTrack());
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
        // setelah negosiasi selesai baru setParameters bisa diterima
        tuneSender(peer.audioSender, 'audio');
        tuneSender(peer.videoSender, 'video');
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
    removeScreenTile(id);
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
  let tuneTick = 0;

  function startLevelMonitor() {
    if (levelTimer) return;
    levelTimer = setInterval(async () => {
      reconcileScreenTiles();

      // Tuning bitrate bisa gagal kalau dipanggil sebelum negosiasi selesai
      // (event-nya tidak selalu datang di waktu yang tepat). Loop ini memastikan
      // nilai akhirnya tetap benar dalam ~2 detik, berapa pun urutan event-nya.
      tuneTick++;
      if (tuneTick % 3 === 0) tuneAllSenders();

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
      tuneAllSenders(); // peserta baru -> bitrate semua orang diturunkan
    });

    socket.on('peer-left', ({ id }) => {
      destroyPeer(id);
      renderPeople();
      tuneAllSenders(); // peserta berkurang -> kualitas bisa dinaikkan lagi
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
      tuneAllSenders();
      syncGridCount();
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
    // kamera punya jalur sendiri -> selalu push, tidak peduli sedang share layar
    for (const p of S.peers.values()) {
      if (!p.videoSender) continue;
      try { p.videoSender.replaceTrack(camTrack()); } catch (_) {}
    }
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
      { video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false, selfBrowserSurface: 'include', surfaceSwitching: 'include', systemAudio: 'exclude' },
      { video: { frameRate: { ideal: 30, max: 30 } }, audio: false },
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

      // kirim lewat jalur layar (kamera tetap jalan di jalur sendiri)
      pushScreenToPeers();
      applyContentHint();
      tuneAllSenders();

      // tile layar sendiri (kamera tetap di tile utama)
      showLocalScreenTile();
      updateTileState(S.selfId, { name: S.name + ' (kamu)', muted: !S.micOn, camOff: !S.camOn, screen: true, isHost: S.isHost });
      syncControls();
      broadcastState();

      // kalau ada peer yang belum punya jalur layar, tambahkan lalu negosiasi ulang
      for (const p of S.peers.values()) {
        if (!p.screenSender) await repairScreenSender(p, track);
      }

      toast('Sedang share layar');
    } catch (err) {
      console.warn('[univmeet] gagal mulai share layar:', err);
      stopScreen();
      screenFailModal(diag, err);
    }
  }

  // Kalau peer belum punya jalur layar (mis. peer lama), tambahkan lalu negosiasi ulang.
  async function repairScreenSender(peer, track) {
    try {
      const tx = peer.pc.addTransceiver(track || 'video', { direction: 'sendrecv' });
      peer.screenTx = tx;
      peer.screenSender = tx.sender;
      if (track) { try { await tx.sender.replaceTrack(track); } catch (_) {} }

      if (peer.initiator) {
        const offer = await peer.pc.createOffer();
        offer.sdp = tuneAudioSdp(offer.sdp);
        await peer.pc.setLocalDescription(offer);
        sendSignal(peer.id, { type: 'offer', sdp: peer.pc.localDescription });
      }
    } catch (err) {
      console.warn('[univmeet] repairScreenSender gagal:', err);
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

    // kosongkan jalur layar saja — kamera tidak disentuh
    pushScreenToPeers();
    hideLocalScreenTile();

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
    window.__tuneAll = tuneAllSenders; // dipakai tes otomatis
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
