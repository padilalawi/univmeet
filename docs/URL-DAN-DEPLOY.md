# URL & Deploy — UnivMeet

## URL resmi (permanen)

```
https://univmeet.pages.dev
```

Link rapat: `https://univmeet.pages.dev/r/<kode-rapat>`

| | |
|---|---|
| Biaya | Rp 0 (gratis, tanpa kartu kredit) |
| PC harus nyala? | **Tidak** — server jalan di Cloudflare |
| Halaman peringatan | Tidak ada |
| HTTPS | Otomatis (wajib untuk kamera/mikrofon) |
| Repo | https://github.com/padilalawi/univmeet |

---

## Arsitektur

```
Browser  <--WSS-->  Cloudflare Pages (univmeet.pages.dev)
                         |
                         +--> Durable Object "RoomDO" (satu per kode rapat)
                              - daftar peserta
                              - relay sinyal WebRTC (offer/answer/ICE)
                              - chat, lock, kick

Video & audio TIDAK lewat server  ->  P2P langsung antar browser.
Server hanya mengatur "siapa bertemu siapa" (signaling).
```

Kenapa tidak pakai `workers.dev`: **diblokir ISP Indonesia** (DNS NXDOMAIN + TLS reset).
`pages.dev` lolos dan formatnya lebih bersih (tanpa nama akun di tengah).

---

## Cara update kalau kode diubah

```bash
cd "C:\Users\DIZZO KINTIL\hermes project\web\univmeet"

# 1) kalau worker / Durable Object berubah (src/worker.js, lib/protocol.js)
npx wrangler deploy --config wrangler.worker.jsonc

# 2) kalau tampilan / logika browser berubah (public/, functions/)
npx wrangler pages deploy --project-name univmeet --branch main --commit-dirty=true
```

> Kalau ragu mana yang berubah: jalankan **dua-duanya**, urutannya worker dulu.

Kalau JS/CSS berubah, naikkan versi di `public/index.html`
(`app.js?v=N` → `?v=N+1`) supaya browser pengguna tidak pakai cache lama.

---

## File konfigurasi

| File | Untuk apa |
|---|---|
| `wrangler.jsonc` | Konfigurasi **Pages** (production branch `main`, binding Durable Object, `MAX_PEERS`) |
| `wrangler.worker.jsonc` | Konfigurasi **Worker** (`main`, assets, migrasi DO, `MAX_PEERS`) |
| `functions/ws.js` | WebSocket signaling → diteruskan ke Durable Object |
| `functions/config.js` | daftar STUN/TURN untuk browser |
| `functions/healthz.js` | cek status |
| `lib/protocol.js` | logika protokol — dipakai bersama Node & Cloudflare |
| `public/_redirects` | `/r/*` → `/` (biar link rapat bisa dibuka) |
| `public/_headers` | no-cache untuk HTML/JS (update langsung kepakai) |

---

## Jalan lokal (buat ngoprek)

```bash
npm install
npm start          # -> http://localhost:3000
```

Atau dobel-klik `scripts\NYALAIN-UNIVMEET.bat` (server + tunnel opsional).

> Kamera/mikrofon hanya jalan di `localhost` atau HTTPS. Lewat IP LAN
> (`http://192.168.x.x:3000`) browser akan blokir.

---

## Domain sendiri (kalau nanti mau)

1. Beli domain (mis. `univmeet.online`)
2. Cloudflare Pages → project `univmeet` → **Custom domains** → tambah domain
3. Ikuti record DNS yang diberikan

Tidak perlu ubah kode.

---

## Ubah kapasitas ruang (MAX_PEERS)

Default **20 orang**, boleh 2–30. Ubah di **dua** file:

- `wrangler.jsonc` → `"MAX_PEERS": "20"`
- `wrangler.worker.jsonc` → `"MAX_PEERS": "20"`

Lalu deploy ulang (worker dulu, baru pages). Verifikasi:

```bash
curl -s https://univmeet.pages.dev/config | grep -o '"maxPeers":[0-9]*'
EXPECT=30 node test/capacity-check.js
```

> Di atas 20 orang, mesh makin berat: tiap orang upload ke semua orang lain.
> Kualitas diturunkan otomatis (lihat tabel di README), tapi batas nyata tetap
> **upload internet tiap peserta**.

---

## Keamanan

- Token ngrok pernah ditempel di chat → **sudah tidak dipakai**.
  Kalau masih ingin pakai ngrok, revoke dulu:
  `dashboard.ngrok.com/get-started/your-authtoken`
- Kredensial Cloudflare (OAuth) tersimpan lokal di
  `%APPDATA%\xdg.config\.wrangler\config\default.toml` — jangan dibagikan.
