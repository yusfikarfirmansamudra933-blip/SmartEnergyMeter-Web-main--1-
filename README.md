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
4. Suhu chip ESP32 dibaca dari sensor internal, tidak butuh kabel atau komponen tambahan. **Catatan akurasi:** sensor ini tidak dikalibrasi pabrik, jadi angka absolutnya bisa meleset beberapa derajat — andalkan tren naik/turunnya, bukan angka persisnya. Fungsi bawaan Arduino (`temperatureRead()`) sengaja tidak dipakai: ia menunggu terlalu singkat setelah sensor dinyalakan sehingga hampir selalu mengembalikan angka macet 53,33°C. `src/chipTemp.cpp` membaca register sensor sendiri dengan waktu tunggu yang cukup (diukur di board ESP32-D0WD-V3: stabil mulai ±1 ms).
5. Build dan unggah firmware serta filesystem dengan PlatformIO:

   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```

`data/` adalah aset dashboard lokal yang dipasang ke LittleFS.

> **Catatan format `MQTT_CA_CERT`:** compiler ESP32 di proyek ini tidak mendukung raw string literal (`R"EOF(...)EOF"`) multi-baris di dalam macro `#define`. Sertifikat harus ditulis sebagai concatenated string literals dengan `\n` eksplisit dan backslash continuation di akhir tiap baris — lihat contoh di `config.example.h`.

## Setup WiFi pertama kali (lewat browser, tanpa colok laptop)

Device tidak perlu tahu WiFi rumah Anda sebelum di-flash. Kalau belum ada WiFi yang tersimpan (device baru, atau `WIFI_SSID` dikosongkan di `config.local.h`), begitu dinyalakan device otomatis membuka mode setup:

1. OLED menampilkan nama WiFi setup (`SmartMeter-xxxxxx`, enam karakter terakhirnya sama dengan ID alat, jadi beberapa alat yang sedang setup bersamaan tetap bisa dibedakan) dan **PIN 8 digit acak**. PIN ini dibuat baru setiap kali masuk mode setup dan cuma tampil di layar device, jadi cuma orang yang benar-benar berdiri di depan alatnya yang bisa lihat dan menyambung. Device butuh beberapa detik memindai WiFi sekitar dulu sebelum jaringan setup benar-benar bisa disambung. Kalau belum kelihatan di daftar WiFi HP, tunggu sebentar lalu refresh.
2. Dari HP/laptop, sambungkan ke WiFi yang namanya tampil di OLED, masukkan PIN yang tampil di OLED sebagai password-nya.
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
3. Kalau berhasil konek dalam 20 detik → lanjut boot normal (MQTT, web server, dst). Kalau broker MQTT diatur, firmware baru masih harus tersambung ke broker dalam 5 menit sejak boot; baru setelah itu tanda dihapus dan firmware baru dipercaya. Kalau tidak tersambung, alat juga rollback, karena firmware yang tidak bisa ke broker tidak akan pernah menerima perbaikan lewat cloud.
4. Kalau gagal (misal firmware baru ada bug yang bikin WiFi tidak pernah konek) → otomatis `Update.rollBack()` ke firmware sebelumnya di partisi OTA yang lain, lalu restart — **tanpa perlu USB atau intervensi manual sama sekali**. OLED menampilkan "Rollback! Restarting...".

Pengecekan ini cuma jalan sekali per OTA (bukan tiap boot), jadi tidak menambah waktu boot untuk restart/power-cycle biasa. Kalau tidak ada firmware valid di partisi satunya untuk di-rollback (misal baru sekali pernah di-flash), perangkat tetap lanjut boot dengan firmware yang ada — tidak ada tempat lain untuk kembali.

### Update firmware dari cloud (mulai 1.17.0)

