# UnivMeet

Rapat online lewat browser. Video dan suara mengalir langsung antar peserta lewat WebRTC peer-to-peer, jadi server cuma mengatur siapa bertemu siapa. Tidak perlu install, tidak perlu daftar akun.

Alamatnya https://univmeet.pages.dev. Gratis dan tanpa kartu kredit. PC kamu tidak harus menyala karena servernya jalan di Cloudflare.

## Yang bisa dipakai

Video dan suara dua arah, share layar, chat, kunci rapat, keluarkan peserta, dan promosi host otomatis kalau host keluar. Kalau kamera ditolak, orang tetap bisa masuk dan ikut chat.

Kualitas kamera 720p30 dengan bitrate sampai 2,5 Mbps. Default WebRTC cuma sekitar 300 kbps, jadi ini memang dinaikkan.

Share layar punya jalur video sendiri, terpisah dari kamera. Artinya beberapa peserta bisa share bersamaan dan kamera masing-masing tetap kelihatan. Resolusinya sampai 1080p30, bitrate sampai 4 Mbps.

Suara pakai Opus 64 kbps dengan FEC, jadi tidak gampang putus saat jaringan goyang. Ada slider volume dan indikator bicara: tile menyala hijau kalau orangnya sedang ngomong.

## Kapasitas dan kenapa kualitasnya turun

Satu rapat menampung 20 orang. Bisa diubah antara 2 sampai 30 lewat env `MAX_PEERS`.

Arsitektur mesh berarti tiap orang mengirim video ke semua orang lain. Upload satu peserta terbagi ke jumlah peserta dikurangi satu, jadi bitrate per stream harus turun saat ruangan makin ramai. Kalau tidak diturunkan, uplink habis dan semua orang dapat gambar rusak.

| Peserta | Bitrate kamera per stream | Upload yang harus disanggupi |
|---|---|---|
| 2–3 | 2500 kbps (720p) | sekitar 2,5 Mbps |
| 4–5 | 1400 kbps (720p) | sekitar 5,6 Mbps |
| 6–7 | 900 kbps (720p) | sekitar 5,4 Mbps |
| 8–9 | 600 kbps (540p) | sekitar 4,2 Mbps |
| 10–13 | 380 kbps (480p) | sekitar 4,2 Mbps |
| 14–17 | 260 kbps (480p) | sekitar 4 Mbps |
| 18–21 | 190 kbps (360p) | sekitar 3,6 Mbps |
| 22–30 | 140 kbps (360p) | sekitar 4 Mbps |

Kolom upload itu total yang harus disanggupi satu peserta. Kalau upload internetmu lebih kecil, browser menurunkan kualitas lebih jauh lagi. Itu batas jaringan, bukan kerusakan aplikasi. Untuk 30 orang dengan gambar tetap bagus, perlu SFU seperti mediasoup atau LiveKit, dan itu proyek terpisah.

Di kanan atas ruang rapat ada badge kecil yang menunjukkan jumlah peserta dan bitrate yang sedang dipakai, misalnya `20 orang · kamera 190k`.

## Share layar cuma jalan dari laptop atau PC

Browser di HP tidak punya API share layar. Ini bukan pembatasan dari kita; Chrome Android dan Safari iOS memang tidak menyediakannya. Aplikasi akan bilang terus terang kalau tombolnya diklik dari HP.

Kalau UnivMeet dibuka di dalam iframe, misalnya panel preview atau embed, share layar juga diblokir browser lewat Permissions Policy. Buka di tab browser sendiri dan tombolnya berfungsi normal.

## Cara pakai

Isi nama, klik Buat rapat baru. Klik kode rapat di bagian atas untuk copy link, lalu kirim ke peserta. Mereka buka link itu, isi nama, langsung masuk. Kalau rapat mau ditutup, klik Kunci.

## Struktur folder

