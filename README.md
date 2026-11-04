# UnivMeet 🎥

Rapat & kuliah online gratis — video langsung antar browser (WebRTC P2P), tanpa install, tanpa akun.

**Live: https://univmeet.pages.dev** · gratis · tanpa kartu kredit · PC boleh dimatikan

---

## Fitur

| Fitur | Keterangan |
|---|---|
| Video + suara | P2P antar peserta — video **tidak** lewat server |
| Kualitas kamera | 720p30, bitrate sampai 2.5 Mbps (default WebRTC cuma ~300 kbps) |
| Share layar | Jalur video **terpisah** — semua peserta bisa share bersamaan, kamera tetap terlihat. 1080p30, sampai 4 Mbps |
| Audio | Opus FEC 64 kbps + slider volume + indikator bicara (tile menyala hijau) |
| Chat rapat | Real-time, ada badge pesan belum dibaca |
| Kunci rapat | Host bisa tolak peserta baru |
| Keluarkan peserta | Host bisa kick |
| Auto-promote host | Host keluar → peserta pertama otomatis jadi host |
| Link undangan | `/r/kode-rapat` — 1 klik langsung masuk (nama tersimpan) |
| Tanpa media | Kalau kamera/mic ditolak, tetap bisa masuk & chat |

Kapasitas default **8 orang per rapat** (mesh P2P — makin banyak makin berat CPU/upload).
Ubah lewat env `MAX_PEERS`.

> **Share layar hanya bisa dari laptop/PC di tab browser.** Browser HP tidak punya API-nya,
> dan di dalam iframe (panel preview/embed) diblokir browser. Aplikasi akan menjelaskan
> hal ini kalau dicoba dari tempat yang tidak didukung.

---

## Cara pakai

1. Isi nama → klik **Buat rapat baru**
2. Klik kode rapat di atas (atau **Copy link rapat**) → kirim ke peserta
3. Peserta buka link → isi nama → langsung masuk
4. Mau rapat tertutup? Klik **Kunci**

---

## Struktur folder

```
univmeet/
├── server.js                 # server Node lokal (Express + ws)
├── lib/
│   └── protocol.js           # logika protokol — dipakai Node & Cloudflare
├── src/
│   └── worker.js             # Cloudflare Worker + Durable Object "RoomDO"
├── functions/                # Cloudflare Pages Functions
│   ├── ws.js                 #   /ws  → WebSocket signaling
│   ├── config.js             #   /config → STUN/TURN
│   └── healthz.js            #   /healthz
├── public/                   # yang dikirim ke browser
│   ├── index.html
│   ├── styles.css
│   ├── app.js                # logika WebRTC mesh
│   ├── net.js                # klien WebSocket (pengganti Socket.IO)
│   ├── _redirects            # /r/* → /
│   └── _headers              # no-cache untuk HTML/JS
├── test/                     # tes otomatis (butuh Chrome)
│   ├── e2e-webrtc.js         #   video/suara/chat/lock/host
│   ├── e2e-screen.js         #   share layar
│   ├── e2e-multishare.js     #   dua orang share bersamaan
│   ├── audio-check.js        #   Opus FEC, volume, indikator bicara
│   ├── screenshot.js         #   ambil screenshot UI
│   └── debug/                #   alat diagnosa (bukan bagian app)
├── scripts/
│   └── NYALAIN-UNIVMEET.bat  # launcher lokal + tunnel (opsional)
├── docs/
│   ├── URL-DAN-DEPLOY.md     # URL, arsitektur, cara deploy/update
│   ├── screenshots/
│   └── archive/              # catatan lama (render.yaml, dll)
├── wrangler.jsonc            # konfigurasi Cloudflare Pages
└── wrangler.worker.jsonc     # konfigurasi Cloudflare Worker
```

Endpoint:

| Path | Fungsi |
|---|---|
| `/` | landing |
| `/r/:kode` | ruang rapat |
| `/ws?room=<kode>` | WebSocket signaling |
| `/config` | daftar STUN/TURN + max peserta |
| `/healthz` | status server |

---

## Jalankan lokal

```bash
cd "C:\Users\DIZZO KINTIL\hermes project\web\univmeet"
npm install
npm start          # -> http://localhost:3000
```

Atau dobel-klik `scripts\NYALAIN-UNIVMEET.bat`.

> Kamera/mikrofon hanya jalan di `localhost` atau HTTPS. Lewat IP LAN
> (`http://192.168.x.x:3000`) browser akan blokir.

---

## Test otomatis

```bash
npm start                          # terminal 1

# tes terhadap server lokal
node test/e2e-webrtc.js
node test/e2e-screen.js
node test/e2e-multishare.js
node test/audio-check.js

# tes terhadap versi ONLINE
BASE_URL="https://univmeet.pages.dev" node test/e2e-multishare.js
```

Butuh Chrome di `C:/Program Files/Google/Chrome/Application/chrome.exe`
(bisa diubah via env `CHROME_PATH`). Tes memakai kamera palsu
(`--use-fake-device-for-media-stream`), jadi tidak minta izin kamera.

Yang dibuktikan (bukan cuma "connected"): `videoWidth > 0`, `framesDecoded` bertambah,
audio bytes bertambah, tile layar muncul dengan frame, bitrate terpasang, chat terkirim,
lock menolak orang baru, host keluar → peserta naik jadi host.

---

## Deploy & update

Lihat **[docs/URL-DAN-DEPLOY.md](docs/URL-DAN-DEPLOY.md)**.

Ringkasnya:

```bash
npx wrangler deploy --config wrangler.worker.jsonc                    # worker/DO
npx wrangler pages deploy --project-name univmeet --branch main --commit-dirty=true
```

---

## TURN server

Default memakai TURN publik `openrelay.metered.ca` — cukup untuk coba-coba.
Untuk produksi, pakai kredensial sendiri (Metered / Twilio / coturn):

```bash
TURN_URL="turn:turn.domainmu.com:3478,turns:turn.domainmu.com:5349" \
TURN_USER="user" TURN_PASS="pass" npm start
```

Tanpa TURN, sebagian peserta (NAT simetris / jaringan kampus ketat) bisa gagal terhubung.

---

## Batasan

- **Mesh P2P**: tiap peserta mengirim stream ke semua peserta lain. 8 orang = 7 koneksi/orang.
  Di atas 8–10 peserta kualitas turun (butuh SFU seperti mediasoup/LiveKit).
- **Butuh HTTPS** untuk kamera/mikrofon (kecuali localhost).
- Belum ada rekaman rapat dan belum ada login/akun.
- State rapat ada di memori Durable Object → tidak ada database.

---

© UnivMeet
