const { normalizeDeviceId, topic, safeParse, publishAndWait, checkPin } = require("../lib/devices");
const Tariffs = require("../tariffs");

// Sets one meter's PLN tariff class from the bill page. Same guard as
// api/power.js: the browser's MQTT user is read-only and public, so the write
// happens here with the bot user, after that unit's PIN checks out.

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return safeParse(req.body, {});
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Gunakan POST." });
    return;
  }
  if (!process.env.CONTROL_SECRET) {
    res.status(503).json({ error: "Kontrol belum diaktifkan. Tambahkan CONTROL_SECRET di pengaturan Vercel." });
    return;
  }

  const { device, code, pin } = readBody(req);
  const deviceId = normalizeDeviceId(device);
  const tariff = Tariffs.find(code);
  if (!deviceId) {
    res.status(400).json({ error: "ID perangkat tidak valid." });
    return;
  }
  if (!tariff) {
    res.status(400).json({ error: "Golongan tarif tidak dikenal." });
    return;
  }
  if (!pin) {
    res.status(400).json({ error: "Masukkan PIN." });
    return;
  }

  const check = await checkPin(deviceId, pin, "tariff");
  if (!check.ok) {
    res.status(check.status).json(check.body);
    return;
  }

  // Retained: the firmware (OLED bill page), the cron and every open bill page
  // all read the current class from here.
  try {
    await publishAndWait(topic(deviceId, "billing/tariff"), JSON.stringify({ code: tariff.code, rate: tariff.rate }), { retain: true, prefix: "tariff" });
  } catch (err) {
    console.error("Failed to publish tariff:", err);
    res.status(502).json({ error: "Gagal menyimpan ke broker." });
    return;
  }

  res.status(200).json({ ok: true, code: tariff.code, rate: tariff.rate });
};