Alat yang sudah di rumah pelanggan bisa di-update tanpa kabel dan tanpa berada di jaringan WiFi yang sama. Setiap alat membuka `https://web-remote-nine.vercel.app/firmware/latest.json` 2 menit setelah boot lalu tiap 6 jam, dan memasang versi yang lebih baru dari `FIRMWARE_VERSION`-nya (`src/cloudOta.cpp`). Auto-rollback di atas tetap berlaku.

File firmware di folder itu **dienkripsi dan ditandatangani** dengan `OTA_KEY`. Alasannya: `firmware.bin` memuat password WiFi dan MQTT dari `config.local.h`, sedangkan folder itu bisa diunduh siapa saja. Alat menolak file yang tanda tangannya tidak cocok, jadi hanya rilis dari komputer yang memegang kunci yang bisa terpasang. Unduhan memakai HTTPS dengan sertifikat root yang ditanam di `include/otaRoots.h`.

Sekali saja di awal:

```sh
cd web-remote
node scripts/release-firmware.js --new-key
```

Perintah ini membuat `web-remote/ota-key.local.txt` dan menambahkan baris `OTA_KEY` ke `include/config.local.h` (keduanya tidak di-commit dan tidak di-deploy). Build lalu upload firmware ini **sekali** lewat USB atau `/update` ke setiap alat yang sudah ada: alat dengan firmware lama atau kunci lain tidak ikut update dari cloud. Kalau `ota-key.local.txt` hilang, alat-alat itu tidak bisa lagi di-update dari cloud, jadi simpan salinannya di tempat aman.

Setiap rilis:

1. Naikkan `FIRMWARE_VERSION` di `include/config.h`, lalu `pio run`.
2. `node scripts/release-firmware.js --only sem-c466ec` untuk mencoba di satu alat dulu, atau tanpa `--only` untuk semua alat. Hasilnya `web-remote/firmware/latest.json` dan `fw-<versi>.bin` (tidak di-commit).
3. `npx vercel deploy --prod`. Alat memasangnya dalam 6 jam, atau langsung lewat tombol **Cek update sekarang** di halaman admin.

Selama mengunduh (sekitar setengah menit), OLED menampilkan progres dan pembacaan PZEM berhenti sebentar. Kalau versi yang sama pernah gagal lalu rollback, alat tidak mencobanya lagi sendiri sampai ada versi yang lebih baru atau tombol **Cek update sekarang** ditekan. Firmware sekarang memakai 86% partisi aplikasi; rilis yang melewati 100% tidak bisa dipasang lewat OTA.

## Menyiapkan broker MQTT (EMQX Cloud)

Firmware butuh broker MQTT dengan TLS. Proyek ini pakai [EMQX Cloud](https://www.emqx.com/en/cloud) (tier Serverless gratis). Buat 3 user Authentication dengan Authorization (ACL) berbeda hak akses. **Semua alat memakai satu user firmware yang sama**, jadi menambah alat ke-2, ke-10, atau ke-100 tidak perlu mengubah EMQX sama sekali:

| User | Dipakai oleh | Hak akses |
|---|---|---|
| `smartenergymeter` (kredensial firmware, di `config.local.h`) | Semua ESP32 | Publish & Subscribe `smartmeter/${clientid}/#`. `${clientid}` diganti EMQX dengan client ID alat yang sedang terhubung (= ID alat, mis. `sem-a1b2c3`), jadi tiap alat hanya bisa menyentuh topiknya sendiri |
| `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`). Kode ini publik/terlihat siapa saja | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/history`, `smartmeter/+/billing/#` saja. **Publish harus di-deny** (topic `#`) |
| `smartenergymeterbot` | Bot Telegram, `api/monitor.js`, `api/power.js` (`web-remote/api/*.js`). Server-side, tidak publik | Publish & Subscribe `smartmeter/#` (membaca semua alat, mengirim perintah, menyimpan tagihan & status Telegram) |

**Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.

### Topic MQTT

