const mqtt = require("mqtt");

// Triggered periodically by an external cron (cron-job.org, every few
// minutes — Vercel Hobby only allows daily cron, see README). Each tick:
// 1. Computes daily/weekly billing totals from the device's cumulative
//    energy reading and stores them as retained MQTT state, shared by every
//    browser that opens bill.html (previously each browser tracked its own
//    copy in localStorage, so history didn't follow you between devices).
// 2. Pushes Telegram alerts on offline/overload state CHANGES (dedup via
//    retained alert-state), plus a daily and weekly usage summary at a
//    fixed time.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TOPIC_DATA = "smartmeter/data";
const TOPIC_STATUS = "smartmeter/status";
const TOPIC_CHAT_ID = "smartmeter/telegram/chatid";
const TOPIC_ALERT_STATE = "smartmeter/telegram/alert_state";
const TOPIC_SUMMARY_STATE = "smartmeter/telegram/summary_state";
const TOPIC_BILLING_DAILY = "smartmeter/billing/daily";
const TOPIC_BILLING_WEEKLY = "smartmeter/billing/weekly";
const TOPIC_BILLING_DAILY_START = "smartmeter/billing/daily_start";
const TOPIC_BILLING_WEEKLY_START = "smartmeter/billing/weekly_start";

// No per-user rate setting exists (no UI for it) — this is the single
// source of truth now, matching the old client-side default in bill.js.
const ELECTRICITY_RATE = 1500;
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

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
async function updateBilling(energy, wib, values) {
  const dayKey = dayKeyOf(wib);
  const monthKey = monthKeyOf(wib);
  const week = weekOfMonth(wib);

  const dailyStart = safeParse(values[TOPIC_BILLING_DAILY_START], {});
  const weeklyStart = safeParse(values[TOPIC_BILLING_WEEKLY_START], {});
  const dailyData = safeParse(values[TOPIC_BILLING_DAILY], {});
  const weeklyData = safeParse(values[TOPIC_BILLING_WEEKLY], {});
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
      publishAndWait(TOPIC_BILLING_DAILY_START, JSON.stringify(dailyStart), { retain: true }),
      publishAndWait(TOPIC_BILLING_WEEKLY_START, JSON.stringify(weeklyStart), { retain: true }),
      publishAndWait(TOPIC_BILLING_DAILY, JSON.stringify(dailyData), { retain: true }),
      publishAndWait(TOPIC_BILLING_WEEKLY, JSON.stringify(weeklyData), { retain: true }),
    ]).catch((err) => console.error("Failed to save billing state:", err));
  }

  return { dailyData, weeklyData };
}

// Sends a once-a-day recap (21:00 WIB) and a once-a-week recap (Sunday
// 21:00 WIB), each guarded by a retained "already sent today" date so a
// 5-minute cron doesn't fire it more than once.
async function checkSummaries(chatId, wib, dailyData, weeklyData, summaryStateRaw) {
  const state = safeParse(summaryStateRaw, {});
  const todayKey = dayKeyOf(wib);
  const hour = wib.getUTCHours();
  let changed = false;

  if (hour === 21 && state.lastDaily !== todayKey) {
    const rp = Number(dailyData[todayKey] || 0);
    const kwh = rp / ELECTRICITY_RATE;
    await sendTelegramMessage(chatId, [
      "📋 Ringkasan Hari Ini",
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
    await sendTelegramMessage(chatId, [
      "📅 Ringkasan Minggu Ini",
      `Minggu ${week}, ${MONTH_NAMES[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`,
      `Energi: ${kwh.toFixed(3)} kWh`,
      `Estimasi biaya: ${formatRupiah(rp)}`,
    ].join("\n"));
    state.lastWeekly = todayKey;
    changed = true;
  }

  if (changed) {
    try { await publishAndWait(TOPIC_SUMMARY_STATE, JSON.stringify(state), { retain: true }); }
    catch (err) { console.error("Failed to save summary state:", err); }
  }
}

module.exports = async (req, res) => {
  const values = await fetchRetained([
    TOPIC_STATUS, TOPIC_DATA, TOPIC_CHAT_ID, TOPIC_ALERT_STATE, TOPIC_SUMMARY_STATE,
    TOPIC_BILLING_DAILY, TOPIC_BILLING_WEEKLY, TOPIC_BILLING_DAILY_START, TOPIC_BILLING_WEEKLY_START,
  ]);

  const isOffline = values[TOPIC_STATUS] !== "online";
  let data = null;
  try { data = values[TOPIC_DATA] ? JSON.parse(values[TOPIC_DATA]) : null; } catch { /* ignore */ }

  // Billing history tracks regardless of whether anyone has registered a
  // Telegram chat — it's shared state for bill.html, not a notification.
  let dailyData = safeParse(values[TOPIC_BILLING_DAILY], {});
  let weeklyData = safeParse(values[TOPIC_BILLING_WEEKLY], {});
  if (!isOffline && data && Number.isFinite(Number(data.energy))) {
    const billing = await updateBilling(Number(data.energy), nowWIB(), values);
    dailyData = billing.dailyData;
    weeklyData = billing.weeklyData;
  }

  const chatId = values[TOPIC_CHAT_ID];
  if (!chatId) {
    res.status(200).json({ ok: true, billingUpdated: !isOffline && !!data, skipped: "no chat id registered yet" });
    return;
  }

  let alertState = safeParse(values[TOPIC_ALERT_STATE], {});
  const newState = { ...alertState };
  let changed = false;
  const notifications = [];

  if (isOffline && !alertState.offline) {
    notifications.push("🔴 Smart Energy Meter offline / kehilangan koneksi.");
    newState.offline = true;
    changed = true;
  } else if (!isOffline && alertState.offline) {
    notifications.push("🟢 Smart Energy Meter online kembali.");
    newState.offline = false;
    changed = true;
  }

  if (!isOffline && data) {
    const overloaded = !!data.trip;
    if (overloaded && !alertState.overload) {
      notifications.push(`⚠️ Daya melebihi batas! ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = true;
      changed = true;
    } else if (!overloaded && alertState.overload) {
      notifications.push(`✅ Daya kembali normal: ${num(data.power, 0)} W (batas ${num(data.limit, 0)} W)`);
      newState.overload = false;
      changed = true;
    }
  }

  for (const text of notifications) {
    try { await sendTelegramMessage(chatId, text); } catch (err) { console.error("sendTelegramMessage failed:", err); }
  }

  if (changed) {
    try { await publishAndWait(TOPIC_ALERT_STATE, JSON.stringify(newState), { retain: true }); }
    catch (err) { console.error("Failed to save alert state:", err); }
  }

  try { await checkSummaries(chatId, nowWIB(), dailyData, weeklyData, values[TOPIC_SUMMARY_STATE]); }
  catch (err) { console.error("checkSummaries failed:", err); }

  res.status(200).json({ ok: true, isOffline, notifications: notifications.length });
};
