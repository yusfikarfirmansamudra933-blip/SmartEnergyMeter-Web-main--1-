const { normalizeDeviceId, topic, chatTopic, safeParse, fetchRetained, publishAndWait, checkPin } = require("../lib/devices");
const Tariffs = require("../tariffs");

// Telegram webhook. One bot serves every meter: each chat links itself to a
// unit with that unit's ID and PIN (printed on its label, see
// scripts/device-label.js), and commands then go to the chat's active unit.
// Uses the server-side bot MQTT user (never shipped to the browser); see the
// README for the ACL it needs.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const MIN_LIMIT = 100;
const MAX_LIMIT = 10000;
const REMINDER_HOUR_WIB = 8;
const PREFIX = "telegram-bot";

function num(value, digits) {
  return Number(value || 0).toFixed(digits);
}

function formatRupiah(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
}

// WIB (UTC+7) wall-clock time as a Date whose getUTC* fields read as WIB —
// same trick as api/monitor.js, keeps this file's date math independent of
// the serverless runtime's local timezone.
function nowWIB() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function dayKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }

async function fetchTopic(t) {
  return (await fetchRetained([t], { prefix: PREFIX }))[t];
}

// --- Chat <-> device links ---

// { active: "sem-a1b2c3", devices: ["sem-a1b2c3", ...] }
async function loadChat(chatId) {
  const rec = safeParse(await fetchTopic(chatTopic(chatId)), null);
  return rec && Array.isArray(rec.devices) ? rec : { active: null, devices: [] };
}

function saveChat(chatId, rec) {
  return publishAndWait(chatTopic(chatId), JSON.stringify(rec), { retain: true, prefix: PREFIX });
}

// "sem-a1b2c3 123456", "a1b2c3 123456" or the deep-link form "sem-a1b2c3_123456".
function parseLinkArg(arg) {
  const match = (arg || "").trim().match(/^(\S+?)[\s_]+(\d{6})$/);
  if (!match) return null;
  const deviceId = normalizeDeviceId(match[1]);
  return deviceId ? { deviceId, pin: match[2] } : null;
}

const LINK_HELP = [
  "Hubungkan alat dulu dengan ID dan PIN yang ada di label alat:",
  "/hubungkan <ID> <PIN>",
  "Contoh: /hubungkan sem-a1b2c3 123456",
  "",
  "ID juga tampil di layar OLED (halaman \"ID sem-...\").",
].join("\n");

async function handleLink(chatId, rec, arg) {
  if (!process.env.CONTROL_SECRET) {
    return "⚠️ Penautan alat belum aktif di server (CONTROL_SECRET belum diatur di Vercel).";
  }
  const parsed = parseLinkArg(arg);
  if (!parsed) return LINK_HELP;

  const check = await checkPin(parsed.deviceId, parsed.pin, PREFIX);
  if (!check.ok) {
    if (check.status === 401) return `❌ PIN salah untuk ${parsed.deviceId}. Sisa ${check.body.attemptsLeft} percobaan.`;
    if (check.status === 429) return `⛔ Terlalu banyak PIN salah untuk ${parsed.deviceId}. Coba lagi dalam ${Math.ceil(check.body.retryAfterSec / 60)} menit.`;
    return "⚠️ Gagal memeriksa PIN. Coba lagi.";
  }

  if (!rec.devices.includes(parsed.deviceId)) rec.devices.push(parsed.deviceId);
  rec.active = parsed.deviceId;
  await saveChat(chatId, rec);
  const others = rec.devices.length > 1 ? `\nChat ini terhubung ke ${rec.devices.length} alat. Ganti alat aktif dengan /perangkat.` : "";
  return `✅ Terhubung ke ${parsed.deviceId}. Notifikasi alat ini akan dikirim ke chat ini.${others}`;
}

function devicesKeyboard(rec) {
  return {
    inline_keyboard: rec.devices.map((id) => [{ text: id === rec.active ? `● ${id} (aktif)` : id, callback_data: `pakai ${id}` }]),
  };
}

