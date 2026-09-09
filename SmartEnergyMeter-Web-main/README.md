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
- **Dashboard lokal** (`data/`) hanya bisa diakses dari jaringan WiFi yang sama dengan perangkat. Bisa untuk kontrol penuh (restart, factory reset, update firmware OTA).
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

## Update firmware OTA

Setelah upload awal lewat USB, update berikutnya bisa lewat dashboard lokal tanpa colok kabel:

1. Build firmware baru: `pio run` (hasilnya di `.pio/build/esp32dev/firmware.bin`).
2. Naikkan `FIRMWARE_VERSION` di `include/config.h` supaya dashboard bisa konfirmasi versi yang aktif setelah update.
3. Buka dashboard lokal (`http://<ip-esp32>/`), scroll ke panel **Perbarui firmware**, pilih `firmware.bin`, klik **Unggah & pasang**.
4. Perangkat menulis firmware ke partisi OTA yang sedang tidak aktif (`app0`/`app1`, sudah tersedia di partition table default `esp32dev`) lalu restart otomatis begitu selesai.
5. Selama proses berlangsung, layar OLED berhenti menampilkan halaman metrik biasa dan menampilkan progress bar + persentase upload, lalu status akhir ("Berhasil! Merestart..." atau "Update gagal, coba lagi ya"). Kalau gagal, OLED otomatis kembali ke halaman metrik normal setelah beberapa detik.

Kalau `WEB_USERNAME`/`WEB_PASSWORD` sudah diisi di `config.local.h`, endpoint `/update` akan minta HTTP Basic Auth (prompt bawaan browser) sebelum menerima file — satu-satunya endpoint dashboard lokal yang saat ini benar-benar menegakkan autentikasi di sisi server (lihat catatan keamanan di bawah). Kalau upload gagal di tengah jalan, firmware lama yang sedang berjalan tidak tersentuh — device tetap boot dari partisi lama.

### Auto-rollback kalau firmware baru rusak

Firmware baru punya satu kesempatan untuk membuktikan dirinya bisa konek WiFi sebelum dipercaya:

1. Begitu upload OTA sukses, sebelum restart, perangkat menyimpan tanda "perlu verifikasi" ke NVS (`Preferences`, tahan reboot).
2. Begitu boot pertama setelah OTA itu, kalau tanda itu ada, firmware baru dikasih waktu 20 detik untuk konek WiFi (OLED menampilkan "Verifying WiFi...").
3. Kalau berhasil konek dalam 20 detik → tanda dihapus, firmware baru dipercaya, lanjut boot normal (MQTT, web server, dst).
4. Kalau gagal (misal firmware baru ada bug yang bikin WiFi tidak pernah konek) → otomatis `Update.rollBack()` ke firmware sebelumnya di partisi OTA yang lain, lalu restart — **tanpa perlu USB atau intervensi manual sama sekali**. OLED menampilkan "Rollback! Restarting...".

Pengecekan ini cuma jalan sekali per OTA (bukan tiap boot), jadi tidak menambah waktu boot untuk restart/power-cycle biasa. Kalau tidak ada firmware valid di partisi satunya untuk di-rollback (misal baru sekali pernah di-flash), perangkat tetap lanjut boot dengan firmware yang ada — tidak ada tempat lain untuk kembali.

## Menyiapkan broker MQTT (EMQX Cloud)

Firmware butuh broker MQTT dengan TLS. Proyek ini pakai [EMQX Cloud](https://www.emqx.com/en/cloud) (tier Serverless gratis). Buat 3 user Authentication dengan Authorization (ACL) berbeda hak akses:

| User | Dipakai oleh | Hak akses |
|---|---|---|
| (kredensial firmware, di `config.local.h`) | ESP32 | Full — publish semua topic, subscribe `cmd/*` |
| `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`) — kode ini publik/terlihat siapa saja | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/billing/#`. **Publish harus di-deny** (topic `#`) |
| `smartenergymeterbot` | Bot Telegram + `api/monitor.js` (`web-remote/api/*.js`) — server-side, tidak publik | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#`, `smartmeter/telegram/chatid`. Publish `smartmeter/+/cmd/limit`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#`, `smartmeter/telegram/chatid` |

**Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.

### Topic MQTT

Sebagian besar topic sekarang dinamai `smartmeter/<deviceId>/...` (bukan flat `smartmeter/...` lagi) supaya beberapa device fisik tidak bentrok di broker yang sama. `<deviceId>` default-nya diambil dari 3 byte terakhir MAC address chip ESP32, atau bisa di-override lewat `DEVICE_ID` di `config.local.h` (dipakai supaya cocok dengan id yang didaftarkan di `web-remote/devices.html`, misal `meter-01`). Web-remote saat ini masih hardcode ke satu `DEVICE_ID` (`meter-01`) di tiap file — dukungan pilih-device dinamis dari Supabase menyusul.

