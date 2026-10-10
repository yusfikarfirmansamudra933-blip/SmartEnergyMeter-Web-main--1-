"use strict";

// Perangkat yang sedang dibuka, dipakai bersama index.html dan bill.html.
// Satu dashboard melayani banyak alat: ID-nya diambil dari ?device=..., kalau
// tidak ada dari pilihan terakhir di browser ini. Tanpa keduanya, halaman
// meminta ID dulu sebelum menyambung ke broker.

// Sama dengan lib/devices.js di server: "sem-" + 6 digit heksadesimal dari MAC chip.
const DEVICE_RE = /^sem-[0-9a-f]{6}$/;
const RECENT_MAX = 10;

function normalizeDeviceId(input) {
  const raw = String(input || "").trim().toLowerCase();
  const id = /^[0-9a-f]{6}$/.test(raw) ? `sem-${raw}` : raw;
  return DEVICE_RE.test(id) ? id : null;
}

function readStore(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage diblokir: ID tetap terbawa lewat URL */ }
}

function recentDevices() {
  const list = readStore("recentDevices", []);
  return Array.isArray(list) ? list.filter((id) => DEVICE_RE.test(id)) : [];
}

function rememberDevice(id) {
  writeStore("device", id);
  writeStore("recentDevices", [id, ...recentDevices().filter((x) => x !== id)].slice(0, RECENT_MAX));
}

const DEVICE_ID = (() => {
  const fromUrl = normalizeDeviceId(new URLSearchParams(location.search).get("device"));
  if (fromUrl) { rememberDevice(fromUrl); return fromUrl; }
  const stored = normalizeDeviceId(readStore("device", null));
  // Taruh ID di alamat supaya halaman yang di-bookmark atau dibagikan membuka alat yang sama.
  if (stored) history.replaceState(null, "", `${location.pathname}?device=${stored}`);
  return stored;
})();

function deviceTopic(suffix) { return `smartmeter/${DEVICE_ID}/${suffix}`; }

function openDevice(id) {
  rememberDevice(id);
  location.search = `?device=${id}`;
}

// --- Pemilih perangkat (dialog) ---

const deviceUi = { dialog: null, required: false };

function buildDeviceDialog() {
  const dialog = document.createElement("dialog");
  dialog.id = "device-dialog";
  dialog.setAttribute("aria-labelledby", "device-dialog-title");
  dialog.className = "bg-card text-ink border border-line rounded-xl p-0 w-[calc(100%-32px)] max-w-md";
  dialog.innerHTML = `
    <div class="flex flex-col gap-4 p-5">
      <div class="flex flex-col gap-1">
        <h2 class="text-title text-ink" id="device-dialog-title">Pilih perangkat</h2>
        <p class="text-small text-ink-2">ID ada di label alat dan di layar OLED, pada halaman yang judulnya diawali "ID sem-".</p>
      </div>
      <div class="flex flex-col gap-2" hidden id="device-recent-wrap">
        <span class="font-mono text-label uppercase text-ink-2">Pernah dibuka di browser ini</span>
        <div class="flex flex-col gap-2" id="device-recent"></div>
      </div>
      <form class="flex flex-col gap-2" id="device-form" novalidate>
        <label class="text-small text-ink font-semibold" for="device-input">ID perangkat</label>
        <input aria-describedby="device-input-error" autocapitalize="off" autocomplete="off" class="w-full min-h-[44px] px-3 rounded-lg bg-inset border border-line text-body text-ink font-mono" id="device-input" placeholder="sem-a1b2c3" spellcheck="false" type="text"/>
        <p class="text-small text-bad-ink" hidden id="device-input-error">Format ID: sem- lalu 6 huruf/angka (0-9, a-f), contoh sem-a1b2c3.</p>
        <div class="flex gap-2">
          <button class="flex-1 min-h-[44px] px-4 rounded-lg bg-btn text-on-btn hover:opacity-90 font-semibold transition-opacity" type="submit">Buka perangkat</button>
          <button class="min-h-[44px] px-4 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" id="device-cancel" type="button">Batal</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(dialog);

  // Tanpa perangkat, halaman tidak punya apa pun untuk ditampilkan: dialog tidak bisa ditutup.
  // Chrome tetap menutup dialog lewat Escape walau "cancel" dicegah (kalau belum ada
  // interaksi sejak dibuka), jadi buka lagi begitu tertutup.
  dialog.addEventListener("cancel", (event) => { if (deviceUi.required) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (deviceUi.required) openDevicePicker(); });
  dialog.querySelector("#device-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("#device-input").addEventListener("input", () => { dialog.querySelector("#device-input-error").hidden = true; });
  dialog.querySelector("#device-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = dialog.querySelector("#device-input");
    const id = normalizeDeviceId(input.value);
    if (!id) { dialog.querySelector("#device-input-error").hidden = false; input.focus(); return; }
    if (id === DEVICE_ID) { dialog.close(); return; }
    openDevice(id);
  });
  return dialog;
}

function renderRecentDevices() {
  const list = recentDevices();
  const wrap = document.getElementById("device-recent-wrap");
  const box = document.getElementById("device-recent");
  wrap.hidden = !list.length;
  box.innerHTML = "";
  list.forEach((id) => {
    const current = id === DEVICE_ID;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `w-full min-h-[44px] px-3 rounded-lg border ${current ? "border-accent bg-accent-soft" : "border-line bg-inset hover:bg-card"} flex items-center justify-between gap-2 text-left transition-colors`;
    btn.innerHTML = `<span class="font-mono text-body text-ink">${id}</span><span class="font-mono text-label ${current ? "text-accent-ink" : "text-ink-2"}">${current ? "Sedang dibuka" : "Buka"}</span>`;
    btn.addEventListener("click", () => (current ? deviceUi.dialog.close() : openDevice(id)));
    box.appendChild(btn);
  });
}

function openDevicePicker() {
  if (!deviceUi.dialog) deviceUi.dialog = buildDeviceDialog();
  const dialog = deviceUi.dialog;
  dialog.querySelector("#device-cancel").hidden = deviceUi.required;
  dialog.querySelector("#device-input-error").hidden = true;
  dialog.querySelector("#device-input").value = "";
  renderRecentDevices();
  dialog.showModal();
  dialog.querySelector("#device-input").focus();
}

// Pesan di bawah baris perangkat, misalnya saat ID belum pernah mengirim data.
function setDeviceNote(text) {
  const el = document.getElementById("device-note");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

function setupDeviceRow() {
  const label = document.getElementById("device-id");
  if (label) label.textContent = DEVICE_ID || "Belum dipilih";
  document.getElementById("btn-device")?.addEventListener("click", openDevicePicker);

  // Tautan antarhalaman membawa ID, jadi tetap benar walau localStorage diblokir.
  if (DEVICE_ID) {
    document.querySelectorAll('a[href="index.html"], a[href="bill.html"]').forEach((a) => {
      a.href = `${a.getAttribute("href")}?device=${DEVICE_ID}`;
    });
  } else {
    deviceUi.required = true;
    openDevicePicker();
  }
}

window.addEventListener("DOMContentLoaded", setupDeviceRow);
