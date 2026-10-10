const crypto = require("crypto");
const mqtt = require("mqtt");

// Shared by every function in api/: device IDs, per-device PINs, topics and
// the bot user's MQTT connection.
const MQTT_WS_URL = "wss://l660c516.ala.eu-central-1.emqxsl.com:8084/mqtt";

// Firmware builds the ID from the chip MAC: "sem-" + 6 hex digits.
const DEVICE_RE = /^sem-[0-9a-f]{6}$/;

// Accepts "sem-a1b2c3", "SEM-A1B2C3" or just "a1b2c3". Returns null when the
// input cannot be a device ID.
function normalizeDeviceId(input) {
  const raw = String(input || "").trim().toLowerCase();
  const id = /^[0-9a-f]{6}$/.test(raw) ? `sem-${raw}` : raw;
  return DEVICE_RE.test(id) ? id : null;
}

function topic(deviceId, suffix) {
  return `smartmeter/${deviceId}/${suffix}`;
}

// Telegram chat -> linked devices. Outside every device's own subtree so a
// wildcard like smartmeter/+/telegram/# never picks it up as a device.
function chatTopic(chatId) {
  return `smartmeter/_bot/chat/${chatId}`;
}

// The PIN printed on each unit's label. Derived from the device ID with a
// server-side secret, so nothing has to be stored or configured per unit:
// knowing the ID (it is on the OLED and in every topic) is not enough to
// produce the PIN without CONTROL_SECRET.
function devicePin(deviceId) {
  // Trimmed so a stray newline from copy-paste into Vercel doesn't change every PIN.
  const secret = (process.env.CONTROL_SECRET || "").trim();
  if (!secret) return null;
  const digest = crypto.createHmac("sha256", secret).update(deviceId).digest();
  return String(digest.readUInt32BE(0) % 1000000).padStart(6, "0");
}

// Compares fixed-length digests so the time taken doesn't reveal how much
// of the PIN was right.
function pinMatches(deviceId, candidate) {
  const expected = devicePin(deviceId);
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(candidate)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function safeParse(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch { return fallback; } }

function connectBot(prefix) {
  return mqtt.connect(MQTT_WS_URL, {
    username: process.env.BOT_MQTT_USERNAME,
    password: process.env.BOT_MQTT_PASSWORD,
    clientId: `${prefix}-${Math.random().toString(16).slice(2)}`,
    connectTimeout: 4000,
  });
}

// Subscribes to exact topics and resolves once each has produced a value or
// the timeout elapses (missing topics resolve as null).
function fetchRetained(topics, { prefix = "bot", timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const client = connectBot(prefix);
    const values = {};
    topics.forEach((t) => { values[t] = null; });
    const finish = () => { clearTimeout(timer); client.end(true); resolve(values); };
    const timer = setTimeout(finish, timeoutMs);
    client.on("connect", () => client.subscribe(topics));
    client.on("message", (t, payload) => {
      if (!(t in values)) return;
      values[t] = payload.toString();
      if (topics.every((x) => values[x] !== null)) finish();
    });
    client.on("error", finish);
  });
}

// Wildcard subscriptions have no "all retained messages received" signal, so
// this waits until the broker has been quiet for quietMs (capped at maxMs).
// Resolves with { topic: payload } and the still-open client, so the caller
// can publish on the same connection.
function collectRetained(filters, { prefix = "bot", quietMs = 1200, maxMs = 7000 } = {}) {
  return new Promise((resolve) => {
    const client = connectBot(prefix);
    const values = {};
    let quiet;
    const finish = () => { clearTimeout(quiet); clearTimeout(cap); resolve({ values, client }); };
    const cap = setTimeout(finish, maxMs);
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); };
    client.on("connect", () => client.subscribe(filters, bump));
    client.on("message", (t, payload) => { values[t] = payload.toString(); bump(); });
    client.on("error", finish);
  });
}

function publishOn(client, t, message, { retain = false } = {}) {
  return new Promise((resolve, reject) => {
    client.publish(t, String(message), { retain, qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
}

function publishAndWait(t, message, { retain = false, prefix = "bot" } = {}) {
  return new Promise((resolve, reject) => {
    const client = connectBot(prefix);
    const timer = setTimeout(() => { client.end(true); reject(new Error("Timeout saat publish")); }, 4000);
    client.on("connect", () => {
      publishOn(client, t, message, { retain }).then(
        () => { clearTimeout(timer); client.end(true); resolve(); },
        (err) => { clearTimeout(timer); client.end(true); reject(err); },
      );
    });
    client.on("error", (err) => { clearTimeout(timer); client.end(true); reject(err); });
  });
}

// Wrong-PIN counter per device, shared by the dashboard control and Telegram
// pairing: 5 misses lock that device's PIN for 15 minutes.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Returns { ok: true } or { ok: false, status, body } ready to send back.
async function checkPin(deviceId, pin, prefix) {
  const lockTopic = topic(deviceId, "control/lockout");
  const lockRaw = (await fetchRetained([lockTopic], { prefix, timeoutMs: 2500 }))[lockTopic];
  const lock = safeParse(lockRaw, {});
  const now = Date.now();
  if (lock.until && lock.until > now) {
    return { ok: false, status: 429, body: { error: "Terlalu banyak PIN salah.", retryAfterSec: Math.ceil((lock.until - now) / 1000) } };
  }

  if (!pinMatches(deviceId, pin)) {
    const fails = (lock.until ? 0 : Number(lock.fails) || 0) + 1;
    const next = fails >= MAX_ATTEMPTS ? { fails: 0, until: now + LOCKOUT_MS } : { fails };
    try { await publishAndWait(lockTopic, JSON.stringify(next), { retain: true, prefix }); }
    catch (err) { console.error("Failed to save lockout state:", err); }
    return next.until
      ? { ok: false, status: 429, body: { error: "Terlalu banyak PIN salah.", retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) } }
      : { ok: false, status: 401, body: { error: "PIN salah.", attemptsLeft: MAX_ATTEMPTS - fails } };
  }

  // Also seeds the topic the first time: with nothing retained, every lookup
  // above would sit through its whole timeout before answering.
  if (lockRaw === null || lock.fails || lock.until) {
    try { await publishAndWait(lockTopic, JSON.stringify({}), { retain: true, prefix }); }
    catch (err) { console.error("Failed to reset lockout state:", err); }
  }
  return { ok: true };
}

module.exports = {
  DEVICE_RE, normalizeDeviceId, topic, chatTopic, devicePin, pinMatches, safeParse,
  connectBot, fetchRetained, collectRetained, publishOn, publishAndWait, checkPin,
};
