# Smart Energy Meter

Firmware ESP32 untuk memantau pemakaian listrik lewat sensor PZEM-004T (plus suhu chip ESP32 dari sensor internalnya), dengan dashboard lokal, dashboard cloud, dan bot Telegram — semuanya terhubung lewat broker MQTT.

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

- **Firmware ESP32** membaca data dari PZEM-004T dan suhu chip-nya sendiri, menampilkannya di OLED, menyajikan dashboard lokal via HTTP/WebSocket, dan mem-publish telemetri ke broker MQTT (retained + status online/offline lewat Last Will).
- **Dashboard lokal** (`data/`) hanya bisa diakses dari jaringan WiFi yang sama dengan perangkat. Bisa untuk kontrol penuh (restart, factory reset, update firmware OTA).
- **Dashboard cloud** (`web-remote/`) di-deploy ke Vercel, bisa diakses dari mana saja lewat internet karena mengambil data langsung dari broker MQTT (bukan dari perangkat). Menggunakan kredensial MQTT read-only demi keamanan.
- **Bot Telegram** (juga di `web-remote/api/`) menjawab pertanyaan data (`/watt`, `/kwh`, dll), bisa mengubah batas daya (`/setlimit`), dan mengirim notifikasi otomatis saat perangkat offline atau daya melebihi batas.

## Menyiapkan firmware

1. Salin `include/config.example.h` menjadi `include/config.local.h`.
2. Isi kredensial MQTT milik Anda sendiri. File lokal ini diabaikan Git. **`WIFI_SSID`/`WIFI_PASSWORD` boleh dikosongkan** — device baru akan otomatis masuk mode setup WiFi lewat browser saat pertama nyala, lihat bagian "Setup WiFi pertama kali" di bawah. Isi keduanya hanya kalau Anda ingin WiFi sudah langsung tersambung tanpa perlu setup manual (misal untuk testing cepat di meja).
3. Isi sertifikat CA broker pada `MQTT_CA_CERT` (lihat catatan format di bawah). Jangan gunakan `MQTT_TLS_INSECURE` di perangkat produksi.
4. Suhu chip ESP32 dibaca dari sensor internal, tidak butuh kabel atau komponen tambahan. **Catatan:** pada sebagian board ESP32 klasik, sensor internal ini menghasilkan angka mentah yang macet (selalu 53,33°C). Firmware mendeteksinya dan tidak mengirim angka itu — OLED menampilkan "N/A", dashboard menampilkan "-", dan bot menyatakan datanya tidak tersedia.
5. Build dan unggah firmware serta filesystem dengan PlatformIO:

   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```

`data/` adalah aset dashboard lokal yang dipasang ke LittleFS.

> **Catatan format `MQTT_CA_CERT`:** compiler ESP32 di proyek ini tidak mendukung raw string literal (`R"EOF(...)EOF"`) multi-baris di dalam macro `#define`. Sertifikat harus ditulis sebagai concatenated string literals dengan `\n` eksplisit dan backslash continuation di akhir tiap baris — lihat contoh di `config.example.h`.

## Setup WiFi pertama kali (lewat browser, tanpa colok laptop)

Device tidak perlu tahu WiFi rumah Anda sebelum di-flash. Kalau belum ada WiFi yang tersimpan (device baru, atau `WIFI_SSID` dikosongkan di `config.local.h`), begitu dinyalakan device otomatis membuka mode setup:

1. OLED menampilkan nama WiFi setup (`SmartMeter-Setup`) dan **PIN 8 digit acak** — PIN ini dibuat baru setiap kali masuk mode setup dan cuma tampil di layar device, jadi cuma orang yang benar-benar berdiri di depan alatnya yang bisa lihat dan menyambung. Device butuh beberapa detik memindai WiFi sekitar dulu sebelum `SmartMeter-Setup` benar-benar bisa disambung — kalau belum kelihatan di daftar WiFi HP, tunggu sebentar lalu refresh.
2. Dari HP/laptop, sambungkan ke WiFi bernama **`SmartMeter-Setup`**, masukkan PIN yang tampil di OLED sebagai password-nya.
3. Browser biasanya otomatis membuka halaman setup sendiri (seperti WiFi kafe/hotel). Kalau tidak, buka `http://192.168.4.1` manual.
4. Pilih nama WiFi rumah Anda dari daftar (device sudah scan duluan sebelum halaman ini kebuka), isi passwordnya, klik **Sambungkan**.
5. Kalau berhasil, device restart otomatis dan langsung tersambung ke WiFi itu setiap kali nyala berikutnya — tidak perlu setup ulang.
6. Kalau gagal (password salah/sinyal lemah), halaman tetap terbuka untuk dicoba lagi.

