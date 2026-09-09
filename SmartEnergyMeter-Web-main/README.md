# Smart Energy Meter

Firmware ESP32 untuk memantau pemakaian listrik lewat sensor PZEM-004T, dengan dashboard lokal, dashboard cloud, dan bot Telegram — semuanya terhubung lewat broker MQTT. Mendukung banyak unit fisik sekaligus (multi-device) di bawah satu akun, tanpa perlu reflash atau edit config per unit.

## Fitur

- Monitoring real-time (tegangan, arus, daya, energi, frekuensi, power factor) via OLED, dashboard lokal, dan dashboard cloud.
- Estimasi & histori tagihan listrik harian/mingguan, dengan proyeksi akhir bulan.
- Bot Telegram: cek data, ubah batas daya, notifikasi otomatis (offline/overload), pengingat bayar listrik custom, riwayat pemakaian dalam bentuk grafik.
- Update firmware OTA lewat dashboard lokal (tanpa USB), dengan auto-rollback kalau firmware baru gagal connect WiFi.
- Multi-device: akun web (login lewat email, tanpa password), setiap device di-pairing lewat kode yang muncul di OLED, WiFi disetel lewat portal bawaan device (tanpa kabel, tanpa reflash).

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
                                                            │ • Login & daftar      │
                                                            │   device (Supabase)   │
                                                            └───────────┬──────────┘
                                                                        │
                                                                        ▼
                                                              ┌──────────────────┐
                                                              │ Supabase (Postgres)│
                                                              │ • Akun user        │
                                                              │ • Daftar device     │
                                                              │ • Link Telegram     │
                                                              └──────────────────┘
