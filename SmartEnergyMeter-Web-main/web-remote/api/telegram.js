const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// Dedicated bot MQTT user (server-side only, never shipped to the browser).
// Unlike the public dashboard's read-only user, this one may publish to
// smartmeter/+/cmd/limit and smartmeter/+/telegram/# — see .gitignore'd
// web-remote/bot-credentials.local.txt for the ACL this user needs.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Server-side only (service role key bypasses Row Level Security — never
// expose this to a browser, unlike the anon key in supabase-client.js).
//
// Built lazily instead of at module load: createClient() throws
// synchronously if the env vars are missing/empty, and since this whole
// file is one Vercel function, that would take down every command
// (including /help and the plain webhook health check) rather than just
// the ones that actually need Supabase — see getSupabase()'s call sites.
let supabase = null;
function getSupabase() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY belum diset di Vercel");
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

const MIN_LIMIT = 100;
const MAX_LIMIT = 10000;
const REMINDER_HOUR_WIB = 8;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

// Per-device MQTT topics this file talks to — a plain object instead of the
// old module-level constants, since which device a command targets is now
// resolved per-message (see resolveDevice()) instead of being one fixed id.
function topicsFor(deviceId) {
  return {
    data: `smartmeter/${deviceId}/data`,
    status: `smartmeter/${deviceId}/status`,
    limitCmd: `smartmeter/${deviceId}/cmd/limit`,
    billingDaily: `smartmeter/${deviceId}/billing/daily`,
    reminder: `smartmeter/${deviceId}/telegram/reminder`,
  };
}

function connectBot() {
  return mqtt.connect(MQTT_WS_URL, {
    username: BOT_MQTT_USERNAME,
    password: BOT_MQTT_PASSWORD,
    clientId: "telegram-bot-" + Math.random().toString(16).slice(2),
    connectTimeout: 4000,
  });
}

// Both topics are retained by the firmware, so a fresh subscribe gets the
// broker's last known values instantly. status is set via MQTT Last Will,
// so it reflects true online/offline even if the device dropped off
// ungracefully — data alone would otherwise look "live" forever since it
// just replays whatever was last published, however old that is.
function fetchDeviceState(topics, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const client = connectBot();
    let status = null;
    let data = null;

    const finish = () => {
      clearTimeout(timer);
      client.end(true);
      resolve({ status, data });
    };

    const timer = setTimeout(finish, timeoutMs);

    client.on("connect", () => {
      client.subscribe(topics.status);
      client.subscribe(topics.data);
    });

    client.on("message", (topic, payload) => {
      if (topic === topics.status) status = payload.toString();
      if (topic === topics.data) {
        try { data = JSON.parse(payload.toString()); } catch { /* ignore malformed packet */ }
      }
      if (status !== null && data !== null) finish();
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      client.end(true);
      reject(err);
    });
  });
}

function publishAndWait(topic, message, { retain = false } = {}) {
  return new Promise((resolve, reject) => {
    const client = connectBot();
    const timer = setTimeout(() => { client.end(true); reject(new Error("Timeout saat publish")); }, 4000);

    client.on("connect", () => {
      client.publish(topic, String(message), { retain, qos: 1 }, (err) => {
        clearTimeout(timer);
        client.end(true);
        if (err) reject(err); else resolve();
      });
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      client.end(true);
      reject(err);
    });
  });
}

// Reads a single retained topic (or null if nothing was retained / timed out).
function fetchTopic(topic, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const client = connectBot();
    let value = null;
    const finish = () => { clearTimeout(timer); client.end(true); resolve(value); };
    const timer = setTimeout(finish, timeoutMs);
    client.on("connect", () => client.subscribe(topic));
    client.on("message", (t, payload) => { if (t === topic) { value = payload.toString(); finish(); } });
    client.on("error", finish);
  });
}

function num(value, digits) {
  return Number(value || 0).toFixed(digits);
}

