"use strict";

// Halaman "Alat saya": akun pemilik (auth.js), daftar alat miliknya dari
// Supabase, dan data langsung tiap alat dari broker MQTT (user read-only yang
// sama dengan script.js).
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const MQTT_USERNAME = "smartenergymeterweb";
const MQTT_PASSWORD = "sMch!JtGn5gpYD4";

const $ = (id) => document.getElementById(id);
const live = new Map(); // deviceId -> { status, power, billMonth }
const ui = { renaming: null, releasing: null, sending: false };
let mqttClient = null;
let subscribed = new Set();

function formatRupiah(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function setMsg(id, text, tone) {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `text-small ${tone === "bad" ? "text-bad-ink" : tone === "good" ? "text-accent-ink" : "text-ink-2"}`;
}

function setBroker(label, tone) {
  const dot = $("brokerDot"), text = $("brokerBadge");
  const color = tone === "good" ? "accent" : tone === "bad" ? "bad" : "warn";
  dot.style.background = `var(--${color})`;
  text.style.color = `var(--${color}-ink)`;
  text.textContent = label;
}

const STATUS = {
  online: { label: "Online", tone: "accent" },
  standby: { label: "Standby", tone: "warn" },
  offline: { label: "Offline", tone: "bad" },
};

// --- Daftar alat ---

function monthTotal(weekly) {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const weeks = (weekly && weekly[key]) || {};
  let total = 0;
  for (let w = 1; w <= 5; w++) total += Number(weeks["week" + w] || 0);
  return total;
}

function deviceCard(id, name) {
  const info = live.get(id) || {};
  const st = STATUS[info.status];
  const title = name || id;
  const card = document.createElement("article");
  card.className = "bg-card rounded-xl border border-line p-4 flex flex-col gap-3";
  card.setAttribute("aria-label", title);

  const renaming = ui.renaming === id;
  const releasing = ui.releasing === id;
  const power = info.status === "online" && Number.isFinite(info.power) ? `${Math.round(info.power)} W` : "-";

  card.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-col min-w-0">
        <span class="text-title text-ink truncate"></span>
        <span class="font-mono text-small text-ink-2">${id}</span>
      </div>
      <span class="shrink-0 inline-flex items-center gap-1.5 font-mono text-label uppercase" style="color:var(--${st ? st.tone : "ink-2"}${st && st.tone !== "ink-2" ? "-ink" : ""})">
        <span class="inline-flex h-2 w-2 rounded-full" style="background:var(--${st ? st.tone : "line"})"></span>${st ? st.label : "Memeriksa"}
      </span>
    </div>
    <div class="flex items-center justify-between bg-inset rounded-lg px-3 py-2">
      <div class="flex flex-col"><span class="font-mono text-label uppercase text-ink-2">Daya</span><span class="font-mono text-small text-ink font-semibold num">${power}</span></div>
      <div class="flex flex-col text-right"><span class="font-mono text-label uppercase text-ink-2">Tagihan bulan ini</span><span class="font-mono text-small text-ink font-semibold num">${info.billMonth === undefined ? "-" : formatRupiah(info.billMonth)}</span></div>
    </div>`;
  card.querySelector(".text-title").textContent = title;

  if (renaming) {
    const form = document.createElement("form");
    form.className = "flex flex-col gap-2";
    form.noValidate = true;
    form.innerHTML = `
      <label class="text-small text-ink font-semibold" for="rename-input">Nama alat</label>
      <input class="w-full min-h-[44px] px-3 rounded-lg bg-inset border border-line text-body text-ink" id="rename-input" maxlength="40" type="text"/>
      <div class="flex gap-2">
        <button class="flex-1 min-h-[44px] px-4 rounded-lg bg-btn text-on-btn hover:opacity-90 font-semibold transition-opacity" type="submit">Simpan nama</button>
        <button class="min-h-[44px] px-4 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" data-act="cancel" type="button">Batal</button>
      </div>`;
    form.querySelector("input").value = name || "";
    form.addEventListener("submit", (e) => { e.preventDefault(); saveName(id, form.querySelector("input").value); });
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelEdit(id); });
    form.querySelector('[data-act="cancel"]').addEventListener("click", () => cancelEdit(id));
    card.appendChild(form);
  } else if (releasing) {
    const box = document.createElement("div");
    box.className = "flex flex-col gap-2 rounded-lg border border-line p-3";
    box.innerHTML = `
      <p class="text-small text-ink">Lepas ${id} dari akun ini? Alatnya tetap berjalan, dan bisa ditambahkan lagi dengan PIN dari label.</p>
      <div class="flex gap-2">
        <button class="flex-1 min-h-[44px] px-4 rounded-lg bg-card border border-line text-bad-ink hover:bg-inset font-semibold transition-colors" data-act="confirm" type="button">Lepas alat</button>
        <button class="min-h-[44px] px-4 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" data-act="cancel" type="button">Batal</button>
      </div>`;
    box.querySelector('[data-act="confirm"]').addEventListener("click", () => release(id));
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => cancelEdit(id));
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelEdit(id); });
    card.appendChild(box);
  } else {
    const actions = document.createElement("div");
    actions.className = "flex gap-2";
    actions.innerHTML = `
      <a class="flex-1 min-h-[44px] px-4 rounded-lg bg-btn text-on-btn hover:opacity-90 font-semibold transition-opacity flex items-center justify-center" href="index.html?device=${id}">Buka monitor</a>
      <button class="min-h-[44px] px-3 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" data-act="rename" type="button">Ubah nama</button>
      <button class="min-h-[44px] px-3 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" data-act="release" type="button">Lepas</button>`;
    actions.querySelector('[data-act="rename"]').setAttribute("aria-label", `Ubah nama ${title}`);
    actions.querySelector('[data-act="release"]').setAttribute("aria-label", `Lepas ${title} dari akun`);
    actions.querySelector('[data-act="rename"]').addEventListener("click", () => { ui.renaming = id; ui.releasing = null; renderList(); focusIn(id, "input"); });
    actions.querySelector('[data-act="release"]').addEventListener("click", () => { ui.releasing = id; ui.renaming = null; renderList(); focusIn(id, '[data-act="confirm"]'); });
    card.appendChild(actions);
  }
  card.dataset.device = id;
  return card;
}

function focusIn(id, selector) {
  const el = document.querySelector(`[data-device="${id}"] ${selector}`);
  if (el) el.focus();
}

function cancelEdit(id) {
  ui.renaming = null;
  ui.releasing = null;
  renderList();
  focusIn(id, '[data-act="rename"]');
}

function renderList() {
  const list = $("device-list");
  list.replaceChildren(...[...Account.owned].map(([id, name]) => deviceCard(id, name)));
  $("device-empty").hidden = Account.owned.size > 0;
}

async function saveName(id, value) {
  const name = value.trim() || null;
  const { error } = await sb.from("device_owners").update({ name }).eq("device_id", id).eq("user_id", Account.session.user.id);
  if (error) { setMsg("add-msg", "Gagal menyimpan nama. Coba lagi.", "bad"); return; }
  Account.owned.set(id, name);
  cancelEdit(id);
}

async function release(id) {
  const { error } = await sb.from("device_owners").delete().eq("device_id", id).eq("user_id", Account.session.user.id);
  if (error) { setMsg("add-msg", "Gagal melepas alat. Coba lagi.", "bad"); return; }
  ui.releasing = null;
  Account.owned.delete(id);
  setMsg("add-msg", `${id} dilepas dari akun.`, "good");
  renderList();
  syncSubscriptions();
}

// --- Data langsung dari broker ---

function syncSubscriptions() {
  if (!mqttClient || !mqttClient.connected) return;
  const wanted = new Set(Account.owned.keys());
  const topics = (id) => [`smartmeter/${id}/status`, `smartmeter/${id}/data`, `smartmeter/${id}/billing/weekly`];
  subscribed.forEach((id) => { if (!wanted.has(id)) { mqttClient.unsubscribe(topics(id)); live.delete(id); } });
  wanted.forEach((id) => { if (!subscribed.has(id)) mqttClient.subscribe(topics(id)); });
  subscribed = wanted;
}

function connectMQTT() {
  if (mqttClient) return;
  mqttClient = mqtt.connect(MQTT_WS_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, clientId: "devices-" + Math.random().toString(16).slice(2), reconnectPeriod: 3000 });
  mqttClient.on("connect", () => { setBroker("Terhubung", "good"); subscribed = new Set(); syncSubscriptions(); });
  mqttClient.on("reconnect", () => setBroker("Mencoba ulang", "bad"));
  mqttClient.on("close", () => setBroker("Terputus dari broker", "bad"));
  mqttClient.on("message", (topic, payload) => {
    const [, id, ...rest] = topic.split("/");
    const key = rest.join("/");
    const info = live.get(id) || {};
    try {
      if (key === "status") info.status = payload.toString() === "online" || payload.toString() === "standby" ? payload.toString() : "offline";
      else if (key === "data") info.power = Number(JSON.parse(payload.toString()).power);
      else if (key === "billing/weekly") info.billMonth = monthTotal(JSON.parse(payload.toString()));
    } catch { return; }
    live.set(id, info);
    if (!ui.renaming && !ui.releasing) renderList();
  });
}

// --- Akun ---

function renderAccount() {
  const signedIn = !!Account.session;
  $("account-loading").hidden = true;
  $("signed-out").hidden = signedIn;
  $("signed-in").hidden = !signedIn;
  $("device-section").hidden = !signedIn;
  $("add-section").hidden = !signedIn;
  if (signedIn) {
    $("account-email").textContent = Account.email || "-";
    renderList();
    connectMQTT();
    syncSubscriptions();
    if (!mqttClient || !mqttClient.connected) setBroker("Menghubungkan", "warn");
  } else {
    syncSubscriptions(); // tidak ada alat lagi: lepas semua langganan
    setBroker("Belum masuk", "warn");
  }
}

async function sendEmailLink(event) {
  event.preventDefault();
  const input = $("email-input");
  const email = input.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("email-error").hidden = false; input.focus(); return; }
  $("email-submit").disabled = true;
  setMsg("signin-msg", "Mengirim...", "info");
  try {
    await Account.signInEmail(email);
    setMsg("signin-msg", `Link masuk dikirim ke ${email}. Buka emailnya di perangkat ini lalu ketuk linknya.`, "good");
  } catch (err) {
    const rate = /rate|limit|security purposes/i.test(String(err && err.message));
    setMsg("signin-msg", rate ? "Terlalu sering meminta link. Tunggu sebentar lalu coba lagi." : "Gagal mengirim link. Periksa alamat email lalu coba lagi.", "bad");
  }
  $("email-submit").disabled = false;
  $("signin-msg").focus();
}

async function signInGoogle() {
  try { await Account.signInGoogle(); }
  catch { setMsg("signin-msg", "Masuk dengan Google belum bisa dipakai. Gunakan link email dulu.", "bad"); $("signin-msg").focus(); }
}

function claimErrorText(status, body) {
  if (status === 401 && body.attemptsLeft !== undefined) return `PIN salah. Sisa ${body.attemptsLeft} percobaan.`;
  if (status === 401) return "Sesi masuk sudah habis. Masuk lagi lalu coba.";
  if (status === 429) return `Terlalu banyak PIN salah. Coba lagi dalam ${Math.max(1, Math.ceil((body.retryAfterSec || 900) / 60))} menit.`;
  if (status === 400) return body.error || "Periksa ID dan PIN.";
  if (status === 503) return "Akun belum diaktifkan di server. Hubungi pengelola alat.";
  return "Gagal menambahkan alat. Periksa koneksi lalu coba lagi.";
}

async function addDevice(event) {
  event.preventDefault();
  const id = normalizeDeviceId($("add-id").value);
  const pin = $("add-pin").value.trim();
  const showError = (text, focusId) => { $("add-error").textContent = text; $("add-error").hidden = false; $(focusId).focus(); };
  $("add-error").hidden = true;
  if (!id) return showError("Format ID: sem- lalu 6 huruf/angka (0-9, a-f), contoh sem-a1b2c3.", "add-id");
  if (!/^\d{6}$/.test(pin)) return showError("PIN terdiri dari 6 angka.", "add-pin");

  $("add-submit").disabled = true;
  const status = await claimDevice(id, pin, $("add-name").value);
  $("add-submit").disabled = false;
  $("add-pin").value = "";
  if (status === 200) { $("add-id").value = ""; $("add-name").value = ""; }
  $("add-msg").focus();
}

// Mengirim ID + PIN ke api/claim. Mengembalikan status HTTP (0 = gagal jaringan).
async function claimDevice(id, pin, name) {
  setMsg("add-msg", "Memeriksa PIN...", "info");
  let status = 0, body = {};
  try {
    const res = await fetch("api/claim", { method: "POST", headers: { "Content-Type": "application/json", ...Account.authHeader() }, body: JSON.stringify({ device: id, pin, name }) });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch { /* status 0: gagal jaringan */ }

  if (status === 200) {
    setMsg("add-msg", `${id} ditambahkan ke akun.`, "good");
    rememberDevice(id);
    await Account.refreshOwned();
    syncSubscriptions();
  } else {
    setMsg("add-msg", claimErrorText(status, body), "bad");
  }
  return status;
}

// --- QR di label: devices.html#claim=sem-a1b2c3_123456 ---
// Bagian # tidak pernah dikirim ke server, jadi PIN tidak tercatat di log mana pun.
// Disimpan sebentar di browser supaya tetap ada setelah pengguna pergi login
// (link email atau Google kembali ke halaman ini tanpa #claim).
const PENDING_KEY = "pendingClaim";
const PENDING_TTL_MS = 30 * 60 * 1000;

function clearPendingClaim() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* storage diblokir */ }
}

function readPendingClaim() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    if (p && Date.now() - p.at < PENDING_TTL_MS && normalizeDeviceId(p.id) && /^\d{6}$/.test(p.pin)) return p;
  } catch { /* storage diblokir */ }
  clearPendingClaim();
  return null;
}

(function captureClaimFromQr() {
  const m = location.hash.match(/^#claim=([^_]+)_(\d{6})$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const id = normalizeDeviceId(m[1]);
  if (!id) return;
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id, pin: m[2], at: Date.now() })); } catch { /* storage diblokir */ }
  rememberDevice(id);
})();

let claimRunning = false;
async function runPendingClaim() {
  const p = readPendingClaim();
  $("claim-note").hidden = !p || !!Account.session;
  if (p) $("claim-note-id").textContent = p.id;
  if (!p || !Account.session || claimRunning) return;
  if (Account.isOwner(p.id)) { clearPendingClaim(); setMsg("add-msg", `${p.id} sudah ada di akun Anda.`, "good"); return; }
  claimRunning = true;
  const status = await claimDevice(p.id, p.pin, null);
  claimRunning = false;
  if (status !== 0) clearPendingClaim(); // gagal jaringan: dicoba lagi saat halaman dibuka lagi
  $("add-msg").focus();
}

document.addEventListener("DOMContentLoaded", () => {
  if (!Account.available) {
    $("account-loading").hidden = true;
    $("account-unavailable").hidden = false;
    setBroker("Layanan akun gagal dimuat", "bad");
    return;
  }
  $("email-form").addEventListener("submit", sendEmailLink);
  $("email-input").addEventListener("input", () => { $("email-error").hidden = true; });
  $("btn-google").addEventListener("click", signInGoogle);
  $("btn-signout").addEventListener("click", async () => { await Account.signOut(); setMsg("add-msg", ""); });
  $("add-form").addEventListener("submit", addDevice);
  Account.onChange(renderAccount);
  Account.onChange(runPendingClaim);
});