```

- **Firmware ESP32** membaca data dari PZEM-004T, menampilkannya di OLED, menyajikan dashboard lokal via HTTP/WebSocket, dan mem-publish telemetri ke broker MQTT (retained + status online/offline lewat Last Will). Generate id sendiri dari MAC address supaya banyak unit tidak bentrok di broker yang sama.
- **Dashboard lokal** (`data/`) hanya bisa diakses dari jaringan WiFi yang sama dengan perangkat. Bisa untuk kontrol penuh (restart, factory reset, update firmware OTA).
- **Dashboard cloud** (`web-remote/`) di-deploy ke Vercel, bisa diakses dari mana saja lewat internet karena mengambil data langsung dari broker MQTT (bukan dari perangkat). Menggunakan kredensial MQTT read-only demi keamanan.
- **Bot Telegram** (juga di `web-remote/api/`) menjawab pertanyaan data (`/watt`, `/kwh`, dll), bisa mengubah batas daya (`/setlimit`), dan mengirim notifikasi otomatis saat perangkat offline atau daya melebihi batas. Terikat ke akun lewat `/link`, bukan siapa cepat chat duluan.
- **Supabase** (Postgres) menyimpan akun user (login magic-link), daftar device tiap user, dan link chat Telegram ke akun — dengan Row Level Security supaya tiap user cuma lihat datanya sendiri.

## Panduan setup dari nol

Urutan ini penting — tiap langkah butuh yang sebelumnya sudah beres. Untuk unit ke-2 dan seterusnya, cukup ulangi langkah 4-5 saja (lihat "Menambahkan device lain" di bawah).

### 1. Menyiapkan broker MQTT (EMQX Cloud)

Firmware butuh broker MQTT dengan TLS. Proyek ini pakai [EMQX Cloud](https://www.emqx.com/en/cloud) (tier Serverless gratis).

1. Buat project baru di EMQX Cloud, catat host & port MQTT over TLS-nya (biasanya port `8883` untuk MQTT biasa, `8084` untuk MQTT over WebSocket yang dipakai dashboard cloud/bot).
2. Buat **3 user** Authentication dengan Authorization (ACL) berbeda hak akses:

   | User | Dipakai oleh | Hak akses |
   |---|---|---|
   | (kredensial firmware, di `config.local.h`) | ESP32 | Full — publish semua topic, subscribe `cmd/*` |
   | `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`, `devices.html`) — kode ini publik/terlihat siapa saja | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/billing/#`. Publish **hanya** `smartmeter/+/claimed` (dipakai `devices.html` saat pairing) — publish topic lain harus tetap di-deny (`#`). Rule allow untuk `claimed` harus dievaluasi **sebelum** rule deny `#` (urutan rule penting di EMQX) |
   | `smartenergymeterbot` | Bot Telegram + `api/monitor.js` (`web-remote/api/*.js`) — server-side, tidak publik | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#`. Publish `smartmeter/+/cmd/limit`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#` |

   **Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.
3. Download sertifikat CA broker (biasanya tersedia di halaman koneksi EMQX Cloud) — dipakai nanti di `MQTT_CA_CERT`.

Lihat bagian "Topic MQTT" di bawah untuk daftar lengkap topic yang dipakai.

### 2. Menyiapkan Supabase (akun & database)

Dipakai untuk login web, daftar device, dan link akun Telegram.

1. Buka **https://supabase.com/dashboard** → login/daftar → **New Project** → isi nama, password database (simpan baik-baik, jarang dipakai langsung tapi penting), pilih region terdekat → **Create new project** (tunggu 1-2 menit).
2. **SQL Editor → New query** → copy-paste seluruh isi [`web-remote/supabase/schema.sql`](web-remote/supabase/schema.sql) → **Run**. Aman dijalankan berkali-kali (idempotent) kalau nanti file-nya di-update.
3. **Authentication → Providers** → pastikan **Email** aktif (biasanya default aktif).
4. **Authentication → URL Configuration**:
   - **Site URL**: `https://<domain-vercel-anda>` (isi setelah tahu domain Vercel-nya di langkah 3 — bisa balik ke sini untuk update)
   - **Redirect URLs**: tambahkan `https://<domain-vercel-anda>/**`
   - **Save**
5. **Project Settings (ikon gear) → API** → catat:
   - **Project URL** (`https://xxxxxxxxxxxx.supabase.co`)
   - **Publishable key** / **anon public key** (`sb_publishable_...` atau format lama JWT) — ini **aman untuk di-commit**, dipakai di `web-remote/supabase-client.js`
   - **Secret key** / **service_role key** (`sb_secret_...`) — **JANGAN PERNAH** commit atau taruh di kode client-side, cuma untuk environment variable server-side di Vercel (langkah 3)

### 3. Menyiapkan dashboard cloud & bot Telegram (`web-remote/`, Vercel)

1. `cd web-remote && npm install`
2. Isi **Project URL** + **anon/publishable key** dari langkah 2 ke `web-remote/supabase-client.js` (dua konstanta di atas file itu).
3. Deploy ke Vercel: `vercel deploy --prod`
4. Set environment variable di Vercel (Dashboard Vercel → project → Settings → Environment Variables, **jangan** di-hardcode ke kode):
   - `MQTT_USERNAME`, `MQTT_PASSWORD` — kredensial `smartenergymeterweb` (dipakai script.js sisi client, jadi memang publik — makanya harus read-only)
   - `BOT_MQTT_USERNAME`, `BOT_MQTT_PASSWORD` — kredensial `smartenergymeterbot`
   - `TELEGRAM_BOT_TOKEN` — token dari [@BotFather](https://t.me/BotFather)
   - `SUPABASE_URL` — sama dengan yang dipakai di `supabase-client.js` (Project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` — **secret key** dari langkah 2 (`sb_secret_...`). **Beda** dari publishable/anon key — key ini bypass Row Level Security sepenuhnya, dipakai `api/telegram.js`/`api/monitor.js` untuk resolve "chat Telegram ini punya akun mana" dan tulis histori tagihan.
5. Daftarkan webhook bot: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/telegram"`
6. Daftarkan daftar command bot (untuk autocomplete `/` di Telegram) lewat `setMyCommands` — lihat daftar command di bagian "Command bot Telegram".
7. `GET /api/monitor` harus dipanggil secara berkala — endpoint ini bukan cuma untuk notifikasi (offline/overload), tapi juga **satu-satunya tempat** yang menghitung & menyimpan histori tagihan harian/mingguan, mengirim ringkasan Telegram (21:00 WIB harian, Minggu 21:00 WIB mingguan), dan mengecek pengingat bayar listrik custom (`/reminder`, jam 08:00 WIB). Kalau endpoint ini tidak pernah dipanggil, histori tagihan tidak akan pernah ter-update. **Akun Vercel Hobby/gratis membatasi cron bawaan cuma 1x/hari**, jadi gunakan layanan cron gratis pihak ketiga seperti [cron-job.org](https://cron-job.org) untuk memanggil endpoint ini tiap beberapa menit.
8. Balik ke Supabase (langkah 2.4) dan pastikan **Site URL**/**Redirect URLs** sudah pakai domain Vercel yang benar.