Chat ID Telegram (`smartmeter/telegram/chatid`) sengaja **tidak** dinamai per-device — mau notifikasi ke chat mana itu urusan per-user, bukan per-device (baru benar-benar terikat ke akun setelah bagian Telegram di Fase 1 rencana multi-device selesai).

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/<deviceId>/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, deviceId, dll), **retained** |
| `smartmeter/<deviceId>/status` | broker → subscriber | `"online"` / `"offline"` — di-set via MQTT Last Will, jadi otomatis `"offline"` kalau ESP32 putus koneksi tanpa sempat pamit |
| `smartmeter/<deviceId>/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/<deviceId>/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/<deviceId>/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/telegram/chatid` | bot → tersimpan di broker | Chat ID Telegram terdaftar, retained — **global, bukan per-device** |
| `smartmeter/<deviceId>/telegram/alert_state` | bot → tersimpan di broker | State notifikasi (sudah/belum alert offline/overload) untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/summary_state` | `api/monitor.js` → tersimpan di broker | Tanggal terakhir ringkasan harian/mingguan device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/telegram/reminder` | bot (`/reminder`) → tersimpan di broker | JSON `{ "day": 25, "message": "..." }` pengingat bayar listrik custom untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/reminder_state` | `api/monitor.js` → tersimpan di broker | Bulan terakhir pengingat custom device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/billing/daily` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM-DD": rupiah }`, histori harian device ini, retained |
| `smartmeter/<deviceId>/billing/weekly` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM": { "week1": rupiah, ... } }`, retained |
| `smartmeter/<deviceId>/billing/daily_start`, `.../billing/weekly_start` | `api/monitor.js` internal | Nilai energi (kWh) di awal tiap hari/minggu device ini, dipakai hitung delta pemakaian, retained |

## Menyiapkan dashboard cloud & bot Telegram (`web-remote/`)

1. `cd web-remote && npm install`
2. Deploy ke Vercel: `vercel deploy --prod`
3. Set environment variable di Vercel (`vercel env add`, jangan di-hardcode ke kode):
   - `MQTT_USERNAME`, `MQTT_PASSWORD` — kredensial `smartenergymeterweb` (dipakai script.js sisi client, jadi memang publik — makanya harus read-only)
   - `BOT_MQTT_USERNAME`, `BOT_MQTT_PASSWORD` — kredensial `smartenergymeterbot`
   - `TELEGRAM_BOT_TOKEN` — token dari [@BotFather](https://t.me/BotFather)
4. Daftarkan webhook bot: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/telegram"`
5. Daftarkan daftar command bot (untuk autocomplete `/` di Telegram) lewat `setMyCommands` — lihat daftar command di bawah.
6. `GET /api/monitor` harus dipanggil secara berkala — endpoint ini bukan cuma untuk notifikasi (offline/overload), tapi juga **satu-satunya tempat** yang menghitung & menyimpan histori tagihan harian/mingguan (`smartmeter/billing/*`), mengirim ringkasan Telegram (21:00 WIB harian, Minggu 21:00 WIB mingguan), dan mengecek pengingat bayar listrik custom (`/reminder`, jam 08:00 WIB). Kalau endpoint ini tidak pernah dipanggil, histori tagihan tidak akan pernah ter-update dan pengingat custom tidak akan pernah terkirim. **Akun Vercel Hobby/gratis membatasi cron bawaan cuma 1x/hari**, jadi gunakan layanan cron gratis pihak ketiga seperti [cron-job.org](https://cron-job.org) untuk memanggil endpoint ini tiap beberapa menit.

### Command bot Telegram

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/limit` `/status` — cek data. `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/riwayat` — grafik & rincian biaya 7 hari terakhir (render via [QuickChart](https://quickchart.io), dikirim sebagai foto). `/reminder <tanggal 1-28> <pesan>` — set pengingat bayar listrik tiap bulan jam 08:00 WIB; `/reminder` tanpa argumen menampilkan pengingat aktif, `/reminder off` mematikannya. `/help` — bantuan.

## Catatan keamanan

- Kredensial WiFi/MQTT firmware **hanya** di `include/config.local.h`, tidak pernah di-commit (lihat `.gitignore`).
- Kredensial MQTT di dashboard cloud (`smartenergymeterweb`) **sengaja read-only** karena kodenya publik dan terlihat siapa saja lewat "View Source" — jangan pernah pakai kredensial full-access di sana.
- Kredensial bot (`smartenergymeterbot`, `TELEGRAM_BOT_TOKEN`) hanya hidup sebagai environment variable server-side di Vercel, tidak pernah masuk ke kode yang di-deploy ke browser.
- Dashboard lokal (`data/`) saat ini **belum** punya autentikasi HTTP aktif di sebagian besar endpoint (`/restart`, `/factoryReset`, `/setLimit`) meski field `WEB_USERNAME`/`WEB_PASSWORD` sudah ada di config — siapa pun di jaringan WiFi yang sama bisa akses. Pengecualiannya `/update` (OTA firmware): endpoint ini **menegakkan** HTTP Basic Auth begitu `WEB_USERNAME`/`WEB_PASSWORD` diisi, karena flash firmware sembarangan jauh lebih berbahaya daripada restart/reset.

## Struktur

- `src/`, `include/` — firmware ESP32 (PlatformIO).
- `data/` — dashboard lokal, di-flash ke LittleFS (`pio run -t uploadfs`). Diakses lewat IP lokal ESP32.
- `web-remote/` — dashboard cloud + bot Telegram, di-deploy terpisah ke Vercel. Berisi:
  - `index.html`, `script.js`, `style.css`, `bill.html` — dashboard & halaman tagihan (MQTT over WebSocket).
  - `api/telegram.js` — webhook bot Telegram.
  - `api/monitor.js` — endpoint pengecekan berkala untuk notifikasi otomatis.
