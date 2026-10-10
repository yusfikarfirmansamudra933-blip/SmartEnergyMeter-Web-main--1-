#!/usr/bin/env node
"use strict";

// Prints labels for meters: ID, PIN, a QR code to the cloud dashboard and one
// that links Telegram to the unit. Run on your own computer, never on Vercel:
//
//   node scripts/device-label.js --new-secret
//       Creates control-secret.local.txt (only once). Put the same value in
//       Vercel as CONTROL_SECRET, otherwise the PINs on the labels won't match.
//
//   node scripts/device-label.js --bot <bot_username> sem-a1b2c3 sem-d4e5f6
//       Writes labels.local.html next to this folder. Open it and print.
//
// The secret comes from CONTROL_SECRET or control-secret.local.txt. Both
// output files are .gitignore'd and .vercelignore'd: whoever has them can
// control every unit.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SECRET_FILE = path.join(ROOT, "control-secret.local.txt");
const OUT_FILE = path.join(ROOT, "labels.local.html");
const DEFAULT_URL = "https://web-remote-nine.vercel.app";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);

if (args.includes("--new-secret")) {
  if (fs.existsSync(SECRET_FILE)) fail(`${SECRET_FILE} sudah ada. Hapus manual kalau memang mau ganti (semua PIN lama jadi tidak berlaku).`);
  fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"));
  console.log(`Secret dibuat: ${SECRET_FILE}`);
  console.log("Masukkan isinya ke Vercel sebagai CONTROL_SECRET, lalu deploy ulang.");
  process.exit(0);
}

function option(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const bot = option("--bot");
const baseUrl = (option("--url") || DEFAULT_URL).replace(/\/$/, "");

if (!process.env.CONTROL_SECRET) {
  if (!fs.existsSync(SECRET_FILE)) fail("CONTROL_SECRET belum ada. Jalankan dulu: node scripts/device-label.js --new-secret");
  process.env.CONTROL_SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
}
// Loaded after the secret is in place: devicePin() reads it from the environment.
const { normalizeDeviceId, devicePin } = require("../lib/devices");

const ids = args.map((a) => {
  const id = normalizeDeviceId(a);
  if (!id) fail(`ID tidak valid: ${a} (format: sem-a1b2c3)`);
  return id;
});
if (!ids.length) fail("Tulis minimal satu ID perangkat, contoh: node scripts/device-label.js --bot nama_bot sem-a1b2c3");
if (!bot) console.warn("Tanpa --bot <username>, label tidak memuat QR Telegram.");

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const labels = ids.map((id) => {
  const pin = devicePin(id);
  return {
    id,
    pin,
    dashboard: `${baseUrl}/?device=${id}`,
    telegram: bot ? `https://t.me/${bot.replace(/^@/, "")}?start=${id}_${pin}` : null,
  };
});

const cards = labels.map((l) => `
  <article class="label">
    <header>
      <span class="product">Smart Energy Meter</span>
      <span class="id">${escape(l.id)}</span>
    </header>
    <div class="pin"><span>PIN kontrol</span><strong>${escape(l.pin)}</strong></div>
    <div class="codes">
      <figure><div class="qr" data-text="${escape(l.dashboard)}"></div><figcaption>Dashboard</figcaption></figure>
      ${l.telegram ? `<figure><div class="qr" data-text="${escape(l.telegram)}"></div><figcaption>Telegram</figcaption></figure>` : ""}
    </div>
    <p class="note">Simpan PIN ini. Siapa pun yang memegangnya bisa mematikan pemantauan dan mengubah batas daya alat ini.</p>
  </article>`).join("");

const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Label Perangkat</title>
<style>
  :root { --ink: #0f172a; --ink-2: #475569; --line: #cbd5e1; --accent: #047857; }
  body { margin: 0; padding: 16px; background: #fff; color: var(--ink); font-family: "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { font-size: 13px; color: var(--ink-2); margin: 0 0 16px; }
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
  .label { border: 1px dashed var(--line); border-radius: 8px; padding: 12px; break-inside: avoid; display: flex; flex-direction: column; gap: 10px; }
  header { display: flex; flex-direction: column; gap: 2px; }
  .product { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); font-weight: 600; }
  .id { font-family: Consolas, monospace; font-size: 20px; font-weight: 700; }
  .pin { display: flex; justify-content: space-between; align-items: baseline; background: #f1f5f9; border-radius: 6px; padding: 6px 10px; }
  .pin span { font-size: 12px; color: var(--ink-2); }
  .pin strong { font-family: Consolas, monospace; font-size: 20px; letter-spacing: .15em; color: var(--accent); }
  .codes { display: flex; gap: 12px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  figcaption { font-size: 12px; color: var(--ink-2); }
  .qr img, .qr canvas { width: 112px; height: 112px; }
  .note { font-size: 11px; color: var(--ink-2); margin: 0; }
  @media print { body { padding: 0; } h1, .hint { display: none; } }
</style>
</head>
<body>
<h1>Label perangkat</h1>
<p class="hint">Cetak, gunting di garis putus-putus, tempel di tiap alat. File ini memuat PIN: jangan diunggah atau dibagikan.</p>
<main class="sheet">${cards}</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  document.querySelectorAll(".qr").forEach((el) => new QRCode(el, { text: el.dataset.text, width: 224, height: 224, correctLevel: QRCode.CorrectLevel.M }));
</script>
</body>
</html>
`;

fs.writeFileSync(OUT_FILE, html);
console.log(`${labels.length} label ditulis ke ${OUT_FILE}`);