### 4. Menyiapkan & flash firmware (pertama kali, lewat USB)

1. Salin `include/config.example.h` menjadi `include/config.local.h`.
2. Isi `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CA_CERT` (dari langkah 1) — nilai-nilai ini **sama untuk semua unit** yang akan dibuat.
3. **`WIFI_SSID`/`WIFI_PASSWORD`**: biarkan **kosong** (default di template) supaya unit ini pakai portal setup WiFi bawaan (lihat "Setup WiFi tanpa kabel" di bawah) — direkomendasikan, terutama kalau berencana bikin lebih dari 1 unit. Isi manual di sini hanya kalau memang mau cara lama (WiFi ter-compile, tidak butuh portal).
4. Biarkan `DEVICE_ID` **tidak di-set** (baris-nya di-comment di template) — device generate id sendiri dari MAC address.
5. Isi `WEB_USERNAME`/`WEB_PASSWORD` untuk proteksi endpoint OTA dashboard lokal.
6. Build dan unggah firmware serta filesystem dengan PlatformIO:

   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```

`data/` adalah aset dashboard lokal yang dipasang ke LittleFS.

> **Catatan format `MQTT_CA_CERT`:** compiler ESP32 di proyek ini tidak mendukung raw string literal (`R"EOF(...)EOF"`) multi-baris di dalam macro `#define`. Sertifikat harus ditulis sebagai concatenated string literals dengan `\n` eksplisit dan backslash continuation di akhir tiap baris — lihat contoh di `config.example.h`.

### 5. Menyalakan & menambahkan device lewat web

Setelah firmware ter-upload dan device dinyalakan:

1. **Kalau `WIFI_SSID` dikosongkan** (langkah 4.3): device jadi Access Point sendiri bernama `SmartMeter-<deviceId>`. Connect HP/laptop ke situ (tanpa password), biasanya otomatis muncul halaman "Sign in to network" — kalau tidak, buka `http://192.168.4.1` manual. Pilih WiFi rumah dari daftar (atau isi manual), isi password, klik **Simpan & Sambungkan**. Device restart dan connect ke WiFi itu.
2. Device sekarang online dan menampilkan layar **"Pairing"** di OLED dengan kode (contoh: `a1b2c3`) — ini id device yang di-generate dari MAC address-nya.
3. Buka **`https://<domain-vercel>/login.html`**, masukkan email, klik **Kirim link login**, buka email, klik link-nya (akan diarahkan ke `devices.html`).
4. Di `devices.html`, isi **nama** (bebas) dan **kode dari OLED** tadi persis, klik **Tambah**.
5. OLED otomatis kembali ke halaman metrik normal — device sudah resmi terdaftar ke akun Anda.
6. (Opsional) Klik **Hubungkan Telegram** untuk dapat kode (berlaku 15 menit), kirim `/link <kode>` ke bot — lihat "Command bot Telegram".

#### Menambahkan device lain