function handleDevices(rec) {
  if (!rec.devices.length) return { text: LINK_HELP };
  return {
    text: [
      `Alat aktif: ${rec.active}`,
      "Tekan alat lain untuk menjadikannya aktif.",
      "/hubungkan <ID> <PIN> untuk menambah alat, /lepas untuk melepas alat aktif.",
    ].join("\n"),
    keyboard: devicesKeyboard(rec),
  };
}

async function handleUse(chatId, rec, arg) {
  const deviceId = normalizeDeviceId(arg);
  if (!deviceId || !rec.devices.includes(deviceId)) {
    return "Alat itu belum terhubung ke chat ini. Pakai /hubungkan <ID> <PIN> dulu.";
  }
  rec.active = deviceId;
  await saveChat(chatId, rec);
  return `✅ Alat aktif sekarang ${deviceId}.`;
}

async function handleUnlink(chatId, rec) {
  if (!rec.active) return LINK_HELP;
  const removed = rec.active;
  rec.devices = rec.devices.filter((id) => id !== removed);
  rec.active = rec.devices[0] || null;
  await saveChat(chatId, rec);
  return rec.active
    ? `🔓 ${removed} dilepas. Alat aktif sekarang ${rec.active}.`
    : `🔓 ${removed} dilepas. Chat ini tidak terhubung ke alat apa pun lagi.`;
}

// --- Device data ---

// Both topics are retained by the firmware, so a fresh subscribe gets the
// broker's last known values instantly. status is set via MQTT Last Will, so
// it reflects true online/offline even if the device dropped off
// ungracefully — data alone would otherwise look "live" forever since it
// just replays whatever was last published, however old that is.
async function fetchDeviceState(deviceId) {
  const statusTopic = topic(deviceId, "status");
  const dataTopic = topic(deviceId, "data");
  const values = await fetchRetained([statusTopic, dataTopic], { prefix: PREFIX });
  return { status: values[statusTopic], data: safeParse(values[dataTopic], null) };
}

// chipTemperature is deliberately absent when the ESP32's internal sensor
// isn't producing real readings, so callers must never fall back to 0.
function hasChipTemp(data) {
  return data.chipTemperature !== undefined && data.chipTemperature !== null && Number.isFinite(Number(data.chipTemperature));
}

function chipTempState(c) {
  return c >= 85 ? "terlalu panas" : c >= 70 ? "hangat" : "normal";
}

function statusText(data, deviceId) {
  return [
    `📊 Status ${deviceId}`,
    `Tegangan: ${num(data.voltage, 1)} V`,
    `Arus: ${num(data.current, 2)} A`,
    `Daya: ${num(data.power, 0)} W`,
    `Energi: ${num(data.energy, 3)} kWh`,
    `Frekuensi: ${num(data.frequency, 1)} Hz`,
    `Power factor: ${num(data.pf, 2)}`,
    `Batas daya: ${num(data.limit, 0)} W`,
    hasChipTemp(data) ? `Suhu Hardware: ${num(data.chipTemperature, 1)} °C (${chipTempState(Number(data.chipTemperature))})` : null,
    `Sensor PZEM: ${data.sensor ? "Online" : "Tidak terdeteksi"}`,
    `WiFi perangkat: ${data.wifi ? "Terhubung" : "Terputus"}`,
  ].filter(Boolean).join("\n");
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
  suhu: (data) => (hasChipTemp(data)
    ? `🌡️ Suhu Hardware: ${num(data.chipTemperature, 1)} °C (${chipTempState(Number(data.chipTemperature))})`
    : "🌡️ Suhu Hardware belum tersedia (perangkat belum mengirim pembacaan yang valid)."),
  temp: (data) => COMMANDS.suhu(data),
  chip: (data) => COMMANDS.suhu(data),
  status: statusText,
  limit: (data) => `🎚️ Batas daya saat ini: ${num(data.limit, 0)} Watt`,
};

