-- Smart Energy Meter — multi-device/multi-user schema (Phase 1).
--
-- Run once in the Supabase project's SQL editor after creating the
-- project (Database > SQL Editor > New query > paste this whole file > Run).
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / OR REPLACE).
--
-- User accounts themselves live in Supabase's built-in `auth.users` table
-- (managed by Supabase Auth via magic-link email sign-in) — no separate
-- users table needed here, everything below just references auth.users(id).

-- One row per physical ESP32. `id` is meant to be a short, stable device
-- identifier (Phase 3: derived from the chip's MAC address) — for now,
-- while firmware pairing doesn't exist yet, rows are created manually or
-- via devices.html with a hand-picked id.
create table if not exists public.devices (
  id text primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Smart Energy Meter',
  -- Once Phase 2 namespaces MQTT topics per device (smartmeter/<id>/...),
  -- this is what the dashboard/bot use to build topic names. Left as a
  -- plain column rather than derived-from-id so a device can be renamed on
  -- the broker side without changing its primary key.
  mqtt_topic_prefix text not null,
  power_limit numeric not null default 700,
  created_at timestamptz not null default now()
);

create index if not exists devices_owner_idx on public.devices (owner_user_id);

-- Maps a Telegram chat to the account it's linked to. Replaces the old
-- single retained MQTT topic (smartmeter/telegram/chatid), which could
-- only ever remember one chat for the whole system.
create table if not exists public.telegram_links (
  chat_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);

create index if not exists telegram_links_user_idx on public.telegram_links (user_id);

-- Short-lived codes for linking a Telegram chat to an account: devices.html
-- inserts one (RLS-scoped to the signed-in user), the user sends it to the
-- bot as "/link <code>", and api/telegram.js (server-side, service role
-- key) resolves it into a telegram_links row and deletes the code. Treated
-- as expired after 15 minutes regardless of whether it's been deleted yet
-- (checked at lookup time in code, not enforced here) — no scheduled
-- cleanup job, stale rows are harmless since the id space isn't reused
-- while accepting a fresh insert per "Hubungkan Telegram" click.
create table if not exists public.telegram_link_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Billing history, one row per device per day/week — replaces the old
-- smartmeter/billing/* retained MQTT topics (which held every device's
-- history in one shared JSON blob; fine for one device, not for many).
create table if not exists public.billing_daily (
  device_id text not null references public.devices(id) on delete cascade,
  day date not null,
  amount_rp numeric not null default 0,
  primary key (device_id, day)
);

create table if not exists public.billing_weekly (
  device_id text not null references public.devices(id) on delete cascade,
  month text not null,   -- "YYYY-MM"
  week smallint not null check (week between 1 and 5),
  amount_rp numeric not null default 0,
  primary key (device_id, month, week)
);

-- Row Level Security: a signed-in user can only ever see/change their own
-- rows. The dashboard and login pages talk to Supabase directly with the
-- public "anon" key (same trust model as the read-only MQTT credentials
-- already embedded in script.js) — RLS is what keeps that safe, not
-- keeping the key secret.
alter table public.devices enable row level security;
alter table public.telegram_links enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.billing_daily enable row level security;
alter table public.billing_weekly enable row level security;

drop policy if exists devices_owner_all on public.devices;
create policy devices_owner_all on public.devices
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists telegram_links_owner_all on public.telegram_links;
create policy telegram_links_owner_all on public.telegram_links
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists telegram_link_codes_owner_all on public.telegram_link_codes;
create policy telegram_link_codes_owner_all on public.telegram_link_codes
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Billing rows are written server-side only (api/monitor.js's cron, via the
-- service role key, which bypasses RLS entirely) — the client only ever
-- needs to read them, so these are select-only policies.
drop policy if exists billing_daily_owner_select on public.billing_daily;
create policy billing_daily_owner_select on public.billing_daily
  for select
  using (device_id in (select id from public.devices where owner_user_id = auth.uid()));

drop policy if exists billing_weekly_owner_select on public.billing_weekly;
create policy billing_weekly_owner_select on public.billing_weekly
  for select
  using (device_id in (select id from public.devices where owner_user_id = auth.uid()));
