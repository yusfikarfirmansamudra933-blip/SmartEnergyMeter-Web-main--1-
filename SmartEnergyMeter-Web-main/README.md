# Smart Energy Meter

Firmware ESP32 untuk memantau pemakaian listrik lewat sensor PZEM-004T, dengan dashboard lokal, dashboard cloud, dan bot Telegram — semuanya terhubung lewat broker MQTT.

## Arsitektur

```
┌─────────────┐   UART    ┌──────────────┐   MQTT (TLS)   ┌────────────────┐
│ PZEM-004T   ├──────────►│   ESP32      ├───────────────►│  EMQX Cloud     │
│ (sensor AC) │           │  (firmware)  │                │  (broker MQTT)  │
└─────────────┘           └──────┬───────┘                └────────┬────────┘
                                  │ HTTP/WS (LAN saja)               │ MQTT over WebSocket
                                  ▼                                  ▼
                          Dashboard lokal                 ┌──────────────────────┐
                          (LittleFS, data/)                │ Vercel (web-remote/) │
                                                            │ • Dashboard cloud     │
                                                            │ • Halaman tagihan     │
                                                            │ • Bot Telegram        │
                                                            └──────────────────────┘
```

- **Firmware ESP32** membaca data dari PZEM-004T, menampilkannya di OLED, menyajikan dashboard lokal via HTTP/WebSocket, dan mem-publish telemetri ke broker MQTT (retained + status online/offline lewat Last Will).
- **Dashboard lokal** (`data/`) hanya bisa diakses dari jaringan WiFi yang sama dengan perangkat. Bisa untuk kontrol penuh (restart, factory reset).
- **Dashboard cloud** (`web-remote/`) di-deploy ke Vercel, bisa diakses dari mana saja lewat internet karena mengambil data langsung dari broker MQTT (bukan dari perangkat). Menggunakan kredensial MQTT read-only demi keamanan.
- **Bot Telegram** (juga di `web-remote/api/`) menjawab pertanyaan data (`/watt`, `/kwh`, dll), bisa mengubah batas daya (`/setlimit`), dan mengirim notifikasi otomatis saat perangkat offline atau daya melebihi batas.

## Menyiapkan firmware

1. Salin `include/config.example.h` menjadi `include/config.local.h`.
2. Isi kredensial WiFi dan MQTT milik Anda sendiri. File lokal ini diabaikan Git.
3. Isi sertifikat CA broker pada `MQTT_CA_CERT` (lihat catatan format di bawah). Jangan gunakan `MQTT_TLS_INSECURE` di perangkat produksi.
4. Build dan unggah firmware serta filesystem dengan PlatformIO:

   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```

`data/` adalah aset dashboard lokal yang dipasang ke LittleFS.

> **Catatan format `MQTT_CA_CERT`:** compiler ESP32 di proyek ini tidak mendukung raw string literal (`R"EOF(...)EOF"`) multi-baris di dalam macro `#define`. Sertifikat harus ditulis sebagai concatenated string literals dengan `\n` eksplisit dan backslash continuation di akhir tiap baris — lihat contoh di `config.example.h`.

## Menyiapkan broker MQTT (EMQX Cloud)

Firmware butuh broker MQTT dengan TLS. Proyek ini pakai [EMQX Cloud](https://www.emqx.com/en/cloud) (tier Serverless gratis). Buat 3 user Authentication dengan Authorization (ACL) berbeda hak akses:

| User | Dipakai oleh | Hak akses |
|---|---|---|
| (kredensial firmware, di `config.local.h`) | ESP32 | Full — publish semua topic, subscribe `cmd/*` |
| `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`) — kode ini publik/terlihat siapa saja | Subscribe `smartmeter/data`, `smartmeter/status` saja. **Publish harus di-deny** (topic `#`) |
| `smartenergymeterbot` | Bot Telegram (`web-remote/api/*.js`) — server-side, tidak publik | Subscribe `smartmeter/data`, `smartmeter/status`, `smartmeter/telegram/#`. Publish `smartmeter/cmd/limit` dan `smartmeter/telegram/#` |

**Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.

### Topic MQTT

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, dll), **retained** |
| `smartmeter/status` | broker → subscriber | `"online"` / `"offline"` — di-set via MQTT Last Will, jadi otomatis `"offline"` kalau ESP32 putus koneksi tanpa sempat pamit |
| `smartmeter/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/telegram/chatid` | bot → tersimpan di broker | Chat ID Telegram terdaftar, retained |
| `smartmeter/telegram/alert_state` | bot → tersimpan di broker | State notifikasi (sudah/belum alert offline/overload), retained |

## Menyiapkan dashboard cloud & bot Telegram (`web-remote/`)

1. `cd web-remote && npm install`
2. Deploy ke Vercel: `vercel deploy --prod`
3. Set environment variable di Vercel (`vercel env add`, jangan di-hardcode ke kode):
   - `MQTT_USERNAME`, `MQTT_PASSWORD` — kredensial `smartenergymeterweb` (dipakai script.js sisi client, jadi memang publik — makanya harus read-only)
   - `BOT_MQTT_USERNAME`, `BOT_MQTT_PASSWORD` — kredensial `smartenergymeterbot`
   - `TELEGRAM_BOT_TOKEN` — token dari [@BotFather](https://t.me/BotFather)
4. Daftarkan webhook bot: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/telegram"`
5. Daftarkan daftar command bot (untuk autocomplete `/` di Telegram) lewat `setMyCommands` — lihat daftar command di bawah.
6. Untuk notifikasi otomatis (offline/overload), panggil `GET /api/monitor` secara berkala. **Akun Vercel Hobby/gratis membatasi cron bawaan cuma 1x/hari**, jadi gunakan layanan cron gratis pihak ketiga seperti [cron-job.org](https://cron-job.org) untuk memanggil endpoint ini tiap beberapa menit.

### Command bot Telegram

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/limit` `/status` — cek data. `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/help` — bantuan.

## Catatan keamanan

- Kredensial WiFi/MQTT firmware **hanya** di `include/config.local.h`, tidak pernah di-commit (lihat `.gitignore`).
- Kredensial MQTT di dashboard cloud (`smartenergymeterweb`) **sengaja read-only** karena kodenya publik dan terlihat siapa saja lewat "View Source" — jangan pernah pakai kredensial full-access di sana.
- Kredensial bot (`smartenergymeterbot`, `TELEGRAM_BOT_TOKEN`) hanya hidup sebagai environment variable server-side di Vercel, tidak pernah masuk ke kode yang di-deploy ke browser.
- Dashboard lokal (`data/`) saat ini **belum** punya autentikasi HTTP aktif meski field `WEB_USERNAME`/`WEB_PASSWORD` sudah ada di config — siapa pun di jaringan WiFi yang sama bisa akses.

## Struktur

- `src/`, `include/` — firmware ESP32 (PlatformIO).
- `data/` — dashboard lokal, di-flash ke LittleFS (`pio run -t uploadfs`). Diakses lewat IP lokal ESP32.
- `web-remote/` — dashboard cloud + bot Telegram, di-deploy terpisah ke Vercel. Berisi:
  - `index.html`, `script.js`, `style.css`, `bill.html` — dashboard & halaman tagihan (MQTT over WebSocket).
  - `api/telegram.js` — webhook bot Telegram.
  - `api/monitor.js` — endpoint pengecekan berkala untuk notifikasi otomatis.
