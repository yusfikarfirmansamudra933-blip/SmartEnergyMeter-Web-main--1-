#!/usr/bin/env node
"use strict";

// Prepares one assembled unit over USB in a single run: reads the chip's ID,
// flashes the firmware and the local dashboard files, records the unit, and
// rebuilds the label sheet. Run on your own computer, from web-remote, with
// the ESP32 plugged in:
//
//   node scripts/new-unit.js [--port COM9] [--bot <bot_username>] [--all]
//
// Labels go to labels.local.html for every unit prepared today (one sheet per
// session at the bench), or every unit ever with --all. units.local.json keeps
// the list. Also the way to move an existing unit to partitions.csv: flash it
// once with this.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WEB = path.join(__dirname, "..");
const ROOT = path.join(WEB, "..");
const UNITS_FILE = path.join(WEB, "units.local.json");
const LOCAL_CONFIG = path.join(ROOT, "include", "config.local.h");
const CONFIG = path.join(ROOT, "include", "config.h");

const PIO_HOME = process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), ".platformio");
const BIN = process.platform === "win32" ? path.join(PIO_HOME, "penv", "Scripts") : path.join(PIO_HOME, "penv", "bin");
const PIO = path.join(BIN, process.platform === "win32" ? "pio.exe" : "pio");
const PYTHON = path.join(BIN, process.platform === "win32" ? "python.exe" : "python");
const ESPTOOL = path.join(PIO_HOME, "packages", "tool-esptoolpy", "esptool.py");

function fail(message) {
  console.error(`\nGAGAL: ${message}`);
  process.exit(1);
}

function step(text) {
  console.log(`\n== ${text}`);
}

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const port = option("--port");
const bot = option("--bot");
const all = args.includes("--all");

// --- Before touching the chip: everything a sellable unit needs. ---
if (!fs.existsSync(PIO)) fail(`PlatformIO tidak ditemukan di ${PIO}.`);
if (!fs.existsSync(ESPTOOL)) fail(`esptool tidak ditemukan di ${ESPTOOL}. Jalankan "pio run -t upload" sekali supaya terpasang.`);
if (!fs.existsSync(LOCAL_CONFIG)) fail("include/config.local.h belum ada. Salin dari config.example.h dan isi kredensialnya.");
if (!/^\s*#define\s+OTA_KEY\s+"[0-9a-f]{64}"/m.test(fs.readFileSync(LOCAL_CONFIG, "utf8"))) {
  fail("OTA_KEY belum ada di config.local.h, jadi unit ini tidak akan bisa update dari cloud. Jalankan dulu: node scripts/release-firmware.js --new-key");
}
if (!process.env.CONTROL_SECRET && !fs.existsSync(path.join(WEB, "control-secret.local.txt"))) {
  fail("CONTROL_SECRET belum ada, jadi label tidak bisa memuat PIN. Jalankan dulu: node scripts/device-label.js --new-secret");
}
const version = (fs.readFileSync(CONFIG, "utf8").match(/#define\s+FIRMWARE_VERSION\s+"([\d.]+)"/) || [])[1] || "?";

// --- 1. ID from the factory MAC, the same bytes the firmware uses. ---
step("Membaca ID chip");
const mac = spawnSync(PYTHON, [ESPTOOL, ...(port ? ["--port", port] : []), "read_mac"], { encoding: "utf8" });
const macMatch = `${mac.stdout}${mac.stderr}`.match(/MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
if (!macMatch) fail(`ESP32 tidak terbaca. Periksa kabel USB${port ? ` dan port ${port}` : ""}, lalu coba lagi.\n${(mac.stderr || mac.stdout || "").trim().split("\n").slice(-3).join("\n")}`);
const macText = macMatch[1].toLowerCase();
const id = `sem-${macText.split(":").slice(3).join("")}`;
console.log(`MAC ${macText}  ->  ID ${id}`);

// --- 2. Firmware (builds first if needed), then the local dashboard files. ---
const portArgs = port ? ["--upload-port", port] : [];
for (const [label, target] of [[`Flash firmware ${version}`, "upload"], ["Flash file dashboard lokal (data/)", "uploadfs"]]) {
  step(label);
  const run = spawnSync(PIO, ["run", "-d", ROOT, "-t", target, ...portArgs], { stdio: "inherit" });
  if (run.status !== 0) fail(`${label} tidak berhasil. Lihat pesan di atas; unit belum siap.`);
}

// --- 3. Record and labels. ---
step("Mencatat unit dan membuat label");
let units = [];
try { units = JSON.parse(fs.readFileSync(UNITS_FILE, "utf8")); } catch { /* first unit */ }
const now = new Date();
units = units.filter((u) => u.id !== id);
units.push({ id, mac: macText, firmware: version, preparedAt: now.toISOString() });
fs.writeFileSync(UNITS_FILE, `${JSON.stringify(units, null, 2)}\n`);

const today = now.toLocaleDateString("sv-SE");
const batch = all ? units : units.filter((u) => new Date(u.preparedAt).toLocaleDateString("sv-SE") === today);
const label = spawnSync(process.execPath, [path.join(__dirname, "device-label.js"), ...(bot ? ["--bot", bot] : []), ...batch.map((u) => u.id)], { stdio: "inherit" });
if (label.status !== 0) fail("Label tidak berhasil dibuat. Firmware sudah terpasang; jalankan ulang script ini atau device-label.js.");

console.log(`\nSelesai: ${id} siap (firmware ${version}).`);
console.log(`Label ${batch.length} unit (${all ? "semua" : "hari ini"}): web-remote/labels.local.html`);
console.log("Berikutnya: nyalakan unit, atur WiFi-nya, lalu tempel label. Unit muncul di halaman admin begitu online.");
