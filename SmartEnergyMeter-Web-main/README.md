# Smart Energy Meter Web

Firmware ESP32 untuk membaca PZEM-004T, menampilkan data pada OLED dan dashboard web, serta mempublikasikan telemetri MQTT.

## Menyiapkan proyek

1. Salin `include/config.example.h` menjadi `include/config.local.h`.
2. Isi kredensial Wi-Fi dan MQTT milik Anda sendiri. File lokal ini diabaikan Git.
3. Isi sertifikat CA broker pada `MQTT_CA_CERT`. Jangan gunakan `MQTT_TLS_INSECURE` di perangkat produksi.
4. Build dan unggah firmware serta filesystem dengan PlatformIO:

   ```sh
   pio run -t upload
   pio run -t uploadfs
   ```

`data/` adalah aset dashboard yang dipasang ke LittleFS. Dashboard utama mengambil data dari WebSocket perangkat (`/ws`) dan API lokal, sehingga kredensial broker tidak perlu berada di browser.

## Catatan keamanan

Kredensial sebelumnya pernah tersimpan dalam riwayat repository. Rotasi segera kata sandi Wi-Fi dan MQTT tersebut, lalu gunakan kredensial baru hanya melalui `config.local.h`.

## Struktur

- `src/` — firmware ESP32.
- `include/` — header dan contoh konfigurasi.
- `data/` — dashboard statis untuk LittleFS.
