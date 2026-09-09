const mqtt = require("mqtt");

// Dedicated bot MQTT user (server-side only, never shipped to the browser).
// Unlike the public dashboard's read-only user, this one may publish to
// smartmeter/cmd/limit and smartmeter/telegram/# — see .gitignore'd
// web-remote/bot-credentials.local.txt for the ACL this user needs.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TOPIC_DATA = "smartmeter/data";
const TOPIC_STATUS = "smartmeter/status";
const TOPIC_LIMIT_CMD = "smartmeter/cmd/limit";
const TOPIC_CHAT_ID = "smartmeter/telegram/chatid";
const TOPIC_BILLING_DAILY = "smartmeter/billing/daily";
// Reminder is user-set (not auto-computed like the daily/weekly summary),
// so it lives under telegram/# rather than billing/# — see monitor.js for
// the cron side that actually fires it.
const TOPIC_REMINDER = "smartmeter/telegram/reminder";

const MIN_LIMIT = 100;
const MAX_LIMIT = 10000;
const REMINDER_HOUR_WIB = 8;

function connectBot() {
  return mqtt.connect(MQTT_WS_URL, {
    username: BOT_MQTT_USERNAME,
    password: BOT_MQTT_PASSWORD,
    clientId: "telegram-bot-" + Math.random().toString(16).slice(2),
    connectTimeout: 4000,
  });
}

// Both topics are retained by the firmware, so a fresh subscribe gets the
// broker's last known values instantly. TOPIC_STATUS is set via MQTT Last
// Will, so it reflects true online/offline even if the device dropped off
// ungracefully — TOPIC_DATA alone would otherwise look "live" forever since
// it just replays whatever was last published, however old that is.
function fetchDeviceState(timeoutMs = 4000) {
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
      client.subscribe(TOPIC_STATUS);
      client.subscribe(TOPIC_DATA);
    });

    client.on("message", (topic, payload) => {
      if (topic === TOPIC_STATUS) status = payload.toString();
      if (topic === TOPIC_DATA) {
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

function saveChatId(chatId) {
  return publishAndWait(TOPIC_CHAT_ID, String(chatId), { retain: true }).catch((err) => {
    console.error("Failed to save chat id:", err);
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
  "",
  "Kirim /start sekali supaya saya bisa kirim notifikasi otomatis (offline / kelebihan batas daya).",
  "Atau tanya bebas juga bisa, misalnya \"berapa watt sekarang\".",
].join("\n");

// Renders the last 7 days of billing history (smartmeter/billing/daily,
// already computed by api/monitor.js) as a QuickChart bar chart. QuickChart
// takes the chart spec straight in the URL and Telegram fetches that URL
// itself for sendPhoto, so no image handling/hosting needed on our side.
async function handleHistory() {
  const raw = await fetchTopic(TOPIC_BILLING_DAILY);
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

async function handleReminder(arg) {
  const trimmed = (arg || "").trim();

  if (!trimmed) {
    const reminder = safeParse(await fetchTopic(TOPIC_REMINDER), null);
    if (!reminder) {
      return "🔕 Belum ada pengingat pembayaran.\nSet dengan /reminder <tanggal> <pesan>, contoh: /reminder 25 Jangan lupa bayar listrik!";
    }
    return `🔔 Pengingat aktif: tanggal ${reminder.day} tiap bulan, jam ${REMINDER_HOUR_WIB}:00 WIB\nPesan: "${reminder.message}"\n\nKirim /reminder off untuk matikan.`;
  }

  if (trimmed.toLowerCase() === "off") {
    // Empty retained payload clears it — same convention as a normal MQTT delete.
    await publishAndWait(TOPIC_REMINDER, "", { retain: true });
    return "🔕 Pengingat pembayaran dimatikan.";
  }

  const parsed = parseReminderArg(trimmed);
  if (!parsed) {
    return "Format: /reminder <tanggal 1-28> <pesan>\nContoh: /reminder 25 Jangan lupa bayar listrik!\nAtau /reminder off untuk matikan.";
  }
  await publishAndWait(TOPIC_REMINDER, JSON.stringify(parsed), { retain: true });
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

async function handleSetLimit(arg) {
  const value = Number(arg);
  if (!arg || !Number.isFinite(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    return `Format: /setlimit <angka>. Contoh: /setlimit 500\nBatas harus antara ${MIN_LIMIT}-${MAX_LIMIT} Watt.`;
  }
  try {
    await publishAndWait(TOPIC_LIMIT_CMD, value);
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

  await saveChatId(chatId);

  let reply;
  let photoReply = null;
  if (isHelp) {
    reply = HELP_TEXT;
  } else if (command === "setlimit") {
    reply = await handleSetLimit(parsed.arg);
  } else if (command === "riwayat" || command === "history") {
    const result = await handleHistory();
    if (result.photoUrl) photoReply = { url: result.photoUrl, caption: result.text };
    else reply = result.text;
  } else if (command === "reminder" || command === "pengingat") {
    reply = await handleReminder(parsed.arg);
  } else {
    try {
      const { status, data } = await fetchDeviceState();
      if (status !== "online" || !data) {
        reply = "⚠️ Perangkat sedang offline. Coba lagi setelah dinyalakan.";
      } else {
        reply = formatReply(text, data);
      }
    } catch {
      reply = "⚠️ Perangkat sedang offline atau data belum tersedia. Coba lagi nanti.";
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
