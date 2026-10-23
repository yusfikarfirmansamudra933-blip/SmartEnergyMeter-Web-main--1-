#!/usr/bin/env node
"use strict";

// Publishes a firmware build for the cloud update (src/cloudOta.cpp). Every
// unit checks firmware/latest.json on the dashboard's domain every 6 hours and
// installs a newer version. Run on your own computer, from web-remote:
//
//   node scripts/release-firmware.js --new-key
//       Only once. Creates ota-key.local.txt and adds the same key to
//       include/config.local.h as OTA_KEY. Build and flash (USB or the local
//       /update page) once after this: units without the key ignore cloud updates.
//
//   node scripts/release-firmware.js [--only sem-a1b2c3,sem-d4e5f6]
//       Encrypts .pio/build/esp32dev/firmware.bin into firmware/ and writes
//       firmware/latest.json. --only limits the release to those units (try it
//       on your own unit first). Then deploy: npx vercel deploy --prod
//
// Why encrypted: the build contains the WiFi and MQTT passwords from
// config.local.h, and firmware/ is served publicly. The signature (HMAC over
// the version and the file) is what makes a unit refuse any file not made here.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..");
const ROOT = path.join(WEB, "..");
const KEY_FILE = path.join(WEB, "ota-key.local.txt");
const LOCAL_CONFIG = path.join(ROOT, "include", "config.local.h");
const CONFIG = path.join(ROOT, "include", "config.h");
const BUILD = path.join(ROOT, ".pio", "build", "esp32dev", "firmware.bin");
const OUT_DIR = path.join(WEB, "firmware");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const KEY_RE = /^\s*#define\s+OTA_KEY\s+"([0-9a-f]*)"/m;

if (args.includes("--new-key")) {
  if (fs.existsSync(KEY_FILE)) fail(`${KEY_FILE} sudah ada. Kunci baru membuat semua alat menolak update berikutnya, jadi hapus manual kalau memang mau ganti.`);
  if (!fs.existsSync(LOCAL_CONFIG)) fail(`${LOCAL_CONFIG} belum ada. Salin dulu dari config.example.h.`);
  const config = fs.readFileSync(LOCAL_CONFIG, "utf8");
  if (KEY_RE.test(config)) fail("config.local.h sudah punya OTA_KEY. Hapus barisnya dulu kalau memang mau ganti kunci.");
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(KEY_FILE, key);
  fs.writeFileSync(LOCAL_CONFIG, `${config.replace(/\s*$/, "")}\n\n// Kunci update dari cloud, dibuat scripts/release-firmware.js --new-key.\n#define OTA_KEY "${key}"\n`);
  console.log(`Kunci dibuat: ${KEY_FILE}`);
  console.log("OTA_KEY ditambahkan ke include/config.local.h.");
  console.log("Build lalu upload firmware ini sekali lewat USB atau halaman /update di jaringan lokal.");
  process.exit(0);
}

function option(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const only = option("--only");
const devices = only ? only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
if (devices && !devices.every((id) => /^sem-[0-9a-f]{6}$/.test(id))) fail("--only: tulis ID seperti sem-a1b2c3, pisahkan dengan koma.");

if (!fs.existsSync(KEY_FILE)) fail("Kunci belum ada. Jalankan dulu: node scripts/release-firmware.js --new-key");
const key = fs.readFileSync(KEY_FILE, "utf8").trim();
const configured = (fs.existsSync(LOCAL_CONFIG) && fs.readFileSync(LOCAL_CONFIG, "utf8").match(KEY_RE)) || null;
if (!configured || configured[1] !== key) fail("OTA_KEY di config.local.h tidak sama dengan ota-key.local.txt. Firmware dengan kunci lain tidak bisa memasang rilis ini.");

const version = (fs.readFileSync(CONFIG, "utf8").match(/#define\s+FIRMWARE_VERSION\s+"([\d.]+)"/) || [])[1];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) fail("FIRMWARE_VERSION di include/config.h tidak terbaca.");
if (!fs.existsSync(BUILD)) fail(`Build belum ada: ${BUILD}. Jalankan pio run dulu.`);
const bin = fs.readFileSync(BUILD);
// Guards against releasing a stale build under a new version number.
if (!bin.includes(Buffer.from(`${version}\0`))) fail(`firmware.bin bukan versi ${version}. Jalankan pio run lagi setelah mengubah FIRMWARE_VERSION.`);

// App slot sizes: partitions.csv now, and the esp32dev default that units
// flashed before it still have (OTA cannot change the table).
const SLOT_NEW = 0x1c0000;
const SLOT_OLD = 0x140000;
if (bin.length > SLOT_NEW) fail(`firmware.bin (${bin.length} byte) lebih besar dari slot aplikasi (${SLOT_NEW} byte).`);
if (bin.length > SLOT_OLD) console.warn(`Perhatian: firmware ini ${(bin.length / 1048576).toFixed(2)} MB. Alat yang belum di-flash ulang lewat USB sejak partitions.csv (slot 1,25 MB) akan gagal memasangnya; lihat kolom Ruang di halaman admin.`);

const derive = (label) => crypto.createHmac("sha256", key).update(label).digest();
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv("aes-256-ctr", derive("sem-ota-enc"), iv);
const encrypted = Buffer.concat([cipher.update(bin), cipher.final()]);
const mac = crypto.createHmac("sha256", derive("sem-ota-mac"))
  .update(Buffer.from(`${version}\0`))
  .update(iv)
  .update(encrypted)
  .digest("hex");

fs.mkdirSync(OUT_DIR, { recursive: true });
// Only the current release is kept: older files would just be deployed for nothing.
for (const f of fs.readdirSync(OUT_DIR)) if (/^fw-.*\.bin$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
const file = `fw-${version}.bin`;
fs.writeFileSync(path.join(OUT_DIR, file), encrypted);

const manifest = { version, file, size: encrypted.length, iv: iv.toString("hex"), mac, released: new Date().toISOString() };
if (devices) manifest.devices = devices;
fs.writeFileSync(path.join(OUT_DIR, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Rilis ${version} (${(encrypted.length / 1024).toFixed(0)} KB) ditulis ke firmware/${file}`);
console.log(devices ? `Hanya untuk: ${devices.join(", ")}` : "Untuk semua alat.");
console.log("Langkah berikutnya: npx vercel deploy --prod");
