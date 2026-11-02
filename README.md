# UnivMeet 🎥

Rapat & kuliah online gratis — video langsung antar browser (WebRTC P2P), tanpa install, tanpa akun.

Domain target: **univmeet.online**

---

## Fitur

| Fitur | Keterangan |
|---|---|
| Video + suara | P2P antar peserta (server cuma atur sinyal, video tidak lewat server) |
| Share layar | `getDisplayMedia`, tanpa renegosiasi (replaceTrack) |
| Chat rapat | Real-time, ada badge pesan belum dibaca |
| Kunci rapat | Host bisa tolak peserta baru |
| Keluarkan peserta | Host bisa kick |
| Auto-promote host | Kalau host keluar, peserta pertama otomatis jadi host |
| Link undangan | `univmeet.online/r/kode-rapat` — 1 klik langsung masuk (nama tersimpan) |
| Tanpa media | Kalau kamera/mic ditolak, tetap bisa masuk & chat |

Kapasitas default **8 orang per rapat** (mesh P2P — makin banyak makin berat di CPU/upload). Ubah lewat env `MAX_PEERS`.

---

## Jalankan di komputer sendiri

```bash
cd "C:\Users\DIZZO KINTIL\hermes project\web\univmeet"
npm install
npm start
```

Buka **http://localhost:3000**

> Catatan: kamera/mikrofon hanya jalan di `localhost` atau HTTPS. Kalau dibuka lewat IP LAN (`http://192.168.x.x:3000`), browser akan blokir kamera.

---

## Cara pakai

1. Isi nama → klik **Buat rapat baru**
2. Klik kode rapat di atas (atau tombol **Copy link rapat**) → kirim ke peserta
3. Peserta buka link → isi nama → langsung masuk
4. Kalau mau rapat tertutup: klik **Kunci**

---

## Struktur

```
univmeet/
├── server.js              # Express + Socket.IO (signaling + static)
├── public/
│   ├── index.html         # landing + ruang rapat
│   ├── styles.css         # tema dark
│   └── app.js             # logika WebRTC mesh
├── test/
│   ├── e2e-webrtc.js      # tes otomatis 3 tab (video/audio/chat/lock/host)
│   ├── debug-media.js     # dump sender/ICE/stats kalau ada masalah media
│   └── screenshot.js      # ambil screenshot UI
└── screenshots/           # hasil screenshot
```

Endpoint server:

| Path | Fungsi |
|---|---|
| `/` | landing |
| `/r/:kode` | ruang rapat |
| `/config` | daftar STUN/TURN + max peserta |
| `/healthz` | status server (rooms, people, uptime) |

---

## Test otomatis

```bash
npm start          # terminal 1
node test/e2e-webrtc.js   # terminal 2
```

Yang diverifikasi: 2 peer `connected`, audio+video dua arah benar-benar mengalir (videoWidth > 0),
chat terkirim, status mute tersinkron, kunci rapat menolak orang baru, host keluar → peserta naik jadi host.

Butuh Chrome di `C:/Program Files/Google/Chrome/Application/chrome.exe` (bisa diubah via env `CHROME_PATH`).
Tes pakai kamera palsu (`--use-fake-device-for-media-stream`) jadi tidak minta izin kamera.

---

## Deploy ke internet (gratis) — Render

1. **Push ke GitHub**
   ```bash
   git init && git add . && git commit -m "univmeet v1"
   gh repo create univmeet --public --source=. --push
   ```
2. Buka [render.com](https://render.com) → **New +** → **Web Service** → pilih repo `univmeet`
3. Isi:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance type**: Free
4. Deploy → dapat URL `https://univmeet-xxxx.onrender.com` (HTTPS otomatis, WebSocket jalan)

> Free plan Render tidur setelah ~15 menit tanpa trafik; request pertama bangun ~30 detik.
> Kalau mau selalu panas, pakai Railway/Fly.io atau VPS kecil.

### Alternatif VPS (nginx + HTTPS)

```bash
# di server
git clone <repo> && cd univmeet && npm install --omit=dev
PORT=3000 node server.js        # jalankan pakai pm2/systemd
```
```nginx
server {
  server_name univmeet.online;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # wajib untuk WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```
```bash
certbot --nginx -d univmeet.online -d www.univmeet.online   # HTTPS gratis
```

---

## Pasang domain univmeet.online

1. Beli domain di registrar (Cloudflare / Namecheap / Niagahoster). Sekarang domain ini
   **belum terdaftar** — masih bisa dibeli.
2. Di dashboard hosting (Render: **Settings → Custom Domain**), tambahkan:
   - `univmeet.online`
   - `www.univmeet.online`
3. Di DNS registrar, buat record sesuai instruksi hosting. Umumnya:

| Type | Name | Value |
|---|---|---|
| CNAME | `www` | `univmeet-xxxx.onrender.com` |
| ALIAS / ANAME / CNAME | `@` (root) | `univmeet-xxxx.onrender.com` |

> Registrar yang tidak mendukung ALIAS di root: pakai Cloudflare (proxy) atau arahkan
> `@` ke IP hosting lewat record `A`.

4. Tunggu propagasi DNS (5 menit–24 jam). Cek:
   ```bash
   nslookup univmeet.online 8.8.8.8
   ```

---

## TURN server (penting untuk peserta di jaringan ketat)

Default memakai TURN publik `openrelay.metered.ca` — cukup untuk coba-coba, tapi bisa lambat/limit.
Untuk produksi, pakai kredensial TURN sendiri (mis. Metered / Twilio / coturn):

```bash
TURN_URL="turn:turn.univmeet.online:3478,turns:turn.univmeet.online:5349" \
TURN_USER="user" TURN_PASS="pass" npm start
```

Server otomatis mengirim kredensial itu ke browser lewat `/config`.

Tanpa TURN, sebagian peserta (di balik NAT simetris / jaringan kampus ketat) bisa gagal terhubung.

---

## Batasan yang perlu diketahui

- **Mesh P2P**: tiap peserta mengirim stream ke semua peserta lain. 8 orang = 7 koneksi per orang.
  Di atas 8–10 peserta, kualitas turun (butuh SFU seperti mediasoup/LiveKit kalau mau banyak).
- **Butuh HTTPS** untuk kamera/mikrofon (kecuali localhost).
- **Belum ada rekaman rapat** dan belum ada login/akun.
- State rapat disimpan di memori server → restart server = semua rapat bubar.

---

© UnivMeet — univmeet.online