// Tap-friendly menu for users who'd rather not memorise command names.
// callback_data is what comes back when a button is pressed — Telegram caps
// it at 64 bytes, and these are reused verbatim as "/<data>" so every button
// resolves through the exact same dispatch path as a typed command.
const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: "⚡ Daya", callback_data: "watt" }, { text: "🔋 Energi", callback_data: "kwh" }],
    [{ text: "🔌 Tegangan", callback_data: "volt" }, { text: "🔀 Arus", callback_data: "ampere" }],
    [{ text: "🌡️ Suhu", callback_data: "suhu" }, { text: "📐 Power Factor", callback_data: "pf" }],
    [{ text: "📊 Status Lengkap", callback_data: "status" }, { text: "🎚️ Batas Daya", callback_data: "limit" }],
    [{ text: "📈 Riwayat 7 Hari", callback_data: "riwayat" }, { text: "🔔 Pengingat", callback_data: "reminder" }],
    [{ text: "🔁 Ganti Alat", callback_data: "perangkat" }],
  ],
};

const HELP_TEXT = [
  "Halo! Saya bot Smart Energy Meter. Tekan tombol di bawah, atau ketik perintah:",
  "/watt - daya saat ini (Watt)",
  "/kwh - energi terpakai (kWh)",
  "/volt - tegangan (Volt)",
  "/ampere - arus (Ampere)",
  "/frekuensi - frekuensi (Hz)",
  "/pf - power factor",
  "/suhu - suhu hardware",
  "/limit - lihat batas daya saat ini",
  "/setlimit <angka> - ubah batas daya, contoh: /setlimit 500",
  "/status - semua data sekaligus",
  "/riwayat - grafik & rincian biaya 7 hari terakhir",
  "/reminder <tanggal> <pesan> - pengingat bayar listrik tiap bulan, contoh: /reminder 25 Jangan lupa bayar listrik!",
  "/reminder - lihat pengingat yang aktif",
  "/reminder off - matikan pengingat",
  "/tarif - lihat atau ganti golongan tarif PLN alat ini",
  "/perangkat - lihat & ganti alat aktif",
  "/hubungkan <ID> <PIN> - tambah alat",
  "/lepas - lepas alat aktif",
  "/menu - tampilkan tombol menu ini lagi",
  "",
  "Notifikasi otomatis (offline / kelebihan batas daya) dikirim ke chat yang terhubung ke alatnya.",
  "Atau tanya bebas juga bisa, misalnya \"berapa watt sekarang\".",
].join("\n");

// Renders the last 7 days of billing history (.../billing/daily, already
// computed by api/monitor.js) as a QuickChart bar chart. QuickChart takes
// the chart spec straight in the URL and Telegram fetches that URL itself
// for sendPhoto, so no image handling/hosting needed on our side.
async function handleHistory(deviceId) {
  const dailyData = safeParse(await fetchTopic(topic(deviceId, "billing/daily")), {});
  const wib = nowWIB();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(wib.getTime() - i * 24 * 60 * 60 * 1000);
    days.push({ label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, rp: Number(dailyData[dayKeyOf(d)] || 0) });
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
    `📊 Riwayat 7 Hari Terakhir (${deviceId})`,
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

async function handleReminder(deviceId, arg) {
  const reminderTopic = topic(deviceId, "telegram/reminder");
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
    await publishAndWait(reminderTopic, "", { retain: true, prefix: PREFIX });
    return "🔕 Pengingat pembayaran dimatikan.";
  }

  const parsed = parseReminderArg(trimmed);
  if (!parsed) {
    return "Format: /reminder <tanggal 1-28> <pesan>\nContoh: /reminder 25 Jangan lupa bayar listrik!\nAtau /reminder off untuk matikan.";
  }
  await publishAndWait(reminderTopic, JSON.stringify(parsed), { retain: true, prefix: PREFIX });
  return `✅ Pengingat diset: tanggal ${parsed.day} tiap bulan, jam ${REMINDER_HOUR_WIB}:00 WIB\nPesan: "${parsed.message}"`;
}

