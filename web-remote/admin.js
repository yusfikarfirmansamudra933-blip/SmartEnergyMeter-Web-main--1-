"use strict";

// Halaman admin penjual: semua alat (api/admin), versi firmware, status
// update dari cloud, dan perintah update/restart. Akses dibatasi di server
// (ADMIN_EMAILS); halaman ini hanya menampilkan apa yang dikirim server.

const $ = (id) => document.getElementById(id);
const ui = { data: null, restarting: null, busy: new Set() };

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const STATUS = {
  online: { label: "Online", tone: "accent" },
  standby: { label: "Standby", tone: "warn" },
  offline: { label: "Offline", tone: "bad" },
};

function versionNumber(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || "");
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}

// Alat yang termasuk rilis ini (semua, atau hanya yang ada di daftar --only).
function inRelease(latest, id) {
  return !!latest && (!latest.devices || latest.devices.includes(id));
}

function needsUpdate(latest, d) {
  return inRelease(latest, d.id) && !!d.firmware && versionNumber(d.firmware) < versionNumber(latest.version);
}

function timeAgo(iso) {
  if (!iso) return "-";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return "baru saja";
  if (min < 60) return `${min} menit lalu`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} jam lalu`;
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

// Slot aplikasi partitions.csv. Alat yang terakhir di-flash USB sebelum itu
// masih punya slot 1,25 MB sampai di-flash USB sekali lagi.
const BIG_SLOT = 0x1c0000;

function appSizeText(bytes) {
  const mb = (bytes / 1048576).toLocaleString("id-ID", { maximumFractionDigits: 2 });
  return bytes < BIG_SLOT ? `${mb} MB, flash ulang lewat USB sekali` : `${mb} MB`;
}

function otaText(d) {
  const o = d.ota;
  if (!o || !o.state) return d.firmware ? "Belum pernah cek update" : "Firmware lama, belum mendukung update dari cloud";
  if (o.state === "current") return "Sudah versi terbaru";
  if (o.state === "downloading") return `Sedang mengunduh ${o.version}`;
  if (o.state === "updated") return `Berhasil diperbarui ke ${o.version}`;
  if (o.state === "failed") return `Gagal${o.version ? ` (${o.version})` : ""}: ${o.error || "tanpa keterangan"}`;
  return o.state;
}

function setMsg(id, text, tone) {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `text-small ${tone === "bad" ? "text-bad-ink" : tone === "good" ? "text-accent-ink" : "text-ink-2"}`;
}

function show(state) {
  $("state-loading").hidden = state !== "loading";
  $("state-blocked").hidden = state !== "blocked";
  $("state-error").hidden = state !== "error";
  $("content").hidden = state !== "content";
  $("btn-refresh").hidden = state !== "content";
}

// --- Tampilan ---

function renderRelease() {
  const { latest, devices } = ui.data;
  const btn = $("btn-update-all");
  if (!latest) {
    $("latest-version").textContent = "Belum ada";
    $("latest-meta").textContent = "";
    $("latest-progress").textContent = "Buat rilis dengan scripts/release-firmware.js di komputer Anda, lalu deploy.";
    btn.disabled = true;
    return;
  }
  $("latest-version").textContent = latest.version;
  const date = latest.released ? new Date(latest.released).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  $("latest-meta").textContent = [date && `Dirilis ${date}`, latest.devices ? `hanya untuk ${latest.devices.join(", ")}` : "untuk semua alat"].filter(Boolean).join(", ");
  const targets = devices.filter((d) => inRelease(latest, d.id));
  const done = targets.filter((d) => versionNumber(d.firmware) >= versionNumber(latest.version)).length;
  $("latest-progress").textContent = targets.length ? `${done} dari ${targets.length} alat sudah memakai versi ini. Alat lain memasangnya sendiri dalam 6 jam setelah online.` : "Belum ada alat yang termasuk rilis ini.";
  btn.disabled = false;
}

function renderSummary() {
  const counts = { online: 0, standby: 0, offline: 0 };
  ui.data.devices.forEach((d) => { counts[STATUS[d.status] ? d.status : "offline"]++; });
  $("summary").innerHTML = Object.entries(counts).map(([key, n]) => `
    <div class="bg-card rounded-xl border border-line px-3 py-2 flex flex-col">
      <span class="font-mono text-label uppercase" style="color:var(--${STATUS[key].tone}-ink)">${STATUS[key].label}</span>
      <span class="font-mono text-title text-ink num">${n}</span>
    </div>`).join("");
}

function row(label, value, extraClass = "") {
  return `<div class="flex items-baseline justify-between gap-3 py-1.5"><span class="font-mono text-label uppercase text-ink-2 shrink-0">${label}</span><span class="text-small text-ink text-right min-w-0 break-words ${extraClass}">${value}</span></div>`;
}

function deviceCard(d) {
  const { latest } = ui.data;
  const st = STATUS[d.status] || STATUS.offline;
  const connected = d.status === "online" || d.status === "standby";
  const busy = ui.busy.has(d.id);
  const owners = d.owners.length
    ? d.owners.map((o) => `${esc(o.email || "akun terhapus")}${o.name ? ` (${esc(o.name)})` : ""}`).join("<br>")
    : '<span class="text-ink-2">Belum ada pemilik</span>';
  const title = (d.owners.find((o) => o.name) || {}).name || d.id;
  const stale = needsUpdate(latest, d);
  const failed = d.ota && d.ota.state === "failed";

  const card = document.createElement("article");
  card.className = "bg-card rounded-xl border border-line p-4 flex flex-col gap-3";
  card.dataset.device = d.id;
  card.setAttribute("aria-label", title);
  card.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-col min-w-0">
        <span class="text-title text-ink truncate">${esc(title)}</span>
        ${title === d.id ? "" : `<span class="font-mono text-small text-ink-2">${d.id}</span>`}
      </div>
      <span class="shrink-0 inline-flex items-center gap-1.5 font-mono text-label uppercase" style="color:var(--${st.tone}-ink)">
        <span class="inline-flex h-2 w-2 rounded-full" style="background:var(--${st.tone})"></span>${st.label}
      </span>
    </div>
    <div class="bg-inset rounded-lg px-3 py-1 flex flex-col divide-y divide-line">
      ${row("Firmware", `<span class="font-mono">${esc(d.firmware || "1.16.0 atau lebih lama")}</span>${stale ? ' <span class="font-semibold" style="color:var(--warn-ink)">perlu update</span>' : ""}`)}
      ${row("Update", esc(otaText(d)), failed ? "text-bad-ink" : "")}
      ${d.appSize ? row("Ruang firmware", appSizeText(d.appSize), d.appSize < BIG_SLOT ? "text-warn-ink" : "") : ""}
      ${row("Pemilik", owners)}
      ${row("Terakhir online", connected ? "sekarang" : esc(timeAgo(d.lastSeen)))}
      ${d.status === "online" && d.power != null ? row("Daya", `<span class="font-mono num">${Math.round(d.power)} W</span>`) : ""}
      ${connected && d.rssi != null ? row("Sinyal WiFi", `<span class="font-mono num">${d.rssi} dBm</span>${d.ip ? `, <span class="font-mono">${esc(d.ip)}</span>` : ""}`) : ""}
    </div>`;

  if (ui.restarting === d.id) {
    const box = document.createElement("div");
    box.className = "flex flex-col gap-2 rounded-lg border border-line p-3";
    box.innerHTML = `
      <p class="text-small text-ink">Restart ${d.id}? Pemantauan berhenti sekitar 10 detik lalu jalan lagi.</p>
      <div class="flex gap-2">
        <button class="flex-1 min-h-[44px] px-4 rounded-lg bg-card border border-line text-bad-ink hover:bg-inset font-semibold transition-colors" data-act="confirm" type="button">Restart alat</button>
        <button class="min-h-[44px] px-4 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors" data-act="cancel" type="button">Batal</button>
      </div>`;
    box.querySelector('[data-act="confirm"]').addEventListener("click", () => send(d.id, "restart"));
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => closeRestart(d.id));
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRestart(d.id); });
    card.appendChild(box);
  } else {
    const actions = document.createElement("div");
    actions.className = "flex gap-2";
    actions.innerHTML = `
      <button class="flex-1 min-h-[44px] px-4 rounded-lg ${stale ? "bg-btn text-on-btn hover:opacity-90" : "bg-card border border-line text-ink hover:bg-inset"} font-semibold transition-opacity disabled:opacity-50" data-act="update" type="button">Cek update sekarang</button>
      <button class="min-h-[44px] px-3 rounded-lg bg-card border border-line text-ink hover:bg-inset font-semibold transition-colors disabled:opacity-50" data-act="restart" type="button">Restart</button>`;
    actions.querySelectorAll("button").forEach((b) => { b.disabled = !connected || busy; });
    actions.querySelector('[data-act="update"]').addEventListener("click", () => send(d.id, "update"));
    actions.querySelector('[data-act="restart"]').addEventListener("click", () => { ui.restarting = d.id; renderList(); focusIn(d.id, '[data-act="confirm"]'); });
    card.appendChild(actions);
    if (!connected) {
      const note = document.createElement("p");
      note.className = "text-small text-ink-2";
      note.textContent = "Perintah bisa dikirim setelah alat online lagi.";
      card.appendChild(note);
    }
  }

  const msg = document.createElement("p");
  msg.className = "text-small";
  msg.dataset.msg = "";
  msg.setAttribute("role", "status");
  msg.setAttribute("aria-live", "polite");
  msg.hidden = true;
  card.appendChild(msg);
  return card;
}

