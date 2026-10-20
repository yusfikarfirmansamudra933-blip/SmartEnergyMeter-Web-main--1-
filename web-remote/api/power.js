const { normalizeDeviceId, topic, safeParse, publishAndWait } = require("../lib/devices");
const { authorizeControl } = require("../lib/authorize");

// Turns one meter's monitoring on or off (standby) from the cloud dashboard.
// The dashboard's own MQTT user is read-only and its credentials are public,
// so commands go through here instead: this function holds the bot user's
// credentials server-side and only publishes for a signed-in owner of the unit
// or after the unit's PIN checks out.
//
// The PIN path needs a CONTROL_SECRET environment variable in Vercel (see
// lib/devices.js for how each unit's PIN is derived from it). Without it only
// signed-in owners get through, never an open control.

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return safeParse(req.body, {});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Gunakan POST." });
    return;
  }
  const { device, action, pin } = readBody(req);
  const deviceId = normalizeDeviceId(device);
  if (!deviceId) {
    res.status(400).json({ error: "ID perangkat tidak valid." });
    return;
  }
  if (action !== "on" && action !== "off") {
    res.status(400).json({ error: "Perintah tidak dikenal." });
    return;
  }
  const check = await authorizeControl(req, deviceId, pin, "power");
  if (!check.ok) {
    res.status(check.status).json(check.body);
    return;
  }

  // Not retained: a retained "off" would put the device back into standby on
  // every reconnect, including right after a power cut.
  try {
    await publishAndWait(topic(deviceId, "cmd/power"), action, { prefix: "power" });
  } catch (err) {
    console.error("Failed to publish power command:", err);
    res.status(502).json({ error: "Gagal mengirim perintah ke broker." });
    return;
  }

  res.status(200).json({ ok: true, action });
};
