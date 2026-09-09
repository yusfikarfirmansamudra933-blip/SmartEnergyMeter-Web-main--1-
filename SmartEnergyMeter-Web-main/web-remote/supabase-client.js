"use strict";

// Supabase project URL + publishable (public) key. This key is *meant* to
// be public — same trust model as the read-only MQTT credentials in
// script.js — access control comes from Row Level Security policies (see
// supabase/schema.sql), not from keeping this key secret. Never put the
// project's secret key (sb_secret_...) here or anywhere client-side.
const SUPABASE_URL = "https://omrjqsolejpxiduogzfn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_OX599tu6WNtPPHZrhAkaKQ_JK9SQtkG";

// Pages that need this include the Supabase UMD build before this script:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
// <script src="supabase-client.js"></script>
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Redirects to login.html if nobody's signed in; otherwise resolves with
// the active session. Call this at the top of any page that requires auth.
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    location.href = "login.html";
    return null;
  }
  return session;
}