function rupiahPerKwh(rate) {
  return `Rp ${rate.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/kWh`;
}

const TARIFF_LIST = Tariffs.LIST.map((t) => `${t.code}: ${t.label}, ${rupiahPerKwh(t.rate)}`).join("\n");

// "/tarif" shows the active device's class, "/tarif R1-900" changes it. A linked
// chat already proved the PIN, same rule as /setlimit.
async function handleTariff(deviceId, arg) {
  const tariffTopic = topic(deviceId, "billing/tariff");
  if (!arg) {
    const current = Tariffs.fromPayload(await fetchTopic(tariffTopic));
    return [
      `💡 Golongan tarif ${deviceId}: ${current.label} (${rupiahPerKwh(current.rate)})`,
      "",
      "Ganti dengan /tarif <kode>, contoh: /tarif R1-900",
      TARIFF_LIST,
    ].join("\n");
  }
  const tariff = Tariffs.find(arg);
  if (!tariff) return `Kode tarif tidak dikenal. Pilih salah satu:\n${TARIFF_LIST}`;
  await publishAndWait(tariffTopic, JSON.stringify({ code: tariff.code, rate: tariff.rate }), { retain: true, prefix: PREFIX });
  return `✅ Golongan tarif ${deviceId} diubah ke ${tariff.label} (${rupiahPerKwh(tariff.rate)}). Berlaku untuk pemakaian mulai sekarang; tagihan hari-hari sebelumnya tidak berubah.`;
}

async function handleSetLimit(deviceId, arg) {
  const value = Number(arg);
  if (!arg || !Number.isFinite(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
    return `Format: /setlimit <angka>. Contoh: /setlimit 500\nBatas harus antara ${MIN_LIMIT}-${MAX_LIMIT} Watt.`;
  }
  try {
    await publishAndWait(topic(deviceId, "cmd/limit"), value, { prefix: PREFIX });
    return `✅ Batas daya ${deviceId} diubah ke ${value} Watt.`;
  } catch {
    return "⚠️ Gagal mengubah batas daya, perangkat mungkin sedang offline. Coba lagi.";
  }
}

// Parses "/setlimit@yusfikar_bot 500" -> { command: "setlimit", arg: "500" }.
function parseCommand(text) {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?\s*(.*)$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: match[2].trim() };
}

function formatReply(text, data, deviceId) {
  const parsed = parseCommand(text);
  if (parsed && COMMANDS[parsed.command]) return COMMANDS[parsed.command](data, deviceId);

  // Free-text fallback for natural-language questions.
  const t = text.toLowerCase();
  if (/\bkwh\b|energi/.test(t)) return COMMANDS.kwh(data);
  if (/\bwatt\b|\bdaya\b/.test(t)) return COMMANDS.watt(data);
  if (/\bvolt\b|tegangan/.test(t)) return COMMANDS.volt(data);
  if (/ampere|\barus\b/.test(t)) return COMMANDS.arus(data);
  if (/frekuensi|\bhz\b/.test(t)) return COMMANDS.frekuensi(data);
  if (/power ?factor|\bpf\b|faktor daya/.test(t)) return COMMANDS.pf(data);
  if (/suhu|temperatur|\bchip\b|prosesor/.test(t)) return COMMANDS.suhu(data);
  if (/batas|limit/.test(t)) return COMMANDS.limit(data);
  if (/status|semua|kondisi|\bcek\b/.test(t)) return COMMANDS.status(data, deviceId);

  return parsed
    ? `Perintah /${parsed.command} tidak dikenal. Kirim /help untuk lihat daftar perintah.`
    : 'Maaf, saya belum paham. Coba "/status" atau "/help" untuk lihat daftar perintah.';
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup) {
  const body = { chat_id: chatId, photo: photoUrl, caption };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Clears the loading spinner Telegram shows on a tapped button. It gives us
// only a few seconds to respond, so this fires before the slower MQTT
// round-trip — and a failure here must never block the actual reply.
async function answerCallbackQuery(callbackQueryId) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (err) {
    console.error("Failed to answer callback query:", err);
  }
}

