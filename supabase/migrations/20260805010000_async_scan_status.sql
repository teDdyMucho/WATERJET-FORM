-- ============================================================
-- Waterjet Contact Form — async scan status support
-- ------------------------------------------------------------
-- File scanning now happens in the background after the message
-- row is inserted, so status starts as "pending" and is updated
-- once VirusTotal returns a verdict.
-- ============================================================

alter table contact_messages
  alter column file_1_scan_status set default 'none',
  alter column file_2_scan_status set default 'none';

-- Original file names, kept for staff visibility (paths are randomized UUIDs).
alter table contact_messages add column if not exists file_1_name text;
alter table contact_messages add column if not exists file_2_name text;

comment on column contact_messages.file_1_scan_status is
  'none | pending | clean | rejected';
comment on column contact_messages.file_2_scan_status is
  'none | pending | clean | rejected';

-- Audit trail: every file scan attempt, including rejected/malicious ones,
-- so nothing silently disappears without a record staff can review.
create table if not exists file_scan_log (
  id uuid primary key default gen_random_uuid(),
  contact_message_id uuid references contact_messages(id) on delete set null,
  file_name text not null,
  quarantine_path text,
  status text not null, -- clean | rejected | error
  virustotal_stats jsonb,
  detail text,
  created_at timestamptz not null default now()
);

alter table file_scan_log enable row level security;
-- No client-facing policies: written only by the Edge Function via service_role.