function safeParse(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}

function formatRupiah(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

// WIB (UTC+7) wall-clock time as a Date whose getUTC* fields read as WIB —
// same trick as api/monitor.js, keeps this file's date math independent of
// the serverless runtime's local timezone.
function nowWIB() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function dayKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }

// Resolves which device a command should act on: chat -> linked account
// (telegram_links) -> that account's devices. A trailing "<deviceId>" word
// in the raw arg string picks a specific one when the user has more than
// one, e.g. "/watt meter-01" — otherwise defaults to the oldest-registered
// device (matches the old single-device behavior exactly when there's only
// one, which covers the common case with zero extra steps).
async function resolveDevice(chatId, rawArg) {
  const { data: link } = await getSupabase()
    .from("telegram_links")
    .select("user_id")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (!link) {
    return {
      error: "Chat ini belum terhubung ke akun manapun.\n\nBuka web dashboard, klik \"Hubungkan Telegram\", lalu kirim kodenya ke sini pakai /link <kode>.",
    };
  }

  const { data: devices } = await getSupabase()
    .from("devices")
    .select("*")
    .eq("owner_user_id", link.user_id)
    .order("created_at", { ascending: true });

  if (!devices || devices.length === 0) {
    return { error: "Akun ini belum punya device terdaftar. Tambahkan dulu lewat web dashboard." };
  }

  const trimmed = (rawArg || "").trim();
  if (trimmed) {
    const tokens = trimmed.split(/\s+/);
    const last = tokens[tokens.length - 1];
    const matched = devices.find((d) => d.id === last);
    if (matched) {
      return { device: matched, devices, remainingArg: tokens.slice(0, -1).join(" ") };
    }
  }

  return { device: devices[0], devices, remainingArg: trimmed };
}

function statusText(data) {
  return [
    "📊 Status Smart Energy Meter",
    `Tegangan: ${num(data.voltage, 1)} V`,
    `Arus: ${num(data.current, 2)} A`,
    `Daya: ${num(data.power, 0)} W`,
    `Energi: ${num(data.energy, 3)} kWh`,
    `Frekuensi: ${num(data.frequency, 1)} Hz`,
    `Power factor: ${num(data.pf, 2)}`,
    `Batas daya: ${num(data.limit, 0)} W`,
    `Sensor PZEM: ${data.sensor ? "Online" : "Tidak terdeteksi"}`,
    `WiFi perangkat: ${data.wifi ? "Terhubung" : "Terputus"}`,
  ].join("\n");
}

// Command -> reply. Registered with @BotFather so they show up in
// Telegram's "/" autocomplete menu (see setMyCommands call in project notes).
const COMMANDS = {
  watt: (data) => `⚡ Daya saat ini: ${num(data.power, 0)} Watt`,
  daya: (data) => `⚡ Daya saat ini: ${num(data.power, 0)} Watt`,
  kwh: (data) => `🔋 Energi terpakai: ${num(data.energy, 3)} kWh`,
  energi: (data) => `🔋 Energi terpakai: ${num(data.energy, 3)} kWh`,
  volt: (data) => `🔌 Tegangan: ${num(data.voltage, 1)} Volt`,
  tegangan: (data) => `🔌 Tegangan: ${num(data.voltage, 1)} Volt`,
  ampere: (data) => `🔀 Arus: ${num(data.current, 2)} Ampere`,
  arus: (data) => `🔀 Arus: ${num(data.current, 2)} Ampere`,
  frekuensi: (data) => `📶 Frekuensi: ${num(data.frequency, 1)} Hz`,
  hz: (data) => `📶 Frekuensi: ${num(data.frequency, 1)} Hz`,
  pf: (data) => `📐 Power factor: ${num(data.pf, 2)}`,
  powerfactor: (data) => `📐 Power factor: ${num(data.pf, 2)}`,
  status: statusText,
  limit: (data) => `🎚️ Batas daya saat ini: ${num(data.limit, 0)} Watt`,
};