Setiap alat punya ID sendiri: `sem-` + 6 karakter terakhir MAC chip-nya (mis. `sem-a1b2c3`). ID ini dibuat otomatis oleh firmware, jadi satu `firmware.bin` yang sama bisa di-flash ke semua alat. ID tampil di OLED (halaman yang judulnya `ID sem-...`), di Serial Monitor saat boot, dan di `/api/status` dashboard lokal. Semua topik alat ada di bawah `smartmeter/<id>/`:

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/<id>/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, chipTemperature = suhu chip ESP32, tidak dikirim kalau belum ada pembacaan valid, dll), **retained** |
| `smartmeter/<id>/status` | ESP32/broker → subscriber | `"online"` / `"standby"` / `"offline"`. `"standby"` = pemantauan dijeda dari dashboard (ESP32 tetap terhubung). `"offline"` di-set via MQTT Last Will, jadi otomatis muncul kalau ESP32 putus koneksi tanpa sempat pamit. `api/monitor.js` menemukan alat baru dari topik ini |
| `smartmeter/<id>/history` | ESP32 → dashboard | JSON rata-rata per menit untuk 60 menit terakhir: `{ "interval": 60, "end": <epoch UTC, 0 kalau jam belum sinkron>, "power": [...], "voltage": [...], "current": [...], "frequency": [...], "pf": [...], "chipTemperature": [...] }`, urut dari yang terlama, `null` untuk menit tanpa data (standby/sensor mati). Dikirim tiap menit, **retained** |
| `smartmeter/<id>/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/<id>/cmd/power` | `api/power.js` → ESP32 | `"off"` = standby (PZEM tidak dibaca, OLED menampilkan STANDBY, data tidak dikirim), `"on"` = normal lagi. Tidak retained; setiap boot perangkat selalu mulai dalam mode normal |
| `smartmeter/<id>/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/<id>/cmd/update` | `api/admin.js` → ESP32 | Publish apa saja: alat langsung memeriksa `latest.json`. Yang dipasang tetap ditentukan rilis bertanda tangan di server, bukan isi pesan ini |
| `smartmeter/<id>/info` | ESP32 → `api/admin.js` | JSON `{ "fw": "1.17.0", "ip": "...", "rssi": -61, "heap": ... }`, dikirim setiap tersambung ke broker, retained |
| `smartmeter/<id>/ota` | ESP32 → `api/admin.js` | JSON `{ "state": "current" / "downloading" / "updated" / "failed", "version": "...", "error": "..." }`, hasil pemeriksaan update terakhir, retained |
| `smartmeter/<id>/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/<id>/control/lockout` | `api/power.js`, bot | Penghitung PIN salah alat ini (5 kali salah = terkunci 15 menit), retained |
| `smartmeter/<id>/telegram/alert_state` | `api/monitor.js` | State notifikasi (sudah/belum alert offline/overload/standby), retained |
| `smartmeter/<id>/telegram/summary_state` | `api/monitor.js` | Tanggal terakhir ringkasan harian/mingguan terkirim (dedup), retained |
| `smartmeter/<id>/telegram/reminder` | bot (`/reminder`) | JSON `{ "day": 25, "message": "..." }` pengingat bayar listrik custom, retained |
| `smartmeter/<id>/telegram/reminder_state` | `api/monitor.js` | Bulan terakhir pengingat custom terkirim (dedup), retained |
| `smartmeter/<id>/billing/daily` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM-DD": rupiah }`, retained |
| `smartmeter/<id>/billing/weekly` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM": { "week1": rupiah, ... } }`, retained |
| `smartmeter/<id>/billing/daily_start`, `.../weekly_start` | `api/monitor.js` internal | Nilai energi (kWh) di awal tiap hari/minggu, dipakai hitung delta pemakaian, retained |
| `smartmeter/<id>/billing/daily_kwh`, `.../weekly_kwh` | `api/monitor.js` → bill.html, bot | kWh per hari / per minggu, bentuknya sama dengan `daily`/`weekly`. Disimpan terpisah dari rupiah karena rupiah dibagi tarif baru tidak lagi memberi kWh hari-hari sebelum tarif diganti, retained |
| `smartmeter/<id>/billing/tariff` | `api/tariff.js`, bot (`/tarif`) → ESP32, cron, bill.html | JSON `{ "code": "R1-900", "rate": 1352 }` golongan tarif alat ini. Tidak ada = tarif awal R-1 1.300 VA. Cron memakai tarif hari itu untuk rupiah hari itu, jadi mengganti golongan tidak mengubah tagihan hari-hari sebelumnya. Di bawah `billing/` supaya izin EMQX yang sudah ada sudah mencakupnya, retained |
| `smartmeter/_bot/chat/<chatId>` | bot | JSON `{ "active": "sem-a1b2c3", "devices": [...] }`: alat yang terhubung ke chat Telegram itu, retained |