// Yang perlu perhatian di atas: perlu update, lalu gagal update, lalu sisanya; offline paling bawah.
function sortKey(d) {
  const offline = !(d.status === "online" || d.status === "standby");
  const attention = needsUpdate(ui.data.latest, d) || (d.ota && d.ota.state === "failed");
  return `${offline ? 1 : 0}${attention ? 0 : 1}${d.id}`;
}

function renderList() {
  const devices = [...ui.data.devices].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  $("device-list").replaceChildren(...devices.map(deviceCard));
  $("device-empty").hidden = devices.length > 0;
}

function render() {
  renderRelease();
  renderSummary();
  renderList();
  show("content");
}

function focusIn(id, selector) {
  const el = document.querySelector(`[data-device="${id}"] ${selector}`);
  if (el) el.focus();
}

function closeRestart(id) {
  ui.restarting = null;
  renderList();
  focusIn(id, '[data-act="restart"]');
}

function cardMsg(id, text, tone) {
  const el = document.querySelector(`[data-device="${id}"] [data-msg]`);
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.className = `text-small ${tone === "bad" ? "text-bad-ink" : "text-accent-ink"}`;
}

// --- Server ---

async function api(method, body) {
  const res = await fetch("api/admin", {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...Account.authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  if (!ui.data) show("loading");
  $("btn-refresh").disabled = true;
  try {
    const { status, body } = await api("GET");
    if (status === 200) {
      ui.data = body;
      render();
    } else if (status === 401 || status === 403) {
      blocked("Bukan akun admin", body.error || "Akun ini tidak punya akses ke halaman admin.", false);
    } else {
      failed(body.error || "Server tidak menjawab. Coba lagi sebentar lagi.");
    }
  } catch {
    failed("Tidak bisa menghubungi server. Periksa koneksi internet.");
  }
  $("btn-refresh").disabled = false;
  loading = false;
}

function blocked(title, text, showLink) {
  $("blocked-title").textContent = title;
  $("blocked-text").textContent = text;
  $("blocked-link").hidden = !showLink;
  show("blocked");
}

function failed(text) {
  $("error-text").textContent = text;
  show("error");
}

// Alat butuh beberapa detik untuk menjawab (cek update, atau boot ulang),
// jadi daftar dimuat ulang sendiri setelahnya.
async function send(id, action) {
  ui.busy.add(id);
  ui.restarting = null;
  renderList();
  let ok = false;
  try { ok = (await api("POST", { action, device: id })).status === 200; } catch { /* gagal jaringan */ }
  ui.busy.delete(id);
  renderList();
  if (ok) {
    cardMsg(id, action === "update" ? "Perintah terkirim. Alat memeriksa rilis terbaru, hasilnya muncul di baris Update." : "Perintah restart terkirim.", "good");
    setTimeout(load, action === "update" ? 15000 : 20000);
  } else {
    cardMsg(id, "Perintah gagal dikirim. Coba lagi.", "bad");
  }
}

async function updateAll() {
  const btn = $("btn-update-all");
  btn.disabled = true;
  setMsg("update-all-msg", "Mengirim...", "info");
  try {
    const { status, body } = await api("POST", { action: "update-all" });
    if (status === 200) {
      setMsg("update-all-msg", body.sent ? `Perintah terkirim ke ${body.sent} alat online. Daftar dimuat ulang dalam 20 detik.` : "Tidak ada alat yang sedang online.", "good");
      if (body.sent) setTimeout(load, 20000);
    } else {
      setMsg("update-all-msg", body.error || "Perintah gagal dikirim. Coba lagi.", "bad");
    }
  } catch {
    setMsg("update-all-msg", "Tidak bisa menghubungi server. Periksa koneksi internet.", "bad");
  }
  btn.disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
  $("btn-refresh").addEventListener("click", load);
  $("btn-retry").addEventListener("click", load);
  $("btn-update-all").addEventListener("click", updateAll);
  if (!Account.available) {
    failed("Layanan akun tidak bisa dimuat. Periksa koneksi internet lalu muat ulang halaman.");
    return;
  }
  let lastUser;
  Account.onChange(() => {
    const user = Account.session ? Account.session.user.id : null;
    if (user === lastUser) return;
    lastUser = user;
    ui.data = null;
    if (user) load();
    else blocked("Masuk dulu", "Halaman ini hanya untuk akun admin. Masuk dengan akun Anda di halaman Alat, lalu kembali ke sini.", true);
  });
});