// Shared by typed messages and inline-button taps — a button press arrives as
// "/<callback_data>", so both end up going through the same dispatch.
async function resolveReply(chatId, text) {
  const parsed = parseCommand(text);
  const command = parsed ? parsed.command : null;
  const rec = await loadChat(chatId);

  // A label's QR opens t.me/<bot>?start=<id>_<pin>, which arrives as "/start <id>_<pin>".
  if ((command === "start" && parsed.arg) || command === "hubungkan" || command === "link") {
    return { text: await handleLink(chatId, rec, parsed.arg), keyboard: rec.active ? MENU_KEYBOARD : undefined };
  }
  if (command === "perangkat" || command === "alat") return handleDevices(rec);
  if (command === "pakai") return { text: await handleUse(chatId, rec, parsed.arg) };
  if (command === "lepas") return { text: await handleUnlink(chatId, rec) };

  if (!rec.active) return { text: LINK_HELP };
  const deviceId = rec.active;

  if (command === "start" || command === "help" || command === "menu" || /bantuan|^menu$/i.test(text.trim())) {
    return { text: `${HELP_TEXT}\n\nAlat aktif: ${deviceId}`, keyboard: MENU_KEYBOARD };
  }
  if (command === "setlimit") {
    return { text: await handleSetLimit(deviceId, parsed.arg) };
  }
  if (command === "riwayat" || command === "history") {
    return await handleHistory(deviceId);
  }
  if (command === "reminder" || command === "pengingat") {
    return { text: await handleReminder(deviceId, parsed.arg) };
  }
  if (command === "tarif") {
    return { text: await handleTariff(deviceId, parsed.arg) };
  }

  const { status, data } = await fetchDeviceState(deviceId);
  if (status === "standby") {
    return { text: `⏸️ Pemantauan ${deviceId} sedang standby (sensor dimatikan dari dashboard). Nyalakan lagi dari dashboard web.` };
  }
  if (status !== "online" || !data) {
    return { text: `⚠️ ${deviceId} sedang offline atau datanya belum tersedia. Coba lagi setelah alat menyala.` };
  }
  return { text: formatReply(text, data, deviceId) };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(200).send("Telegram bot webhook is running.");
    return;
  }

  const body = req.body || {};
  const callback = body.callback_query;
  // A button tap has no text of its own — its command lives in callback_data,
  // and the chat it belongs to is the one the bot's own message was sent to.
  const message = callback ? callback.message : body.message;
  const text = callback ? `/${callback.data}` : (body.message && body.message.text);

  if (!message || !text) {
    res.status(200).json({ ok: true });
    return;
  }

  const chatId = message.chat.id;
  if (callback) await answerCallbackQuery(callback.id);

  let reply;
  try {
    reply = await resolveReply(chatId, text);
  } catch (err) {
    console.error("resolveReply failed:", err);
    reply = { text: "⚠️ Terjadi gangguan saat menghubungi broker. Coba lagi sebentar lagi." };
  }
  // Keep the menu attached whenever the user is already in the tap flow, so
  // they never have to fall back to typing to ask the next thing. Typed
  // commands keep their plain replies.
  const keyboard = reply.keyboard || (callback ? MENU_KEYBOARD : undefined);

  try {
    if (reply.photoUrl) await sendTelegramPhoto(chatId, reply.photoUrl, reply.text, keyboard);
    else await sendTelegramMessage(chatId, reply.text, keyboard);
  } catch (err) {
    console.error("Failed to send Telegram message:", err);
  }

  res.status(200).json({ ok: true });
};