const HELP_TEXT = [
  "Halo! Saya bot Smart Energy Meter. Perintah yang tersedia:",
  "/watt - daya saat ini (Watt)",
  "/kwh - energi terpakai (kWh)",
  "/volt - tegangan (Volt)",
  "/ampere - arus (Ampere)",
  "/frekuensi - frekuensi (Hz)",
  "/pf - power factor",
  "/limit - lihat batas daya saat ini",
  "/setlimit <angka> - ubah batas daya, contoh: /setlimit 500",
  "/status - semua data sekaligus",
  "/riwayat - grafik & rincian biaya 7 hari terakhir",
  "/reminder <tanggal> <pesan> - pengingat bayar listrik tiap bulan, contoh: /reminder 25 Jangan lupa bayar listrik!",
  "/reminder - lihat pengingat yang aktif",
  "/reminder off - matikan pengingat",
  "/devices - lihat device yang terhubung ke akun Anda",
  "",
  "Punya lebih dari 1 device? Tambahkan id-nya di akhir perintah, misal /watt meter-01 — tanpa itu, device pertama yang dipakai.",
  "",
  "Kirim /link <kode> (dari web dashboard) sekali supaya saya tahu chat ini milik akun mana, dan bisa kirim notifikasi otomatis (offline / kelebihan batas daya).",
  "Atau tanya bebas juga bisa, misalnya \"berapa watt sekarang\".",
].join("\n");

async function handleLink(arg, chatId) {
  const code = (arg || "").trim();
  if (!code) {
    return "Format: /link <kode>. Ambil kodenya dari tombol \"Hubungkan Telegram\" di web dashboard.";
  }

  const { data: row } = await getSupabase().from("telegram_link_codes").select("*").eq("code", code).maybeSingle();
  if (!row) {
    return "Kode tidak ditemukan atau sudah pernah dipakai. Generate kode baru dari web dashboard.";
  }

  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > LINK_CODE_TTL_MS) {
    await getSupabase().from("telegram_link_codes").delete().eq("code", code);
    return "Kode sudah kedaluwarsa (berlaku 15 menit). Generate kode baru dari web dashboard.";
  }

  const { error } = await getSupabase().from("telegram_links").upsert({ chat_id: String(chatId), user_id: row.user_id });
  await getSupabase().from("telegram_link_codes").delete().eq("code", code);

  if (error) {
    return `⚠️ Gagal menghubungkan: ${error.message}`;
  }
  return "✅ Berhasil terhubung! Sekarang saya bisa jawab soal device di akun Anda dan kirim notifikasi otomatis.";
}

async function handleDevices(chatId) {
  const { data: link } = await getSupabase().from("telegram_links").select("user_id").eq("chat_id", String(chatId)).maybeSingle();
  if (!link) {
    return "Chat ini belum terhubung ke akun manapun. Kirim /link <kode> dari web dashboard dulu.";
  }

  const { data: devices } = await getSupabase()
    .from("devices")
    .select("*")
    .eq("owner_user_id", link.user_id)
    .order("created_at", { ascending: true });

  if (!devices || devices.length === 0) {
    return "Belum ada device terdaftar di akun ini. Tambahkan lewat web dashboard.";
  }

  const lines = ["📟 Device di akun Anda:"];
  devices.forEach((d, i) => lines.push(`${i === 0 ? "→" : " "} ${d.id} — ${d.name}`));
  lines.push("", `Tanda → dipakai otomatis kalau tidak disebutkan. Contoh pilih device lain: /watt ${devices[devices.length - 1].id}`);
  return lines.join("\n");
}

