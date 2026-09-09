# Smart Energy Meter

Alat pemantau pemakaian listrik berbasis ESP32 dan sensor PZEM-004T. Bisa dilihat lewat layar kecil di alatnya, dashboard di HP/laptop (dari WiFi rumah atau dari mana saja), dan bot Telegram.

Tidak perlu langsung setup semuanya. Panduan di bawah dibagi jadi **3 level** — berhenti di level mana pun sesuai kebutuhan Anda, atau lanjut ke level berikutnya kapan saja nanti.

## Pilih level setup

| Level | Yang perlu disiapkan | Yang didapat |
|---|---|---|
| **1. Coba-coba** (wajib buat semua orang) | Laptop + kabel USB | Alat menyala, bisa dilihat & dikontrol dari HP/laptop di WiFi yang sama, bisa update firmware nanti tanpa kabel lagi. Layar kecil di alat akan terus menampilkan tulisan "Pairing" — itu normal, cuma belum "didaftarkan". |
| **2. Standar** | + akun gratis broker MQTT (EMQX Cloud) | Sama seperti Level 1, plus tulisan "Pairing" di layar bisa dihilangkan. |
| **3. Lengkap** | + akun gratis Vercel + akun gratis Supabase | Semua fitur: bisa dipantau dari HP di luar rumah/kantor, ada bot Telegram (tanya data, dapat notifikasi), riwayat tagihan listrik tersimpan otomatis, bisa punya banyak alat sekaligus dalam satu akun. |

Kalau Anda baru pertama kali coba, **mulai dari Level 1 dulu** — cuma butuh laptop dan kabel USB, tidak perlu daftar layanan apa pun.

---

## Level 1: Nyalakan alatnya

Ini langkah dasar yang harus dilakukan siapa pun, apa pun level yang dituju nanti.