**Pindah dari firmware lama (sebelum 1.15.0):** dulu topiknya `smartmeter/data`, `smartmeter/billing/daily`, dst tanpa ID. Begitu alat pertama muncul dengan firmware baru, `api/monitor.js` otomatis memindahkan histori tagihan, pengingat, dan chat Telegram lama ke alat itu, lalu menghapus topik lama. Ini hanya jalan kalau baru ada **satu** alat di broker, supaya histori tidak salah masuk ke alat lain.

## Akun pemilik & riwayat panjang (Supabase)

Data live tetap lewat MQTT. Supabase (project `omrjqsolejpxiduogzfn`, region Singapura) menyimpan dua hal yang tidak muat di pesan retained:

- **Riwayat panjang.** Setiap kali `api/monitor.js` jalan, `lib/ingest.js` menyalin `smartmeter/<id>/history` (60 menit terakhir) ke tabel `readings_minute`, dan `billing/daily` + `billing/daily_kwh` ke `billing_daily`. Penulisan memakai upsert per (alat, menit) dan (alat, hari), jadi aman dijalankan berulang. Selama cron jalan minimal sekali sejam, tidak ada menit yang terlewat. Data per menit disimpan 30 hari; job `pg_cron` `rollup-old-readings` (03.15 WIB) merangkumnya ke `readings_hour` lalu menghapus menit lama.
- **Akun pemilik.** Masuk dengan link email atau Google (`auth.js`). Di halaman **Alat** (`devices.html`), pemilik menambah alat dengan ID + PIN label (`api/claim.js`), memberi nama, atau melepasnya. Satu alat boleh punya beberapa pemilik. Pemilik yang sedang masuk bisa membuka grafik 24 jam / 7 hari / 30 hari (fungsi `device_history`) dan memakai tombol Pemantauan serta Golongan tarif **tanpa PIN** (`lib/authorize.js`). Tanpa masuk, semuanya tetap bisa dipakai dengan PIN seperti sebelumnya.

| Tabel | Isi | Siapa yang bisa baca (RLS) |
|---|---|---|
| `devices` | ID alat, pertama dan terakhir terlihat | pemiliknya |
| `device_owners` | alat ↔ akun, nama alat | akun itu sendiri (boleh ubah nama dan melepas) |
| `readings_minute` | rata-rata per menit: daya, tegangan, arus, frekuensi, PF, suhu chip | pemilik alat |
| `readings_hour` | rangkuman per jam (rata-rata, min/maks) untuk data lebih dari 30 hari | pemilik alat |
| `billing_daily` | Rp dan kWh per hari | pemilik alat |

Hanya server (kunci secret) yang menulis; browser memakai kunci publishable dan hanya bisa membaca baris milik akunnya. Setelan sekali saja:

1. Vercel: tambah `SUPABASE_SECRET_KEY` (Supabase → Project Settings → API Keys → Secret key), lalu deploy ulang. Tanpa ini riwayat tidak tersalin dan `api/claim` menolak permintaan.
2. Supabase → Authentication → URL Configuration: Site URL `https://web-remote-nine.vercel.app`, dan Redirect URLs `https://web-remote-nine.vercel.app/**`.
3. Login Google: buat OAuth Client (Web application) di Google Cloud Console dengan Authorized redirect URI `https://omrjqsolejpxiduogzfn.supabase.co/auth/v1/callback`, lalu isi Client ID dan Client Secret di Supabase → Authentication → Sign In / Providers → Google.

Email link masuk memakai SMTP bawaan Supabase, yang dibatasi beberapa email per jam. Cukup untuk sedikit pemilik; untuk banyak pengguna pasang SMTP sendiri.

### Halaman admin

`admin.html` untuk penjual: semua alat yang pernah terhubung (dari tabel `devices` dan broker), status, versi firmware, hasil update terakhir, pemilik (email dan nama alat), terakhir online, sinyal WiFi, serta tombol **Cek update sekarang**, **Restart**, dan **Minta semua alat online cek update**. Datanya dari `api/admin.js`, yang hanya menjawab akun yang emailnya ada di environment variable Vercel `ADMIN_EMAILS` (pisahkan dengan koma). Akun admin melihat tautan **Halaman admin** di bawah halaman Alat.

## Menyiapkan dashboard cloud & bot Telegram (`web-remote/`)