Untuk unit ke-2 dan seterusnya: flash `firmware.bin` yang **sama persis** (tidak perlu ubah apa pun di `config.local.h` — `WIFI_SSID` tetap kosong, `DEVICE_ID` tetap tidak di-set) → ulangi langkah 5 di atas. Tidak ada langkah reflash atau edit config per unit — satu-satunya hal yang beda antar unit adalah kode pairing yang muncul di OLED masing-masing (karena MAC address tiap chip beda).

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

## Setup WiFi tanpa kabel (captive portal)

Kalau device boot dan tidak punya kredensial WiFi sama sekali (bukan yang tersimpan dari portal sebelumnya, bukan juga `WIFI_SSID` yang di-compile), dia otomatis jadi Access Point sendiri bernama `SmartMeter-<deviceId>`:

1. OLED menampilkan nama AP itu dan alamat `192.168.4.1`.
2. Connect HP/laptop ke WiFi `SmartMeter-<deviceId>` itu (tanpa password) — biasanya langsung muncul notifikasi "Sign in to network" otomatis membuka halaman setup-nya; kalau tidak, buka `http://192.168.4.1` manual.
3. Pilih WiFi rumah dari daftar (atau isi manual kalau SSID-nya hidden), isi password, klik **Simpan & Sambungkan**.
4. Device simpan kredensial itu ke NVS (bukan ke file, jadi tidak butuh reflash) dan restart, lanjut connect ke WiFi itu seperti biasa, lalu lanjut ke layar Pairing.

Ini **backward compatible** — device yang firmware-nya masih punya `WIFI_SSID` terisi di `config.local.h` (cara lama) tetap jalan seperti biasa, tidak akan pernah masuk mode Access Point ini. Mode ini hanya aktif kalau *benar-benar* tidak ada kredensial dari sumber mana pun (lihat catatan keamanan soal AP terbuka tanpa password di bagian "Catatan keamanan").

## Pairing device dari OLED

Device yang belum pernah dipasangkan ke akun mana pun (unit baru yang belum pernah boot sama sekali, atau device manapun setelah factory reset) menampilkan layar "Pairing":

1. OLED menampilkan layar "Pairing" dengan kode (id device-nya, misal `a1b2c3`), menggantikan halaman metrik biasa, sampai proses pairing selesai.
2. Di `devices.html`, isi nama + kode itu, klik **Tambah**.
3. Browser publish pesan retained ke `smartmeter/<kode>/claimed` (pakai kredensial baca publik yang sama dengan dashboard, dengan satu pengecualian ACL khusus topic ini — lihat tabel ACL di bagian "Menyiapkan broker MQTT").
4. Device yang sedang subscribe ke topic itu menerima pesannya, menandai dirinya "sudah dipasangkan" (tersimpan di NVS, tahan reboot — lihat `isPaired()`/`markPaired()` di `storage.cpp`), dan OLED kembali ke halaman metrik normal.

`resetConfig()` (factory reset, lewat dashboard lokal atau `smartmeter/<id>/cmd/reset`) menghapus status "sudah dipasangkan" ini juga (sekalian kredensial WiFi tersimpan) — jadi factory reset mengembalikan device ke kondisi seperti baru: perlu setup WiFi lagi (kalau tadinya lewat portal) dan pairing lagi.

## Multi-device: akun web & Telegram

- **Akun & daftar device** (`web-remote/login.html`, `devices.html`) — login pakai magic link email (Supabase Auth), tiap user bisa punya beberapa device, datanya (device, billing, dst) disimpan di Postgres (Supabase) dengan Row Level Security supaya hanya kelihatan oleh pemiliknya. Skemanya di `web-remote/supabase/schema.sql`.
- **Topic MQTT per-device** — lihat bagian "Topic MQTT" di bawah; tiap device generate id sendiri dari MAC address (atau `DEVICE_ID` override di `config.local.h`).
- **Bot Telegram terikat ke akun** — chat Telegram tidak otomatis "mengklaim" notifikasi siapa cepat dia dapat; harus dihubungkan lewat kode dari `devices.html` (tabel `telegram_link_codes`, berlaku 15 menit) + command `/link <kode>` di bot, tersimpan permanen di `telegram_links`. Satu akun bisa punya banyak device; bot pilih device pertama secara default, atau bisa disebutkan id-nya di akhir perintah. `api/monitor.js` (cron notifikasi/billing) sudah loop tiap device di database dan kirim ke semua chat yang terhubung ke pemiliknya masing-masing.

