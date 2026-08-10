-- ============================================================
-- Waterjet Contact Form — Supabase schema
-- ------------------------------------------------------------
-- Run this once in the Supabase Dashboard: SQL Editor > New query.
-- ============================================================

-- 1. Contact messages table -------------------------------------------------

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  message text not null,
  file_1_path text,
  file_2_path text,
  file_1_scan_status text default 'none',  -- none | clean (rejected files never get inserted)
  file_2_scan_status text default 'none',
  created_at timestamptz not null default now()
);

alter table contact_messages enable row level security;

-- No client-side policies are created here on purpose: inserts happen
-- ONLY through the Edge Function using the service_role key, which
-- bypasses RLS. This means the anon/public key can never write directly
-- to this table, and can never read it either (no select policy).


-- 2. Storage buckets ---------------------------------------------------------

-- Quarantine bucket: uploads land here first, PRIVATE, never public.
insert into storage.buckets (id, name, public)
values ('design-files-quarantine', 'design-files-quarantine', false)
on conflict (id) do nothing;

-- Approved bucket: files are moved here only after a clean VirusTotal scan.
-- Still private — staff view/download via signed URLs, not public links.
insert into storage.buckets (id, name, public)
values ('design-files-approved', 'design-files-approved', false)
on conflict (id) do nothing;

-- No storage policies are created for the anon role on either bucket.
-- All uploads, scanning, and moves happen server-side in the Edge Function
-- using the service_role key, which bypasses storage RLS entirely.
-- This means a browser can NEVER write to or read from these buckets
-- directly — only through the scanning Edge Function.


-- 3. Helper view for staff (optional) ---------------------------------------
-- Query this from the Supabase dashboard/table editor while signed in
-- as an authenticated staff user, or via service_role key in an internal tool.
-- (Left as a plain table select — add an "authenticated" policy here later
-- if you build a staff dashboard with Supabase Auth logins.)
