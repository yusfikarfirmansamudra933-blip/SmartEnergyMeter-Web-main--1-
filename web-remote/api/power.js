const crypto = require("crypto");
const mqtt = require("mqtt");

// Turns the meter's monitoring on or off (standby) from the cloud dashboard.
// The dashboard's own MQTT user is read-only and its credentials are public,
// so commands go through here instead: this function holds the bot user's
// credentials server-side and only publishes after the PIN checks out.
//
// Needs a CONTROL_PIN environment variable in Vercel. Without it the endpoint
// refuses every request rather than falling back to an open control.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";
const BOT_MQTT_USERNAME = process.env.BOT_MQTT_USERNAME;
const BOT_MQTT_PASSWORD = process.env.BOT_MQTT_PASSWORD;
const CONTROL_PIN = process.env.CONTROL_PIN;

const TOPIC_POWER_CMD = "smartmeter/cmd/power";
// Failed-attempt counter shared by every function instance. Kept under
// telegram/# because the bot user can already read and write there.
const TOPIC_LOCKOUT = "smartmeter/telegram/control_lockout";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function connectBot() {
  return mqtt.connect(MQTT_WS_URL, {
    username: BOT_MQTT_USERNAME,
    password: BOT_MQTT_PASSWORD,
    clientId: "power-" + Math.random().toString(16).slice(2),
    connectTimeout: 4000,
  });
}

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

function safeParse(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch { return fallback; } }

// Compares fixed-length digests so the time taken doesn't reveal how much
// of the PIN was right.
function pinMatches(candidate) {
  const a = crypto.createHash("sha256").update(String(candidate)).digest();
  const b = crypto.createHash("sha256").update(String(CONTROL_PIN)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return safeParse(req.body, {});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Gunakan POST." });
    return;
  }
  if (!CONTROL_PIN) {
    res.status(503).json({ error: "Kontrol belum diaktifkan. Tambahkan CONTROL_PIN di pengaturan Vercel." });
    return;
  }

  const { action, pin } = readBody(req);
  if (action !== "on" && action !== "off") {
    res.status(400).json({ error: "Perintah tidak dikenal." });
    return;
  }
  if (!pin) {
    res.status(400).json({ error: "Masukkan PIN." });
    return;
  }

  const lockRaw = await fetchTopic(TOPIC_LOCKOUT, 2500);
  const lock = safeParse(lockRaw, {});
  const now = Date.now();
  if (lock.until && lock.until > now) {
    res.status(429).json({ error: "Terlalu banyak PIN salah.", retryAfterSec: Math.ceil((lock.until - now) / 1000) });
    return;
  }

  if (!pinMatches(pin)) {
    const fails = (lock.until ? 0 : Number(lock.fails) || 0) + 1;
    const next = fails >= MAX_ATTEMPTS ? { fails: 0, until: now + LOCKOUT_MS } : { fails };
    try { await publishAndWait(TOPIC_LOCKOUT, JSON.stringify(next), { retain: true }); }
    catch (err) { console.error("Failed to save lockout state:", err); }
    if (next.until) {
      res.status(429).json({ error: "Terlalu banyak PIN salah.", retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) });
    } else {
      res.status(401).json({ error: "PIN salah.", attemptsLeft: MAX_ATTEMPTS - fails });
    }
    return;
  }

  // Also seeds the topic the first time: with nothing retained, every lookup
  // above would sit through its whole timeout before answering.
  if (lockRaw === null || lock.fails || lock.until) {
    try { await publishAndWait(TOPIC_LOCKOUT, JSON.stringify({}), { retain: true }); }
    catch (err) { console.error("Failed to reset lockout state:", err); }
  }

  // Not retained: a retained "off" would put the device back into standby on
  // every reconnect, including right after a power cut.
  try {
    await publishAndWait(TOPIC_POWER_CMD, action);
  } catch (err) {
    console.error("Failed to publish power command:", err);
    res.status(502).json({ error: "Gagal mengirim perintah ke broker." });
    return;
  }

  res.status(200).json({ ok: true, action });
};
