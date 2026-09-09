const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// Triggered periodically by an external cron (cron-job.org, every few
// minutes — Vercel Hobby only allows daily cron, see README). Each tick,
// for every device registered in Supabase:
// 1. Computes daily/weekly billing totals from the device's cumulative
//    energy reading and stores them as retained MQTT state, shared by every
//    browser that opens bill.html.
// 2. Pushes Telegram alerts (to every chat linked to the device's owner —
//    see telegram_links) on offline/overload state CHANGES (dedup via
//    retained alert-state), plus a daily and weekly usage summary at a
//    fixed time, plus the owner's custom payment reminder if it's due.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Server-side only (service role key bypasses Row Level Security).
//
// Built lazily instead of at module load — createClient() throws
// synchronously if the env vars are missing, and doing that at import time
// would take down this whole function with an opaque stack trace instead
// of the clear JSON error module.exports below returns.
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

const REMINDER_HOUR_WIB = 8;
// No per-user rate setting exists (no UI for it) — this is the single
// source of truth now, matching the old client-side default in bill.js.
const ELECTRICITY_RATE = 1500;
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function topicsFor(deviceId) {
  return {
    data: `smartmeter/${deviceId}/data`,
    status: `smartmeter/${deviceId}/status`,
    alertState: `smartmeter/${deviceId}/telegram/alert_state`,
    summaryState: `smartmeter/${deviceId}/telegram/summary_state`,
    reminder: `smartmeter/${deviceId}/telegram/reminder`,
    reminderState: `smartmeter/${deviceId}/telegram/reminder_state`,
    billingDaily: `smartmeter/${deviceId}/billing/daily`,
    billingWeekly: `smartmeter/${deviceId}/billing/weekly`,
    billingDailyStart: `smartmeter/${deviceId}/billing/daily_start`,
    billingWeeklyStart: `smartmeter/${deviceId}/billing/weekly_start`,
  };
}

function connectBot() {
  return mqtt.connect(MQTT_WS_URL, {
    username: BOT_MQTT_USERNAME,
    password: BOT_MQTT_PASSWORD,
    clientId: "monitor-" + Math.random().toString(16).slice(2),
    connectTimeout: 4000,
  });
}

// Subscribes to several retained topics at once and resolves once each has
// produced a value or the timeout elapses (missing topics resolve as null).
function fetchRetained(topics, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const client = connectBot();
    const values = {};
    topics.forEach((t) => { values[t] = null; });

    const finish = () => {
      clearTimeout(timer);
      client.end(true);
      resolve(values);
    };

    const timer = setTimeout(finish, timeoutMs);

    client.on("connect", () => topics.forEach((t) => client.subscribe(t)));
    client.on("message", (topic, payload) => {
      values[topic] = payload.toString();
      if (topics.every((t) => values[t] !== null)) finish();
    });
    client.on("error", finish);
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
    client.on("error", (err) => { clearTimeout(timer); client.end(true); reject(err); });
  });
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function notifyAll(chatIds, text) {
  for (const chatId of chatIds) {
    try { await sendTelegramMessage(chatId, text); }
    catch (err) { console.error("sendTelegramMessage failed:", chatId, err); }
  }
}

function num(value, digits) { return Number(value || 0).toFixed(digits); }
function formatRupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0); }
function safeParse(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch { return fallback; } }