**Batasan saat ini:** dashboard cloud (`index.html`/`script.js`, `bill.html`/`bill.js`) masih hardcode ke satu `DEVICE_ID` (`meter-01`) — cuma **bot Telegram dan cron** (`api/telegram.js`, `api/monitor.js`) yang sudah dinamis per-akun/per-device. Kalau punya lebih dari 1 device, dashboard visual (bukan bot) untuk sekarang akan selalu menampilkan device pertama itu saja — dukungan pilih-device di dashboard visual menyusul.

## Topic MQTT

Sebagian besar topic dinamai `smartmeter/<deviceId>/...` (bukan flat `smartmeter/...`) supaya beberapa device fisik tidak bentrok di broker yang sama. `<deviceId>` default-nya diambil dari 3 byte terakhir MAC address chip ESP32, atau bisa di-override lewat `DEVICE_ID` di `config.local.h` (dipakai supaya cocok dengan id yang sudah dibuat manual di web dashboard — jarang perlu, lihat catatan di "Menyiapkan & flash firmware").

Chat ID Telegram **tidak** dinamai per-device — mau notifikasi ke chat mana itu urusan per-user (tabel `telegram_links`, terikat ke `user_id`), bukan per-device.

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/<deviceId>/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, deviceId, dll), **retained** |
| `smartmeter/<deviceId>/status` | broker → subscriber | `"online"` / `"offline"` — di-set via MQTT Last Will, jadi otomatis `"offline"` kalau ESP32 putus koneksi tanpa sempat pamit |
| `smartmeter/<deviceId>/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/<deviceId>/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/<deviceId>/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/<deviceId>/claimed` | `devices.html` → ESP32 | Publish apa saja (retained) untuk menandai device sudah dipasangkan ke akun — lihat "Pairing device dari OLED" |
| `smartmeter/<deviceId>/telegram/alert_state` | bot → tersimpan di broker | State notifikasi (sudah/belum alert offline/overload) untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/summary_state` | `api/monitor.js` → tersimpan di broker | Tanggal terakhir ringkasan harian/mingguan device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/telegram/reminder` | bot (`/reminder`) → tersimpan di broker | JSON `{ "day": 25, "message": "..." }` pengingat bayar listrik custom untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/reminder_state` | `api/monitor.js` → tersimpan di broker | Bulan terakhir pengingat custom device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/billing/daily` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM-DD": rupiah }`, histori harian device ini, retained |
| `smartmeter/<deviceId>/billing/weekly` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM": { "week1": rupiah, ... } }`, retained |
| `smartmeter/<deviceId>/billing/daily_start`, `.../billing/weekly_start` | `api/monitor.js` internal | Nilai energi (kWh) di awal tiap hari/minggu device ini, dipakai hitung delta pemakaian, retained |

## Command bot Telegram