1. `cd web-remote && npm install`
2. Deploy ke Vercel: `vercel deploy --prod`
3. Set environment variable di Vercel (`vercel env add`, jangan di-hardcode ke kode):
   - `MQTT_USERNAME`, `MQTT_PASSWORD` — kredensial `smartenergymeterweb` (dipakai script.js sisi client, jadi memang publik — makanya harus read-only)
   - `BOT_MQTT_USERNAME`, `BOT_MQTT_PASSWORD` — kredensial `smartenergymeterbot`
   - `TELEGRAM_BOT_TOKEN` — token dari [@BotFather](https://t.me/BotFather)
   - `CONTROL_SECRET`: kunci rahasia untuk membuat PIN tiap alat (lihat "Menambah alat baru" di bawah). Tanpa variabel ini, tombol Pemantauan di dashboard dan `/hubungkan` di bot menolak semua permintaan
   - `ADMIN_EMAILS`: email akun yang boleh membuka halaman admin, dipisahkan koma
4. Daftarkan webhook bot: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/telegram"`
5. Daftarkan daftar command bot (untuk autocomplete `/` di Telegram) lewat `setMyCommands` — lihat daftar command di bawah.
6. `GET /api/monitor` harus dipanggil secara berkala — endpoint ini bukan cuma untuk notifikasi (offline/overload), tapi juga **satu-satunya tempat** yang menghitung & menyimpan histori tagihan harian/mingguan (`smartmeter/billing/*`), mengirim ringkasan Telegram (21:00 WIB harian, Minggu 21:00 WIB mingguan), dan mengecek pengingat bayar listrik custom (`/reminder`, jam 08:00 WIB). Kalau endpoint ini tidak pernah dipanggil, histori tagihan tidak akan pernah ter-update dan pengingat custom tidak akan pernah terkirim. **Akun Vercel Hobby/gratis membatasi cron bawaan cuma 1x/hari**, jadi gunakan layanan cron gratis pihak ketiga seperti [cron-job.org](https://cron-job.org) untuk memanggil endpoint ini tiap beberapa menit.

### Menambah alat baru

Tidak ada yang perlu diatur di EMQX, Vercel, atau kode:

1. Flash `firmware.bin` yang sama (lewat USB untuk alat baru, atau OTA).
2. Nyalakan alat, setup WiFi-nya (lihat "Setup WiFi pertama kali"). Catat ID yang tampil di OLED.
3. Buat label berisi ID, PIN, dan QR code. Sekali saja di awal, buat kuncinya lalu masukkan isinya ke Vercel sebagai `CONTROL_SECRET`:

   ```sh
   cd web-remote
   node scripts/device-label.js --new-secret
   ```

   Setelah itu, setiap ada alat baru:

   ```sh
   node scripts/device-label.js --bot <username_bot_telegram> sem-a1b2c3 sem-d4e5f6
   ```

   Hasilnya `web-remote/labels.local.html`: buka, cetak, tempel di tiap alat. PIN tiap alat dihitung dari ID-nya plus `CONTROL_SECRET`, jadi tidak disimpan di mana pun dan tidak perlu didaftarkan. Kalau secret diganti, semua PIN lama ikut tidak berlaku. File secret dan label tidak ikut di-commit maupun di-deploy (`.gitignore`, `.vercelignore`).
4. Pemilik alat memindai QR **Dashboard** (membuka `/?device=<id>`) dan QR **Telegram** (membuka bot dan langsung menautkan alat lewat `/start <id>_<pin>`).

Di dashboard cloud, tombol **Ganti** di baris "Perangkat" membuka daftar alat yang pernah dibuka di browser itu dan kolom untuk mengetik ID lain.

### Golongan tarif PLN

Tarif per kWh tiap golongan ada di satu file, `web-remote/tariffs.js`, dipakai dashboard, cron, dan bot. Angkanya tarif triwulan III 2026 (masih berlaku per Oktober 2026). Kalau ESDM/PLN menetapkan tarif baru, ubah angka di file itu lalu deploy; firmware tidak perlu diubah karena alat menerima angkanya lewat `billing/tariff`. Alat yang golongannya sudah diatur tetap memakai angka lama sampai golongannya disimpan ulang dari dashboard atau `/tarif`.

Pemilik alat mengganti golongan dari kartu **Golongan tarif PLN** di halaman Tagihan (pakai PIN alat) atau lewat bot `/tarif <kode>`. Layar OLED menghitung tagihan sebulan dengan tarif terbaru, jadi kalau golongan diganti di tengah bulan angka di OLED adalah perkiraan; angka di dashboard tetap dihitung per hari.

### Command bot Telegram

**Menautkan alat:** `/hubungkan <ID> <PIN>` (atau pindai QR Telegram di label). Satu chat boleh terhubung ke beberapa alat. Perintah data selalu ke **alat aktif**: `/perangkat` untuk melihat dan mengganti alat aktif, `/lepas` untuk melepas alat aktif. Notifikasi otomatis dikirim ke semua chat yang terhubung ke alatnya, diawali ID alat kalau chat itu terhubung ke lebih dari satu alat. Chat yang belum menautkan alat hanya mendapat petunjuk cara menautkan.

**Menu tombol:** kirim `/start`, `/help`, atau `/menu` — bot membalas dengan tombol yang bisa langsung ditekan (Daya, Energi, Tegangan, Arus, Suhu, Power Factor, Status Lengkap, Batas Daya, Riwayat, Pengingat), jadi tidak perlu hafal nama command. Setiap kali tombol ditekan, menu ikut terkirim lagi bersama jawabannya supaya bisa lanjut menekan tombol berikutnya. Command ketik tetap jalan seperti biasa.

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/suhu` `/limit` `/status` — cek data (`/suhu` menampilkan suhu chip ESP32). `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/riwayat` — grafik & rincian biaya 7 hari terakhir (render via [QuickChart](https://quickchart.io), dikirim sebagai foto). `/reminder <tanggal 1-28> <pesan>` — set pengingat bayar listrik tiap bulan jam 08:00 WIB; `/reminder` tanpa argumen menampilkan pengingat aktif, `/reminder off` mematikannya. `/tarif` — lihat golongan tarif alat aktif beserta daftar kodenya; `/tarif <kode>` (mis. `/tarif R1-900`) menggantinya. `/help` — bantuan.

## Catatan keamanan

- Kredensial WiFi/MQTT firmware **hanya** di `include/config.local.h`, tidak pernah di-commit (lihat `.gitignore`).
- Kredensial MQTT di dashboard cloud (`smartenergymeterweb`) **sengaja read-only** karena kodenya publik dan terlihat siapa saja lewat "View Source" — jangan pernah pakai kredensial full-access di sana.
- Kredensial bot (`smartenergymeterbot`, `TELEGRAM_BOT_TOKEN`, `CONTROL_SECRET`) hanya hidup sebagai environment variable server-side di Vercel, tidak pernah masuk ke kode yang di-deploy ke browser.
- **Vercel CLI tidak membaca `.gitignore`.** File apa pun di `web-remote/` yang tidak tercantum di `web-remote/.vercelignore` ikut ter-upload dan bisa diunduh publik. Simpan catatan kredensial lokal dengan akhiran `.local.txt` (sudah dikecualikan), atau di luar folder `web-remote/`.
- `web-remote/ota-key.local.txt` (sama dengan `OTA_KEY` di `config.local.h`) adalah satu-satunya hal yang membuat alat mau memasang firmware dari cloud. Siapa pun yang memegangnya, dan bisa deploy ke project Vercel ini, bisa memasang firmware apa saja ke semua alat.
- Semua alat berbagi satu password MQTT firmware. Orang yang membongkar satu alat bisa mengambil password itu lalu menyamar sebagai alat lain (memilih client ID lain). Untuk produk yang dijual luas, beri tiap alat username sendiri (EMQX bisa impor daftar user dari CSV) dan ganti aturan ACL-nya ke `smartmeter/${username}/#`.
- Dashboard lokal (`data/`) saat ini **belum** punya autentikasi HTTP aktif di sebagian besar endpoint (`/restart`, `/factoryReset`, `/setLimit`) meski field `WEB_USERNAME`/`WEB_PASSWORD` sudah ada di config — siapa pun di jaringan WiFi yang sama bisa akses. Pengecualiannya `/update` (OTA firmware): endpoint ini **menegakkan** HTTP Basic Auth begitu `WEB_USERNAME`/`WEB_PASSWORD` diisi, karena flash firmware sembarangan jauh lebih berbahaya daripada restart/reset.

## Struktur

- `src/`, `include/` — firmware ESP32 (PlatformIO).
- `data/` — dashboard lokal, di-flash ke LittleFS (`pio run -t uploadfs`). Diakses lewat IP lokal ESP32.
- `web-remote/` — dashboard cloud + bot Telegram, di-deploy terpisah ke Vercel. Berisi:
  - `index.html`, `script.js`, `theme.css`, `bill.html`: dashboard & halaman tagihan (MQTT over WebSocket).
  - `api/telegram.js` — webhook bot Telegram.
  - `api/monitor.js` — endpoint pengecekan berkala untuk notifikasi otomatis.
  - `api/power.js`: tombol Pemantauan (standby) dashboard, dicek dengan PIN alat.
  - `api/tariff.js`: simpan golongan tarif dari halaman Tagihan, dicek dengan PIN alat atau akun pemilik.
  - `api/claim.js`: tambah alat ke akun yang sedang masuk (ID + PIN).
  - `lib/supabase.js`, `lib/ingest.js`, `lib/authorize.js`: akses Supabase dari server, penyalinan riwayat, dan cek pemilik/PIN.
  - `auth.js`, `devices.html`, `devices.js`: akun pemilik dan halaman Alat.
  - `tariffs.js`: daftar golongan tarif PLN, dipakai browser dan server.
  - `lib/devices.js`: ID alat, topik, PIN, dan koneksi MQTT bot yang dipakai bersama semua `api/`.
  - `device.js`: pemilih perangkat di dashboard (ID dari `?device=` atau pilihan terakhir).
  - `scripts/device-label.js`: pembuat label ID/PIN/QR, dijalankan lokal saja.