// WIB (UTC+7) wall-clock time as a Date whose getUTC* fields read as WIB —
// avoids depending on the serverless runtime's local timezone.
function nowWIB() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function dayKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
function monthKeyOf(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function weekOfMonth(d) { return Math.min(Math.floor((d.getUTCDate() - 1) / 7) + 1, 5); }

// Computes today's/this-week's usage from the device's cumulative energy
// counter and republishes the shared billing state if anything changed.
async function updateBilling(topics, energy, wib, values) {
  const dayKey = dayKeyOf(wib);
  const monthKey = monthKeyOf(wib);
  const week = weekOfMonth(wib);

  const dailyStart = safeParse(values[topics.billingDailyStart], {});
  const weeklyStart = safeParse(values[topics.billingWeeklyStart], {});
  const dailyData = safeParse(values[topics.billingDaily], {});
  const weeklyData = safeParse(values[topics.billingWeekly], {});
  let changed = false;

  if (dailyStart[dayKey] === undefined) { dailyStart[dayKey] = energy; changed = true; }
  let usedDaily = energy - dailyStart[dayKey];
  if (usedDaily < 0) { dailyStart[dayKey] = energy; usedDaily = 0; changed = true; }
  const dailyRp = usedDaily * ELECTRICITY_RATE;
  if (dailyData[dayKey] !== dailyRp) { dailyData[dayKey] = dailyRp; changed = true; }

  if (!weeklyStart[monthKey]) weeklyStart[monthKey] = {};
  if (weeklyStart[monthKey]["week" + week] === undefined) { weeklyStart[monthKey]["week" + week] = energy; changed = true; }
  let usedWeekly = energy - weeklyStart[monthKey]["week" + week];
  if (usedWeekly < 0) { weeklyStart[monthKey]["week" + week] = energy; usedWeekly = 0; changed = true; }
  if (!weeklyData[monthKey]) weeklyData[monthKey] = {};
  const weeklyRp = usedWeekly * ELECTRICITY_RATE;
  if (weeklyData[monthKey]["week" + week] !== weeklyRp) { weeklyData[monthKey]["week" + week] = weeklyRp; changed = true; }

  if (changed) {
    await Promise.all([
      publishAndWait(topics.billingDailyStart, JSON.stringify(dailyStart), { retain: true }),
      publishAndWait(topics.billingWeeklyStart, JSON.stringify(weeklyStart), { retain: true }),
      publishAndWait(topics.billingDaily, JSON.stringify(dailyData), { retain: true }),
      publishAndWait(topics.billingWeekly, JSON.stringify(weeklyData), { retain: true }),
    ]).catch((err) => console.error("Failed to save billing state:", err));
  }

  return { dailyData, weeklyData };
}

// Sends a once-a-day recap (21:00 WIB) and a once-a-week recap (Sunday
// 21:00 WIB), each guarded by a retained "already sent today" date so a
// 5-minute cron doesn't fire it more than once.
async function checkSummaries(chatIds, deviceName, wib, dailyData, weeklyData, summaryStateRaw, summaryStateTopic) {
  const state = safeParse(summaryStateRaw, {});
  const todayKey = dayKeyOf(wib);
  const hour = wib.getUTCHours();
  let changed = false;

  if (hour === 21 && state.lastDaily !== todayKey) {
    const rp = Number(dailyData[todayKey] || 0);
    const kwh = rp / ELECTRICITY_RATE;
    await notifyAll(chatIds, [
      `📋 Ringkasan Hari Ini — ${deviceName}`,
      `${wib.getUTCDate()} ${MONTH_NAMES[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`,
      `Energi: ${kwh.toFixed(3)} kWh`,
      `Estimasi biaya: ${formatRupiah(rp)}`,
    ].join("\n"));
    state.lastDaily = todayKey;
    changed = true;
  }

  if (wib.getUTCDay() === 0 && hour === 21 && state.lastWeekly !== todayKey) {
    const monthKey = monthKeyOf(wib);
    const week = weekOfMonth(wib);
    const rp = Number((weeklyData[monthKey] || {})["week" + week] || 0);
    const kwh = rp / ELECTRICITY_RATE;
    await notifyAll(chatIds, [
      `📅 Ringkasan Minggu Ini — ${deviceName}`,
      `Minggu ${week}, ${MONTH_NAMES[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`,
      `Energi: ${kwh.toFixed(3)} kWh`,
      `Estimasi biaya: ${formatRupiah(rp)}`,
    ].join("\n"));
    state.lastWeekly = todayKey;
    changed = true;
  }

  if (changed) {
    try { await publishAndWait(summaryStateTopic, JSON.stringify(state), { retain: true }); }
    catch (err) { console.error("Failed to save summary state:", err); }
  }
}

// User-set reminder (day-of-month + message, from the bot's /reminder
// command) fired once a month at a fixed hour, deduped the same way as
// checkSummaries: a retained "month already sent" marker.
async function checkReminder(chatIds, wib, reminderRaw, reminderStateRaw, reminderStateTopic) {
  const reminder = safeParse(reminderRaw, null);
  if (!reminder || !reminder.day || !reminder.message) return;

  const state = safeParse(reminderStateRaw, {});
  const monthKey = monthKeyOf(wib);
  if (wib.getUTCDate() !== reminder.day || wib.getUTCHours() !== REMINDER_HOUR_WIB || state.lastSent === monthKey) {
    return;
  }

  await notifyAll(chatIds, `🔔 Pengingat Pembayaran Listrik\n${reminder.message}`);
  state.lastSent = monthKey;
  try { await publishAndWait(reminderStateTopic, JSON.stringify(state), { retain: true }); }
  catch (err) { console.error("Failed to save reminder state:", err); }
}

async function processDevice(device, chatIds) {
  const topics = topicsFor(device.id);
  const values = await fetchRetained([
    topics.status, topics.data, topics.alertState, topics.summaryState,
    topics.billingDaily, topics.billingWeekly, topics.billingDailyStart, topics.billingWeeklyStart,
    topics.reminder, topics.reminderState,
  ]);

  const isOffline = values[topics.status] !== "online";
  let data = null;
  try { data = values[topics.data] ? JSON.parse(values[topics.data]) : null; } catch { /* ignore */ }

  // Billing history tracks regardless of whether anyone has linked a
  // Telegram chat yet — it's shared state for bill.html, not a notification.
  let dailyData = safeParse(values[topics.billingDaily], {});
  let weeklyData = safeParse(values[topics.billingWeekly], {});
  if (!isOffline && data && Number.isFinite(Number(data.energy))) {
    const billing = await updateBilling(topics, Number(data.energy), nowWIB(), values);
    dailyData = billing.dailyData;
    weeklyData = billing.weeklyData;
  }

  if (chatIds.length === 0) {
    return { deviceId: device.id, billingUpdated: !isOffline && !!data, skipped: "no linked telegram chat" };
  }

  let alertState = safeParse(values[topics.alertState], {});
  const newState = { ...alertState };
  let changed = false;
  const notifications = [];

  if (isOffline && !alertState.offline) {
    notifications.push(`🔴 ${device.name} offline / kehilangan koneksi.`);
    newState.offline = true;
    changed = true;
  } else if (!isOffline && alertState.offline) {
    notifications.push(`🟢 ${device.name} online kembali.`);
    newState.offline = false;
    changed = true;
  }

  if (!isOffline && data) {
    const overloaded = !!data.trip;
    if (overloaded && !alertState.overload) {
      notifications.push(`⚠️ ${device.name}: daya melebihi batas! ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = true;
      changed = true;
    } else if (!overloaded && alertState.overload) {
      notifications.push(`✅ ${device.name}: daya kembali normal: ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = false;
      changed = true;
    }
  }

  for (const text of notifications) {
    await notifyAll(chatIds, text);
  }

  if (changed) {
    try { await publishAndWait(topics.alertState, JSON.stringify(newState), { retain: true }); }
    catch (err) { console.error("Failed to save alert state:", err); }
  }

  try { await checkSummaries(chatIds, device.name, nowWIB(), dailyData, weeklyData, values[topics.summaryState], topics.summaryState); }
  catch (err) { console.error("checkSummaries failed:", err); }

  try { await checkReminder(chatIds, nowWIB(), values[topics.reminder], values[topics.reminderState], topics.reminderState); }
  catch (err) { console.error("checkReminder failed:", err); }

  return { deviceId: device.id, isOffline, notifications: notifications.length };
}

module.exports = async (req, res) => {
  let client;
  try {
    client = getSupabase();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
    return;
  }

  const { data: devices, error } = await client.from("devices").select("*");
  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  const results = [];
  for (const device of devices) {
    const { data: links } = await client
      .from("telegram_links")
      .select("chat_id")
      .eq("user_id", device.owner_user_id);
    const chatIds = (links || []).map((l) => l.chat_id);

    try {
      results.push(await processDevice(device, chatIds));
    } catch (err) {
      console.error(`processDevice failed for ${device.id}:`, err);
      results.push({ deviceId: device.id, error: err.message });
    }
  }

  res.status(200).json({ ok: true, devices: results });
};
