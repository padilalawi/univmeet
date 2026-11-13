# URL dan cara deploy

## Alamat resmi

```
https://univmeet.pages.dev
```

Link rapat bentuknya `https://univmeet.pages.dev/r/<kode-rapat>`.

Tidak ada biaya dan tidak perlu kartu kredit. PC tidak harus menyala karena servernya jalan di Cloudflare. Halaman peringatan tidak ada. HTTPS otomatis, dan itu wajib supaya kamera serta mikrofon bisa dipakai.

Repo: https://github.com/padilalawi/univmeet

## Arsitektur

```
Browser  <--WSS-->  Cloudflare Pages (univmeet.pages.dev)
                         |
                         +--> Durable Object RoomDO, satu per kode rapat
                              daftar peserta, relay sinyal WebRTC,
                              chat, lock, kick
```

Video dan audio tidak lewat server. Keduanya mengalir langsung antar browser. Server hanya mengatur siapa bertemu siapa.

Tidak memakai workers.dev karena domain itu diblokir ISP Indonesia. Gejalanya DNS NXDOMAIN di Chrome dan TLS reset di curl. pages.dev lolos, dan formatnya juga lebih bersih karena tidak ada nama akun di tengah.

## Cara update

```bash
cd "C:\Users\DIZZO KINTIL\hermes project\web\univmeet"

# kalau src/worker.js atau lib/protocol.js berubah
npx wrangler deploy --config wrangler.worker.jsonc

# kalau public/ atau functions/ berubah
npx wrangler pages deploy --project-name univmeet --branch main --commit-dirty=true
```

Kalau ragu mana yang berubah, jalankan dua-duanya dengan urutan seperti di atas.

Saat mengubah file di `public/`, naikkan nomor versi di `index.html` (`app.js?v=6` jadi `?v=7`) supaya browser pengguna tidak memakai cache lama.

## File konfigurasi

| File | Isinya |
|---|---|
| `wrangler.jsonc` | Konfigurasi Pages: production branch `main`, binding Durable Object, `MAX_PEERS` |
| `wrangler.worker.jsonc` | Konfigurasi Worker: entry point, assets, migrasi DO, `MAX_PEERS` |
| `functions/ws.js` | WebSocket signaling, diteruskan ke Durable Object |
| `functions/config.js` | Daftar STUN/TURN untuk browser |
| `functions/healthz.js` | Cek status |
| `lib/protocol.js` | Logika protokol, dipakai bersama Node dan Cloudflare |
| `public/_redirects` | `/r/*` diarahkan ke `/` |
| `public/_headers` | no-cache untuk HTML dan JS |

## Jalan lokal

```bash
npm install
npm start
```

Buka http://localhost:3000. Atau dobel-klik `scripts\NYALAIN-UNIVMEET.bat` kalau mau sekalian bikin tunnel.

Kamera dan mikrofon hanya jalan di localhost atau HTTPS. Lewat IP LAN seperti http://192.168.x.x:3000, browser memblokirnya.

## Ubah kapasitas ruang

Default 20 orang, boleh 2 sampai 30. Ubah di dua file:

- `wrangler.jsonc`, baris `"MAX_PEERS": "20"`
- `wrangler.worker.jsonc`, baris `"MAX_PEERS": "20"`

Deploy ulang worker dulu, lalu Pages. Verifikasinya:

```bash
curl -s https://univmeet.pages.dev/config | grep -o '"maxPeers":[0-9]*'
EXPECT=30 node test/capacity-check.js
```

Di atas 20 orang mesh makin berat karena tiap peserta upload ke semua peserta lain. Kualitas diturunkan otomatis, tapi batas nyatanya tetap upload internet masing-masing peserta.

## Domain sendiri

Beli domainnya dulu, misalnya univmeet.online. Lalu buka Cloudflare Pages, pilih project univmeet, masuk ke Custom domains, dan tambahkan domain tersebut. Ikuti record DNS yang diberikan. Kode tidak perlu diubah.

## Keamanan

Token ngrok pernah ditempel di chat, jadi anggap bocor dan tidak dipakai lagi. Kalau masih mau pakai ngrok, revoke dulu di dashboard.ngrok.com/get-started/your-authtoken.

Kredensial Cloudflare hasil login OAuth tersimpan lokal di `%APPDATA%\xdg.config\.wrangler\config\default.toml`. Jangan dibagikan ke siapa pun.