**Yang dibutuhkan:**
- Laptop dengan [PlatformIO](https://platformio.org/) terpasang (extension gratis untuk VS Code — dipakai untuk "mengisi" program ke dalam alat).
- Kabel data USB.

**Langkah-langkah:**

1. Download/copy folder project ini ke laptop Anda, buka pakai VS Code.
2. Di dalam folder `include/`, ada file bernama `config.example.h`. **Copy file itu**, lalu **beri nama hasil copy-annya** `config.local.h` (taruh di folder yang sama, `include/`). File baru ini nanti isinya pengaturan khusus milik Anda sendiri — tidak akan pernah ikut ter-upload ke internet.
3. Buka `config.local.h` yang baru dibuat itu. Untuk sekarang **biarkan saja isinya seperti bawaan** (semua kosong) — nanti baru diisi kalau lanjut ke Level 2 atau 3.
4. Colok alatnya (ESP32) ke laptop pakai kabel USB.
5. Di VS Code, buka Terminal, lalu jalankan dua perintah ini satu per satu:
   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```
   Perintah pertama mengisi program utamanya, perintah kedua mengisi tampilan dashboard-nya. Tunggu sampai masing-masing selesai (muncul tulisan `SUCCESS` berwarna hijau).
6. Alat akan otomatis menyala. Karena belum diisi WiFi apa pun, alat akan **membuat jaringan WiFi sendiri**, namanya `SmartMeter-xxxxxx` (kode di belakang beda-beda tiap alat).
7. Di HP, buka pengaturan WiFi, **sambungkan ke WiFi itu** (tidak perlu password).
8. Biasanya HP otomatis menampilkan halaman "Sign in to network" — kalau tidak muncul sendiri, buka browser dan ketik alamat `192.168.4.1`.
9. Di halaman itu, **pilih WiFi rumah Anda** dari daftar (atau ketik manual kalau tidak muncul), isi passwordnya, lalu klik **Simpan & Sambungkan**.
10. Alat akan restart dan tersambung ke WiFi rumah Anda.

**Selesai — alat sudah menyala dan online di WiFi Anda.**

Untuk membuka dashboard-nya: cari tahu alamat IP alat ini (paling gampang, buka aplikasi router Anda dan cari perangkat baru bernama mirip "esp32"; atau lihat di layar Terminal VS Code saat alat baru nyala, biasanya tertulis "dashboard IP: 192.168.x.x"). Buka alamat itu (contoh: `http://192.168.1.50`) di browser HP/laptop yang **tersambung ke WiFi yang sama**. Dari situ Anda bisa lihat data listrik secara langsung, restart alat, dan (ke depannya) update firmware **tanpa kabel USB lagi**.

> Layar kecil (OLED) di alat akan terus menampilkan tulisan **"Pairing"** disertai sebuah kode — ini **normal, bukan error**. Alat sedang menunggu "didaftarkan". Dashboard di HP/laptop tetap berfungsi normal walau tulisan ini masih muncul. Lanjut ke Level 2 atau 3 kalau mau menghilangkan tulisan ini.

---

## Level 2: Broker MQTT (opsional)

Broker MQTT itu semacam "kantor pos" — alat mengirim data ke sana, dan nanti dashboard/aplikasi lain bisa "berlangganan" buat menerima data itu. Di level ini kita pakai **EMQX Cloud**, gratis untuk skala kecil.

1. Buka **https://www.emqx.com/en/cloud**, buat akun gratis, buat 1 deployment baru (pilih paket **Serverless**, gratis).
2. Setelah deployment jadi, catat **alamat host** dan **port**-nya (biasanya port `8883` untuk koneksi dari alat, `8084` untuk koneksi dari browser/website).
3. Di menu **Authentication**, buat **3 akun login** (bukan akun manusia — ini akun buat alat/aplikasi login ke broker), dengan hak akses berbeda:

   | Akun untuk | Boleh ngapain |
   |---|---|
   | Alat ESP32 Anda (nanti diisi ke `config.local.h`) | Bebas (kirim & terima semua data) |
   | Dashboard di browser (`smartenergymeterweb`) | Cuma boleh **menerima** data, tidak boleh kirim (kecuali satu hal kecil buat pairing) |
   | Bot Telegram (`smartenergymeterbot`) | Boleh kirim & terima data terbatas |

   Detail teknis hak akses masing-masing ada di bagian "Referensi teknis → Broker MQTT" di bawah — kalau baru coba-coba, sementara ikuti tabel itu saja, nanti bisa disesuaikan.
4. Download **sertifikat CA** broker-nya (biasanya ada tombol download di halaman koneksi EMQX Cloud) — nanti perlu di-copy ke `config.local.h`.
5. Buka `config.local.h`, isi bagian MQTT-nya: `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` (pakai akun untuk "Alat ESP32" di atas), dan `MQTT_CA_CERT` (isi sertifikat yang di-download tadi — lihat catatan format khusus di file `config.example.h`).
6. Upload ulang firmware-nya (ulangi langkah 5 di Level 1: `pio run -t upload`).

Setelah ini, alat akan mulai mengirim datanya ke broker. Tulisan "Pairing" di layar OLED masih akan muncul sampai Anda lanjut ke Level 3 (atau hapus manual pakai aplikasi MQTT client apa saja — kirim pesan apa saja ke topic `smartmeter/<kode-di-layar>/claimed`).

---

## Level 3: Dashboard cloud, bot Telegram, banyak alat (opsional, paling lengkap)

Level ini menambahkan: website yang bisa diakses dari mana saja, bot Telegram, riwayat tagihan tersimpan otomatis, dan kemampuan mendaftarkan banyak alat sekaligus ke satu akun.

### 3a. Buat akun & database (Supabase)

Dipakai untuk login website dan menyimpan daftar alat Anda.

1. Buka **https://supabase.com/dashboard**, login/daftar, klik **New Project**. Isi nama bebas, buat password database (simpan baik-baik), pilih lokasi server terdekat, klik **Create new project**. Tunggu 1-2 menit.
2. Di menu **SQL Editor**, klik **New query**. Buka file [`web-remote/supabase/schema.sql`](web-remote/supabase/schema.sql) dari project ini, **copy semua isinya**, paste ke situ, klik **Run**. Ini yang membuat "tabel-tabel" penyimpanan data di database Anda.
3. Di menu **Authentication → Providers**, pastikan **Email** aktif (biasanya sudah aktif dari awal).
4. Di menu **Project Settings → API**, catat 3 hal:
   - **Project URL**
   - **Publishable key** (atau **anon public key**) — aman dibagikan, nanti dipakai di kode website.
   - **Secret key** (atau **service_role key**) — **JANGAN PERNAH** dibagikan ke siapa pun atau ditaruh di kode yang publik. Cuma dipakai di langkah 3b nanti.

### 3b. Deploy website (Vercel)

1. Buka folder `web-remote/` di terminal, jalankan `npm install`.
2. Buka file `web-remote/supabase-client.js`, isi **Project URL** dan **Publishable key** dari langkah sebelumnya.
3. Jalankan `vercel deploy --prod` (perlu install [Vercel CLI](https://vercel.com/docs/cli) dan login dulu kalau belum pernah).
4. Buka **https://vercel.com/dashboard**, cari project-nya, buka **Settings → Environment Variables**, tambahkan:
   - `MQTT_USERNAME`, `MQTT_PASSWORD` — akun "Dashboard di browser" dari Level 2
   - `BOT_MQTT_USERNAME`, `BOT_MQTT_PASSWORD` — akun "Bot Telegram" dari Level 2
   - `TELEGRAM_BOT_TOKEN` — bikin bot baru lewat [@BotFather](https://t.me/BotFather) di Telegram, copy token yang diberikan
   - `SUPABASE_URL` — Project URL dari langkah 3a
   - `SUPABASE_SERVICE_ROLE_KEY` — **Secret key** dari langkah 3a (bukan yang publishable)
5. Balik ke Supabase, buka **Authentication → URL Configuration**, isi **Site URL** dengan alamat website Vercel Anda (contoh: `https://nama-project-anda.vercel.app`), dan tambahkan `https://nama-project-anda.vercel.app/**` di **Redirect URLs**. Klik **Save**.
6. Daftarkan bot Telegram ke website Anda — buka browser, akses alamat ini (ganti bagian yang bertanda `<...>`):
   ```
   https://api.telegram.org/bot<TOKEN_BOT_ANDA>/setWebhook?url=https://<alamat-vercel-anda>/api/telegram
   ```
7. Supaya riwayat tagihan & notifikasi otomatis bot jalan, endpoint `https://<alamat-vercel-anda>/api/monitor` harus "dipanggil" tiap beberapa menit. Daftar ke layanan gratis seperti **https://cron-job.org**, buat jadwal panggil alamat itu tiap 5-10 menit.

### 3c. Daftarkan alat Anda

1. Buka `https://<alamat-vercel-anda>/login.html`, masukkan email Anda, klik **Kirim link login**. Buka email Anda, klik link yang dikirim.
2. Anda akan diarahkan ke halaman **Device Saya**. Lihat kode yang tertulis di layar OLED alat Anda (tulisan "Pairing" + kode seperti `a1b2c3`).
3. Isi nama bebas (misal "Meter Rumah") dan kode dari OLED tadi, klik **Tambah**.
4. Layar OLED alat akan otomatis berhenti menampilkan tulisan "Pairing" dan pindah ke tampilan data normal — artinya alat sudah resmi terdaftar ke akun Anda.
5. (Opsional) Di halaman yang sama, klik **Hubungkan Telegram** untuk dapat kode, lalu kirim kode itu (`/link <kode>`) ke bot Telegram Anda di Telegram. Setelah itu bisa tanya data lewat chat, contoh `/status` atau `/watt`.

**Punya alat kedua, ketiga, dst?** Ulangi Level 1 (flash firmware yang **sama persis**, tidak perlu diedit lagi) di alat barunya, lalu ulangi langkah 3c di atas untuk alat itu. Tidak ada langkah reflash atau edit config per alat — satu-satunya yang beda tiap alat adalah kode pairing-nya (otomatis unik per alat).

---

## Update firmware tanpa kabel USB (OTA)

Setelah Level 1 selesai (alat sudah online di WiFi), update firmware berikutnya bisa lewat dashboard, tidak perlu kabel USB lagi:

1. Ubah kode sesuai kebutuhan, lalu jalankan `pio run` (hasilnya ada di `.pio/build/esp32dev/firmware.bin`).
2. Buka file `include/config.h`, naikkan angka di baris `FIRMWARE_VERSION` (misal dari `"1.6.1"` jadi `"1.6.2"`) — ini cuma penanda supaya dashboard bisa konfirmasi update-nya berhasil.
3. Buka dashboard lokal alat (`http://<ip-alat>/`), scroll ke bagian **Perbarui firmware**, pilih file `firmware.bin` tadi, klik **Unggah & pasang**.
4. Alat akan menulis firmware baru, lalu restart sendiri. Layar OLED menampilkan progres upload, lalu status akhirnya ("Berhasil! Merestart..." atau "Update gagal, coba lagi ya").

Kalau `WEB_USERNAME`/`WEB_PASSWORD` sudah diisi di `config.local.h`, sistem akan minta login sebelum menerima file — supaya tidak sembarang orang di WiFi yang sama bisa upload firmware asal-asalan. Kalau upload gagal di tengah jalan, firmware lama yang sedang berjalan **tidak akan rusak** — alat tetap boot normal seperti sebelumnya.

**Jaring pengaman otomatis:** kalau firmware baru ternyata ada bug dan gagal connect WiFi, alat akan otomatis "membatalkan" update itu sendiri dan kembali ke firmware yang lama — tanpa perlu USB atau tindakan apa pun dari Anda. Alat mencoba connect selama 20 detik setelah update; kalau gagal, otomatis rollback.

---

## Referensi teknis

Bagian di bawah ini untuk yang mau paham cara kerja di baliknya, atau butuh detail spesifik (misal saat troubleshooting). Tidak wajib dibaca untuk sekadar memakai alatnya.

### Arsitektur

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

### Broker MQTT — detail hak akses (ACL)

| User | Dipakai oleh | Hak akses |
|---|---|---|
| (kredensial firmware, di `config.local.h`) | ESP32 | Full — publish semua topic, subscribe `cmd/*` |
| `smartenergymeterweb` | Dashboard cloud (`web-remote/script.js`, `bill.html`, `devices.html`) — kode ini publik/terlihat siapa saja | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/billing/#`. Publish **hanya** `smartmeter/+/claimed` (dipakai `devices.html` saat pairing) — publish topic lain harus tetap di-deny (`#`). Rule allow untuk `claimed` harus dievaluasi **sebelum** rule deny `#` (urutan rule penting di EMQX) |
| `smartenergymeterbot` | Bot Telegram + `api/monitor.js` (`web-remote/api/*.js`) — server-side, tidak publik | Subscribe `smartmeter/+/data`, `smartmeter/+/status`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#`. Publish `smartmeter/+/cmd/limit`, `smartmeter/+/telegram/#`, `smartmeter/+/billing/#` |

**Penting:** begitu ada rule Authorization untuk sebuah username, EMQX Cloud tidak lagi otomatis "allow" untuk action yang tidak match rule apa pun (berbeda dari default global). Jadi setiap hak yang dibutuhkan harus dibuat sebagai rule eksplisit, termasuk Subscribe.

> **Catatan format `MQTT_CA_CERT`:** compiler ESP32 di proyek ini tidak mendukung raw string literal (`R"EOF(...)EOF"`) multi-baris di dalam macro `#define`. Sertifikat harus ditulis sebagai concatenated string literals dengan `\n` eksplisit dan backslash continuation di akhir tiap baris — lihat contoh di `config.example.h`.

### Setup WiFi tanpa kabel (captive portal) — cara kerja

Kalau device boot dan tidak punya kredensial WiFi sama sekali (bukan yang tersimpan dari portal sebelumnya, bukan juga `WIFI_SSID` yang di-compile), dia otomatis jadi Access Point sendiri bernama `SmartMeter-<deviceId>`. OLED menampilkan nama AP itu dan alamat `192.168.4.1`. Setelah kredensial diisi lewat portal, device menyimpannya ke NVS (bukan ke file, jadi tidak butuh reflash) dan restart, lanjut connect ke WiFi itu seperti biasa.

Ini **backward compatible** — device yang firmware-nya masih punya `WIFI_SSID` terisi di `config.local.h` (cara Level 2/3 versi lama) tetap jalan seperti biasa, tidak akan pernah masuk mode Access Point ini.

### Pairing device dari OLED — cara kerja

1. Device yang belum pernah dipasangkan ke akun mana pun (unit baru, atau device manapun setelah factory reset) menampilkan layar "Pairing" dengan kode (id device-nya, misal `a1b2c3`), menggantikan halaman metrik biasa.
2. Di `devices.html`, user isi nama + kode itu, klik **Tambah**.
3. Browser publish pesan retained ke `smartmeter/<kode>/claimed` (pakai kredensial baca publik yang sama dengan dashboard, dengan satu pengecualian ACL khusus topic ini — lihat tabel ACL di atas).
4. Device yang sedang subscribe ke topic itu menerima pesannya, menandai dirinya "sudah dipasangkan" (tersimpan di NVS, tahan reboot — lihat `isPaired()`/`markPaired()` di `storage.cpp`), dan OLED kembali ke halaman metrik normal.

`resetConfig()` (factory reset, lewat dashboard lokal atau `smartmeter/<id>/cmd/reset`) menghapus status "sudah dipasangkan" ini juga (sekalian kredensial WiFi tersimpan) — jadi factory reset mengembalikan device ke kondisi seperti baru: perlu setup WiFi lagi (kalau tadinya lewat portal) dan pairing lagi.

### Auto-rollback — cara kerja

Firmware baru punya satu kesempatan untuk membuktikan dirinya bisa konek WiFi sebelum dipercaya:

1. Begitu upload OTA sukses, sebelum restart, perangkat menyimpan tanda "perlu verifikasi" ke NVS (`Preferences`, tahan reboot).
2. Begitu boot pertama setelah OTA itu, kalau tanda itu ada, firmware baru dikasih waktu 20 detik untuk konek WiFi (OLED menampilkan "Verifying WiFi...").
3. Kalau berhasil konek dalam 20 detik → tanda dihapus, firmware baru dipercaya, lanjut boot normal (MQTT, web server, dst).
4. Kalau gagal → otomatis `Update.rollBack()` ke firmware sebelumnya di partisi OTA yang lain, lalu restart. OLED menampilkan "Rollback! Restarting...".

Pengecekan ini cuma jalan sekali per OTA (bukan tiap boot), jadi tidak menambah waktu boot untuk restart/power-cycle biasa. Kalau tidak ada firmware valid di partisi satunya untuk di-rollback (misal baru sekali pernah di-flash), perangkat tetap lanjut boot dengan firmware yang ada.

### Multi-device: batasan saat ini

Dashboard cloud (`index.html`/`script.js`, `bill.html`/`bill.js`) masih hardcode ke satu `DEVICE_ID` (`meter-01`) — cuma **bot Telegram dan cron** (`api/telegram.js`, `api/monitor.js`) yang sudah dinamis per-akun/per-device. Kalau punya lebih dari 1 device, dashboard visual (bukan bot) untuk sekarang akan selalu menampilkan device pertama itu saja — dukungan pilih-device di dashboard visual menyusul.

### Topic MQTT

Sebagian besar topic dinamai `smartmeter/<deviceId>/...` (bukan flat `smartmeter/...`) supaya beberapa device fisik tidak bentrok di broker yang sama. `<deviceId>` default-nya diambil dari 3 byte terakhir MAC address chip ESP32, atau bisa di-override lewat `DEVICE_ID` di `config.local.h` (dipakai supaya cocok dengan id yang sudah dibuat manual di web dashboard — jarang perlu).

Chat ID Telegram **tidak** dinamai per-device — mau notifikasi ke chat mana itu urusan per-user (tabel `telegram_links`, terikat ke `user_id`), bukan per-device.

| Topic | Arah | Isi |
|---|---|---|
| `smartmeter/<deviceId>/data` | ESP32 → subscriber | JSON telemetri (voltage, current, power, energy, deviceId, dll), **retained** |
| `smartmeter/<deviceId>/status` | broker → subscriber | `"online"` / `"offline"` — di-set via MQTT Last Will, jadi otomatis `"offline"` kalau ESP32 putus koneksi tanpa sempat pamit |
| `smartmeter/<deviceId>/cmd/limit` | → ESP32 | Publish angka baru untuk ubah batas daya |
| `smartmeter/<deviceId>/cmd/restart` | → ESP32 | Publish apa saja untuk restart perangkat |
| `smartmeter/<deviceId>/cmd/reset` | → ESP32 | Publish apa saja untuk factory reset |
| `smartmeter/<deviceId>/claimed` | `devices.html` → ESP32 | Publish apa saja (retained) untuk menandai device sudah dipasangkan ke akun |
| `smartmeter/<deviceId>/telegram/alert_state` | bot → tersimpan di broker | State notifikasi (sudah/belum alert offline/overload) untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/summary_state` | `api/monitor.js` → tersimpan di broker | Tanggal terakhir ringkasan harian/mingguan device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/telegram/reminder` | bot (`/reminder`) → tersimpan di broker | JSON `{ "day": 25, "message": "..." }` pengingat bayar listrik custom untuk device ini, retained |
| `smartmeter/<deviceId>/telegram/reminder_state` | `api/monitor.js` → tersimpan di broker | Bulan terakhir pengingat custom device ini terkirim (dedup), retained |
| `smartmeter/<deviceId>/billing/daily` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM-DD": rupiah }`, histori harian device ini, retained |
| `smartmeter/<deviceId>/billing/weekly` | `api/monitor.js` → dashboard/bill.html | JSON `{ "YYYY-MM": { "week1": rupiah, ... } }`, retained |
| `smartmeter/<deviceId>/billing/daily_start`, `.../billing/weekly_start` | `api/monitor.js` internal | Nilai energi (kWh) di awal tiap hari/minggu device ini, dipakai hitung delta pemakaian, retained |

### Command bot Telegram

Sebelum bisa pakai command lain, chat harus **terhubung ke akun** dulu lewat `/link <kode>` (lihat Level 3c). Command lain otomatis pakai device pertama di akun itu; kalau akun punya lebih dari 1 device, tambahkan id-nya di akhir perintah (misal `/watt meter-01`) — lihat `/devices` untuk daftar id.

`/watt` `/kwh` `/volt` `/ampere` `/frekuensi` `/pf` `/limit` `/status` — cek data. `/setlimit <angka>` — ubah batas daya (100–10000 Watt). `/riwayat` — grafik & rincian biaya 7 hari terakhir (render via [QuickChart](https://quickchart.io), dikirim sebagai foto). `/reminder <tanggal 1-28> <pesan>` — set pengingat bayar listrik tiap bulan jam 08:00 WIB; `/reminder` tanpa argumen menampilkan pengingat aktif, `/reminder off` mematikannya. `/devices` — daftar device yang terhubung ke akun. `/link <kode>` — hubungkan chat ini ke akun web. `/help` — bantuan.

### Catatan keamanan

- Kredensial WiFi/MQTT firmware **hanya** di `include/config.local.h`, tidak pernah di-commit (lihat `.gitignore`). Kredensial WiFi bisa juga tersimpan di NVS device (lewat captive portal) — sama-sama tidak pernah lewat repo/kode.
- Kredensial MQTT di dashboard cloud (`smartenergymeterweb`) **sengaja read-only** (kecuali topic `claimed`, lihat tabel ACL) karena kodenya publik dan terlihat siapa saja lewat "View Source" — jangan pernah pakai kredensial full-access di sana.
- Kredensial bot (`smartenergymeterbot`, `TELEGRAM_BOT_TOKEN`) dan `SUPABASE_SERVICE_ROLE_KEY` hanya hidup sebagai environment variable server-side di Vercel, tidak pernah masuk ke kode yang di-deploy ke browser. `SUPABASE_SERVICE_ROLE_KEY` bypass Row Level Security sepenuhnya — beda dengan publishable/anon key di `supabase-client.js` yang memang didesain publik.
- Dashboard lokal (`data/`) saat ini **belum** punya autentikasi HTTP aktif di sebagian besar endpoint (`/restart`, `/factoryReset`, `/setLimit`) meski field `WEB_USERNAME`/`WEB_PASSWORD` sudah ada di config — siapa pun di jaringan WiFi yang sama bisa akses. Pengecualiannya `/update` (OTA firmware): endpoint ini **menegakkan** HTTP Basic Auth begitu `WEB_USERNAME`/`WEB_PASSWORD` diisi, karena flash firmware sembarangan jauh lebih berbahaya daripada restart/reset.
- AP setup WiFi (`SmartMeter-<deviceId>`) **sengaja tanpa password**, sama seperti kebanyakan perangkat IoT konsumer (Sonoff, Tuya, dst) — password WiFi rumah yang diisi lewat portal-nya juga terkirim lewat HTTP biasa (bukan HTTPS) ke `192.168.4.1`, bukan lewat internet. AP ini cuma aktif sebentar (sampai kredensial tersimpan lalu device restart), dan jangkauannya terbatas sinyal WiFi lokal.

### Struktur folder

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