Sebelum bisa pakai command lain, chat harus **terhubung ke akun** dulu: buka `devices.html`, klik **Hubungkan Telegram** untuk dapat kode (berlaku 15 menit), kirim `/link <kode>` ke bot. Command lain otomatis pakai device pertama di akun itu; kalau akun punya lebih dari 1 device, tambahkan id-nya di akhir perintah (misal `/watt meter-01`) — lihat `/devices` untuk daftar id.

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/limit` `/status` — cek data. `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/riwayat` — grafik & rincian biaya 7 hari terakhir (render via [QuickChart](https://quickchart.io), dikirim sebagai foto). `/reminder <tanggal 1-28> <pesan>` — set pengingat bayar listrik tiap bulan jam 08:00 WIB; `/reminder` tanpa argumen menampilkan pengingat aktif, `/reminder off` mematikannya. `/devices` — daftar device yang terhubung ke akun. `/link <kode>` — hubungkan chat ini ke akun web. `/help` — bantuan.

## Catatan keamanan

- Kredensial WiFi/MQTT firmware **hanya** di `include/config.local.h`, tidak pernah di-commit (lihat `.gitignore`). Kredensial WiFi bisa juga tersimpan di NVS device (lewat captive portal) — sama-sama tidak pernah lewat repo/kode.
- Kredensial MQTT di dashboard cloud (`smartenergymeterweb`) **sengaja read-only** (kecuali topic `claimed`, lihat tabel ACL) karena kodenya publik dan terlihat siapa saja lewat "View Source" — jangan pernah pakai kredensial full-access di sana.
- Kredensial bot (`smartenergymeterbot`, `TELEGRAM_BOT_TOKEN`) dan `SUPABASE_SERVICE_ROLE_KEY` hanya hidup sebagai environment variable server-side di Vercel, tidak pernah masuk ke kode yang di-deploy ke browser. `SUPABASE_SERVICE_ROLE_KEY` bypass Row Level Security sepenuhnya — beda dengan publishable/anon key di `supabase-client.js` yang memang didesain publik.
- Dashboard lokal (`data/`) saat ini **belum** punya autentikasi HTTP aktif di sebagian besar endpoint (`/restart`, `/factoryReset`, `/setLimit`) meski field `WEB_USERNAME`/`WEB_PASSWORD` sudah ada di config — siapa pun di jaringan WiFi yang sama bisa akses. Pengecualiannya `/update` (OTA firmware): endpoint ini **menegakkan** HTTP Basic Auth begitu `WEB_USERNAME`/`WEB_PASSWORD` diisi, karena flash firmware sembarangan jauh lebih berbahaya daripada restart/reset.
- AP setup WiFi (`SmartMeter-<deviceId>`) **sengaja tanpa password**, sama seperti kebanyakan perangkat IoT konsumer (Sonoff, Tuya, dst) — password WiFi rumah yang diisi lewat portal-nya juga terkirim lewat HTTP biasa (bukan HTTPS) ke `192.168.4.1`, bukan lewat internet. AP ini cuma aktif sebentar (sampai kredensial tersimpan lalu device restart), dan jangkauannya terbatas sinyal WiFi lokal.

## Struktur

- `src/`, `include/` — firmware ESP32 (PlatformIO).
  - `wifiManager.cpp` — koneksi WiFi STA, resolusi kredensial (NVS vs compiled), generate device id dari MAC.
  - `wifiProvision.cpp` — captive portal Access Point untuk setup WiFi.
  - `mqtt.cpp` — publish telemetri, subscribe command/pairing/claim.
  - `webServer.cpp` — dashboard lokal (HTTP/WebSocket) + endpoint OTA.
  - `oled.cpp` — semua layar OLED (metrik normal, OTA, pairing, provisioning WiFi).
  - `storage.cpp` — Preferences/NVS: batas daya, status OTA-pending-verify, status paired, kredensial WiFi tersimpan.
- `data/` — dashboard lokal, di-flash ke LittleFS (`pio run -t uploadfs`). Diakses lewat IP lokal ESP32.
- `web-remote/` — dashboard cloud + bot Telegram + akun, di-deploy terpisah ke Vercel. Berisi:
  - `login.html`, `devices.html` — login (magic link) & daftar/tambah/pairing device.
  - `index.html`, `script.js`, `style.css`, `bill.html` — dashboard & halaman tagihan (MQTT over WebSocket).
  - `supabase-client.js` — koneksi client-side ke Supabase (anon/publishable key).
  - `supabase/schema.sql` — skema database (devices, telegram_links, telegram_link_codes, billing).
  - `api/telegram.js` — webhook bot Telegram.
  - `api/monitor.js` — endpoint pengecekan berkala untuk notifikasi otomatis & histori tagihan.
