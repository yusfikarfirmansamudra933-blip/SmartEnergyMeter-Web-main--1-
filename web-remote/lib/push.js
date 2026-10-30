const webpush = require("web-push");
const db = require("./supabase");

// Web push to the admin's phones (SEM Admin app or admin.html in a browser).
// Subscriptions live in admin_push_subscriptions, which only the server can
// read. Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Vercel.

function adminEmails() {
  return (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isAdminEmail(email) {
  return !!email && adminEmails().includes(email.toLowerCase());
}

function pushEnabled() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && db.enabled());
}

function vapidPublicKey() {
  return (process.env.VAPID_PUBLIC_KEY || "").trim() || null;
}

async function saveSubscription(userId, sub) {
  const keys = (sub && sub.keys) || {};
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !keys.p256dh || !keys.auth) return false;
  await db.upsert("admin_push_subscriptions", [{ endpoint: sub.endpoint, user_id: userId, p256dh: keys.p256dh, auth: keys.auth }], "endpoint");
  return true;
}

function removeSubscription(userId, endpoint) {
  return db.rest(`admin_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE" });
}

// Sends one notification to every subscription of a current admin (an email
// removed from ADMIN_EMAILS stops receiving at once). Subscriptions the push
// service reports as gone (404/410) are deleted. Returns how many went out.
async function sendToAdmins({ title, body, tag, url = "admin.html" }, { userId } = {}) {
  if (!pushEnabled()) return 0;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", vapidPublicKey(), process.env.VAPID_PRIVATE_KEY.trim());

  const [subs, users] = await Promise.all([
    db.rest(`admin_push_subscriptions?select=endpoint,user_id,p256dh,auth${userId ? `&user_id=eq.${encodeURIComponent(userId)}` : ""}`),
    db.listUsers(),
  ]);
  const admins = new Set(users.filter((u) => isAdminEmail(u.email)).map((u) => u.id));
  const payload = JSON.stringify({ title, body, tag, url });

  let sent = 0;
  await Promise.all((subs || []).filter((s) => admins.has(s.user_id)).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 60 * 60 });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.rest(`admin_push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" }).catch(() => {});
      } else {
        console.error("Push failed:", err.statusCode || err.message);
      }
    }
  }));
  return sent;
}

module.exports = { adminEmails, isAdminEmail, pushEnabled, vapidPublicKey, saveSubscription, removeSubscription, sendToAdmins };