// Renders the last 7 days of billing history (smartmeter/<id>/billing/daily,
// already computed by api/monitor.js) as a QuickChart bar chart. QuickChart
// takes the chart spec straight in the URL and Telegram fetches that URL
// itself for sendPhoto, so no image handling/hosting needed on our side.
async function handleHistory(billingDailyTopic) {
  const raw = await fetchTopic(billingDailyTopic);
  const dailyData = safeParse(raw, {});
  const wib = nowWIB();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(wib.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKeyOf(d);
    days.push({ label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, rp: Number(dailyData[key] || 0) });
  }

  if (days.every((d) => d.rp === 0)) {
    return { text: "📉 Belum ada data riwayat pemakaian 7 hari terakhir." };
  }

  const chartConfig = {
    type: "bar",
    data: {
      labels: days.map((d) => d.label),
      datasets: [{ label: "Biaya listrik (Rp)", data: days.map((d) => d.rp), backgroundColor: "#3b82f6" }],
    },
    options: { plugins: { legend: { display: false }, title: { display: true, text: "Pemakaian 7 Hari Terakhir" } } },
  };
  const photoUrl = "https://quickchart.io/chart?w=600&h=350&c=" + encodeURIComponent(JSON.stringify(chartConfig));
  const total = days.reduce((sum, d) => sum + d.rp, 0);
  const text = [
    "📊 Riwayat 7 Hari Terakhir",
    ...days.map((d) => `${d.label}: ${formatRupiah(d.rp)}`),
    "",
    `Total: ${formatRupiah(total)}`,
  ].join("\n");
  return { text, photoUrl };
}

// "25 Jangan lupa bayar listrik!" -> { day: 25, message: "Jangan lupa..." }
function parseReminderArg(arg) {
  const match = (arg || "").trim().match(/^(\d{1,2})\s+([\s\S]+)$/);
  if (!match) return null;
  const day = Number(match[1]);
  // Capped at 28 so the reminder always fires, even in February.
  if (!Number.isFinite(day) || day < 1 || day > 28) return null;
  return { day, message: match[2].trim() };
}

async function handleReminder(arg, reminderTopic) {
  const trimmed = (arg || "").trim();

  if (!trimmed) {
    const reminder = safeParse(await fetchTopic(reminderTopic), null);
    if (!reminder) {
      return "🔕 Belum ada pengingat pembayaran.\nSet dengan /reminder <tanggal> <pesan>, contoh: /reminder 25 Jangan lupa bayar listrik!";
    }
    return `🔔 Pengingat aktif: tanggal ${reminder.day} tiap bulan, jam ${REMINDER_HOUR_WIB}:00 WIB\nPesan: "${reminder.message}"\n\nKirim /reminder off untuk matikan.`;
  }

  if (trimmed.toLowerCase() === "off") {
    // Empty retained payload clears it — same convention as a normal MQTT delete.
    await publishAndWait(reminderTopic, "", { retain: true });
    return "🔕 Pengingat pembayaran dimatikan.";
  }

  const parsed = parseReminderArg(trimmed);
  if (!parsed) {
    return "Format: /reminder <tanggal 1-28> <pesan>\nContoh: /reminder 25 Jangan lupa bayar listrik!\nAtau /reminder off untuk matikan.";
  }
  await publishAndWait(reminderTopic, JSON.stringify(parsed), { retain: true });
  return `✅ Pengingat diset: tanggal ${parsed.day} tiap bulan, jam ${REMINDER_HOUR_WIB}:00 WIB\nPesan: "${parsed.message}"`;
}

// Parses "/setlimit@yusfikar_bot 500" -> { command: "setlimit", arg: "500" }.
function parseCommand(text) {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?\s*(.*)$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: match[2].trim() };
}