WiFi yang tersimpan lewat cara ini disimpan di memori device (NVS), **lebih diutamakan** daripada `WIFI_SSID`/`WIFI_PASSWORD` di `config.local.h` — jadi aman walau firmware nanti di-update ulang tanpa WiFi dikompilasi ke dalamnya.

**Mau ganti WiFi nanti** (pindah rumah, ganti router)? Tekan dan **tahan tombol BOOT** di board ESP32 selama ±2 detik — bisa kapan saja, tidak harus pas baru dinyalakan, device yang sedang berjalan normal pun langsung masuk mode setup begitu ditahan 2 detik. Data lain (batas daya, dll) tidak ikut terhapus. Factory reset (`/factoryReset` di dashboard lokal atau lewat MQTT) juga ikut menghapus WiFi tersimpan sebagai bagian dari reset total.

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
| `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`) — kode ini publik/terlihat siapa saja | Subscribe `smartmeter/data`, `smartmeter/status` saja. **Publish harus di-deny** (topic `#`) |
| `smartenergymeterbot` | Bot Telegram + `api/monitor.js` (`web-remote/api/*.js`) — server-side, tidak publik | Subscribe `smartmeter/data`, `smartmeter/status`, `smartmeter/telegram/#`, `smartmeter/billing/#`. Publish `smartmeter/cmd/limit`, `smartmeter/telegram/#`, `smartmeter/billing/#` |

**Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.

### Topic MQTT

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, chipTemperature = suhu chip ESP32 — tidak dikirim kalau sensor internalnya tidak valid, dll), **retained** |
| `smartmeter/status` | broker → subscriber | `"online"` / `"offline"` — di-set via MQTT Last Will, jadi otomatis `"offline"` kalau ESP32 putus koneksi tanpa sempat pamit |
| `smartmeter/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/telegram/chatid` | bot → tersimpan di broker | Chat ID Telegram terdaftar, retained |
| `smartmeter/telegram/alert_state` | bot → tersimpan di broker | State notifikasi (sudah/belum alert offline/overload), retained |
| `smartmeter/telegram/summary_state` | `api/monitor.js` → tersimpan di broker | Tanggal terakhir ringkasan harian/mingguan terkirim (dedup), retained |
| `smartmeter/telegram/reminder` | bot (`/reminder`) → tersimpan di broker | JSON `{ "day": 25, "message": "..." }` pengingat bayar listrik custom, retained |
| `smartmeter/telegram/reminder_state` | `api/monitor.js` → tersimpan di broker | Bulan terakhir pengingat custom terkirim (dedup), retained |
| `smartmeter/billing/daily` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM-DD": rupiah }`, histori harian bersama semua device, retained |
| `smartmeter/billing/weekly` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM": { "week1": rupiah, ... } }`, retained |
| `smartmeter/billing/daily_start`, `smartmeter/billing/weekly_start` | `api/monitor.js` internal | Nilai energi (kWh) di awal tiap hari/minggu, dipakai hitung delta pemakaian, retained |

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

**Menu tombol:** kirim `/start`, `/help`, atau `/menu` — bot membalas dengan tombol yang bisa langsung ditekan (Daya, Energi, Tegangan, Arus, Suhu, Power Factor, Status Lengkap, Batas Daya, Riwayat, Pengingat), jadi tidak perlu hafal nama command. Setiap kali tombol ditekan, menu ikut terkirim lagi bersama jawabannya supaya bisa lanjut menekan tombol berikutnya. Command ketik tetap jalan seperti biasa.

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/suhu` `/limit` `/status` — cek data (`/suhu` menampilkan suhu chip ESP32). `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/riwayat` — grafik & rincian biaya 7 hari terakhir (render via [QuickChart](https://quickchart.io), dikirim sebagai foto). `/reminder <tanggal 1-28> <pesan>` — set pengingat bayar listrik tiap bulan jam 08:00 WIB; `/reminder` tanpa argumen menampilkan pengingat aktif, `/reminder off` mematikannya. `/help` — bantuan.

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
