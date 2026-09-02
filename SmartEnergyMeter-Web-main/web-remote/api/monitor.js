const mqtt = require("mqtt");

// Triggered periodically by Vercel Cron (see vercel.json). Checks the
// device's last known status/data and pushes a Telegram alert on state
// CHANGES only (dedup via the retained alert-state topic) — not every tick.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TOPIC_DATA = "smartmeter/data";
const TOPIC_STATUS = "smartmeter/status";
const TOPIC_CHAT_ID = "smartmeter/telegram/chatid";
const TOPIC_ALERT_STATE = "smartmeter/telegram/alert_state";

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
function fetchRetained(topics, timeoutMs = 5000) {
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

function num(value, digits) {
  return Number(value || 0).toFixed(digits);
}

module.exports = async (req, res) => {
  const values = await fetchRetained([TOPIC_STATUS, TOPIC_DATA, TOPIC_CHAT_ID, TOPIC_ALERT_STATE]);

  const chatId = values[TOPIC_CHAT_ID];
  if (!chatId) {
    res.status(200).json({ ok: true, skipped: "no chat id registered yet" });
    return;
  }

  let data = null;
  try { data = values[TOPIC_DATA] ? JSON.parse(values[TOPIC_DATA]) : null; } catch { /* ignore */ }

  let alertState = {};
  try { alertState = values[TOPIC_ALERT_STATE] ? JSON.parse(values[TOPIC_ALERT_STATE]) : {}; } catch { /* ignore */ }

  const isOffline = values[TOPIC_STATUS] !== "online";
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

  res.status(200).json({ ok: true, isOffline, notifications: notifications.length });
};