function formatReply(text, data) {
  const parsed = parseCommand(text);
  if (parsed && COMMANDS[parsed.command]) return COMMANDS[parsed.command](data);

  // Free-text fallback for natural-language questions.
  const t = text.toLowerCase();
  if (/\bkwh\b|energi/.test(t)) return COMMANDS.kwh(data);
  if (/\bwatt\b|\bdaya\b/.test(t)) return COMMANDS.watt(data);
  if (/\bvolt\b|tegangan/.test(t)) return COMMANDS.volt(data);
  if (/ampere|\barus\b/.test(t)) return COMMANDS.arus(data);
  if (/frekuensi|\bhz\b/.test(t)) return COMMANDS.frekuensi(data);
  if (/power ?factor|\bpf\b|faktor daya/.test(t)) return COMMANDS.pf(data);
  if (/batas|limit/.test(t)) return COMMANDS.limit(data);
  if (/status|semua|kondisi|\bcek\b/.test(t)) return COMMANDS.status(data);

  return parsed
    ? `Perintah /${parsed.command} tidak dikenal. Kirim /help untuk lihat daftar perintah.`
    : 'Maaf, saya belum paham. Coba "/status" atau "/help" untuk lihat daftar perintah.';
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendTelegramPhoto(chatId, photoUrl, caption) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
  });
}

async function handleSetLimit(arg, limitCmdTopic) {
  const value = Number(arg);
  if (!arg || !Number.isFinite(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    return `Format: /setlimit <angka>. Contoh: /setlimit 500\nBatas harus antara ${MIN_LIMIT}-${MAX_LIMIT} Watt.`;
  }
  try {
    await publishAndWait(limitCmdTopic, value);
    return `✅ Batas daya diubah ke ${value} Watt.`;
  } catch {
    return "⚠️ Gagal mengubah batas daya, perangkat mungkin sedang offline. Coba lagi.";
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("Telegram bot webhook is running.");
    return;
  }

  const message = req.body && req.body.message;
  if (!message || !message.text) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  const text = message.text;
  const parsed = parseCommand(text);
  const command = parsed ? parsed.command : null;
  const isHelp = command === "start" || command === "help" || /bantuan|^menu$/i.test(text.trim());

  let reply;
  let photoReply = null;

  if (isHelp) {
    reply = HELP_TEXT;
  } else {
    // Everything past this point needs Supabase (getSupabase(), called
    // inside handleLink/handleDevices/resolveDevice) — if it's not
    // configured yet in Vercel's env vars, this throws instead of quietly
    // returning empty data, so surface it as an actual reply rather than a
    // bare 500 the person messaging the bot would never see.
    try {
      if (command === "link") {
        reply = await handleLink(parsed.arg, chatId);
      } else if (command === "devices" || command === "device") {
        reply = await handleDevices(chatId);
      } else {
        const resolution = await resolveDevice(chatId, parsed ? parsed.arg : text);
        if (resolution.error) {
          reply = resolution.error;
        } else {
          const { device, remainingArg } = resolution;
          const topics = topicsFor(device.id);

          if (command === "setlimit") {
            reply = await handleSetLimit(remainingArg, topics.limitCmd);
          } else if (command === "riwayat" || command === "history") {
            const result = await handleHistory(topics.billingDaily);
            if (result.photoUrl) photoReply = { url: result.photoUrl, caption: result.text };
            else reply = result.text;
          } else if (command === "reminder" || command === "pengingat") {
            reply = await handleReminder(remainingArg, topics.reminder);
          } else {
            try {
              const { status, data } = await fetchDeviceState(topics);
              if (status !== "online" || !data) {
                reply = "⚠️ Perangkat sedang offline. Coba lagi setelah dinyalakan.";
              } else {
                reply = formatReply(command ? `/${command} ${remainingArg}` : text, data);
              }
            } catch {
              reply = "⚠️ Perangkat sedang offline atau data belum tersedia. Coba lagi nanti.";
            }
          }
        }
      }
    } catch (err) {
      console.error("Command dispatch failed:", err);
      reply = "⚠️ Bot sedang ada gangguan teknis di sisi server. Coba lagi nanti.";
    }
  }

  try {
    if (photoReply) await sendTelegramPhoto(chatId, photoReply.url, photoReply.caption);
    else await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }

  res.status(200).json({ ok: true });
};