```
univmeet/
├── server.js                 server Node untuk jalan lokal (Express + ws)
├── lib/protocol.js           logika protokol, dipakai Node maupun Cloudflare
├── src/worker.js             Cloudflare Worker dan Durable Object RoomDO
├── functions/                Cloudflare Pages Functions
│   ├── ws.js                 /ws, WebSocket signaling
│   ├── config.js             /config, daftar STUN/TURN
│   └── healthz.js            /healthz
├── public/                   yang dikirim ke browser
│   ├── index.html
│   ├── styles.css
│   ├── app.js                logika WebRTC mesh
│   ├── net.js                klien WebSocket
│   ├── _redirects            /r/* ke /
│   └── _headers              no-cache untuk HTML dan JS
├── test/                     tes otomatis, butuh Chrome
│   ├── e2e-webrtc.js
│   ├── e2e-screen.js
│   ├── e2e-multishare.js
│   ├── audio-check.js
│   ├── capacity-check.js
│   ├── quality-scale.js
│   ├── screenshot.js
│   └── debug/                alat diagnosa
├── scripts/
│   └── NYALAIN-UNIVMEET.bat  launcher lokal
├── docs/
│   ├── URL-DAN-DEPLOY.md
│   ├── screenshots/
│   └── archive/
├── wrangler.jsonc            konfigurasi Cloudflare Pages
└── wrangler.worker.jsonc     konfigurasi Cloudflare Worker
```

Endpoint yang tersedia: `/` untuk landing, `/r/:kode` untuk ruang rapat, `/ws?room=<kode>` untuk signaling, `/config` untuk daftar STUN/TURN dan batas peserta, `/healthz` untuk status.

## Jalan di komputer sendiri

```bash
cd "C:\Users\DIZZO KINTIL\hermes project\web\univmeet"
npm install
npm start
```

Buka http://localhost:3000. Atau dobel-klik `scripts\NYALAIN-UNIVMEET.bat`.

Kamera dan mikrofon hanya jalan di localhost atau HTTPS. Kalau dibuka lewat IP LAN seperti http://192.168.x.x:3000, browser akan memblokirnya.

## Tes otomatis

```bash
npm start                          # terminal 1

node test/e2e-webrtc.js
node test/e2e-screen.js
node test/e2e-multishare.js
node test/audio-check.js
node test/capacity-check.js
node test/quality-scale.js

# terhadap versi online
BASE_URL="https://univmeet.pages.dev" node test/e2e-multishare.js
BASE_URL="https://univmeet.pages.dev" node test/capacity-check.js
EXPECT=30 BASE_URL="https://univmeet.pages.dev" node test/capacity-check.js
```

Butuh Chrome di `C:/Program Files/Google/Chrome/Application/chrome.exe`; bisa diarahkan lewat env `CHROME_PATH`. Tes memakai kamera palsu, jadi tidak muncul dialog izin.

Yang diperiksa bukan sekadar status connected. Tes membaca `videoWidth` dan `framesDecoded` untuk memastikan gambar benar-benar sampai, memeriksa bytes audio yang bertambah, memastikan tile layar muncul dengan frame, dan mengecek `maxBitrate` yang benar-benar terpasang di sender.

## Deploy dan update

Detailnya di [docs/URL-DAN-DEPLOY.md](docs/URL-DAN-DEPLOY.md). Ringkasnya dua perintah:

```bash
npx wrangler deploy --config wrangler.worker.jsonc
npx wrangler pages deploy --project-name univmeet --branch main --commit-dirty=true
```

Urutannya worker dulu, baru Pages, karena Pages memakai Durable Object dari worker.

## TURN server

Default memakai TURN publik openrelay.metered.ca. Cukup untuk mencoba, tapi bisa lambat dan ada batasnya. Untuk pemakaian serius, pakai kredensial sendiri dari Metered, Twilio, atau coturn:

```bash
TURN_URL="turn:turn.domainmu.com:3478,turns:turn.domainmu.com:5349" \
TURN_USER="user" TURN_PASS="pass" npm start
```

Tanpa TURN, sebagian peserta di balik NAT simetris atau jaringan kampus yang ketat bisa gagal terhubung.

## Yang belum ada

Belum ada rekaman rapat dan belum ada login atau akun. State rapat disimpan di Durable Object, bukan database, jadi tidak ada riwayat setelah ruangan kosong.

Kapasitas di atas 20 orang bisa dipaksa, tapi mesh akan terasa berat. Itu batas arsitekturnya, bukan angka yang bisa dinaikkan seenaknya.
