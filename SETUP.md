# Waterjet Contact Form — Setup Guide

**Status: deployed and live.** The Edge Function is running on your Supabase
project (`qalamskqhayfimavldnf`), the database schema and private storage
buckets are created, and `waterjet-contact-form.html` is already configured
with your project's URL and anon key. You can embed it in WordPress now.

This form is built so that **no attachment is ever stored or accessible until
it has been scanned by VirusTotal and confirmed clean**. Files land in a
private "quarantine" bucket, get scanned server-side by a Supabase Edge
Function, and only move to a private "approved" bucket if the scan comes
back clean. The browser never talks to the database or storage directly —
only to the Edge Function.

## How submissions work (async scanning)

VirusTotal can take anywhere from a few seconds to a couple of minutes to
fully scan a file it hasn't seen before — too long for a visitor to sit and
wait on a web form. So the flow is split in two:

1. **Immediate (what the visitor waits for, ~1-3 seconds):** the form fields
   are validated, any attached files are uploaded straight into the private
   `design-files-quarantine` bucket, and a row is inserted into
   `contact_messages` with `file_1_scan_status` / `file_2_scan_status` set to
   `pending` (or `none` if no file was attached). The visitor immediately
   sees a success message.
2. **Background (invisible to the visitor, seconds to a few minutes later):**
   the Edge Function keeps running after the response was sent (via
   `EdgeRuntime.waitUntil`) and submits each file to VirusTotal:
   - **Clean** → file is moved to the private `design-files-approved`
     bucket, and the row's status flips to `clean`.
   - **Malicious/suspicious/scan error** → the file is deleted from
     quarantine, the row's status flips to `rejected`, and the event is
     recorded in the `file_scan_log` audit table. The file is never moved
     to the approved bucket and never becomes accessible to anyone.

Because of this, when you check the `contact_messages` table shortly after a
submission comes in, an attached file's status may briefly read `pending` —
give it a minute or two, then refresh.

## Files in this project

- `waterjet-contact-form.html` — the embeddable form (paste into WordPress). Already configured with live Supabase URL/anon key.
- `supabase/schema.sql` — original schema reference (kept for documentation; the applied version lives in `supabase/migrations/`).
- `supabase/migrations/` — the two migrations actually applied to your database via `supabase db push`.
- `supabase/functions/submit-contact-form/index.ts` — the deployed Edge Function.
- `.env` — your real credentials (already filled in). **Never commit this file or share it.**
- `.env.example` — safe template with placeholder values only.
- `.gitignore` — excludes `.env` if you ever put this project under git.

## Checking submissions

**Table Editor → `contact_messages`** in the Supabase Dashboard shows every
message. Columns of note:
- `file_1_scan_status` / `file_2_scan_status`: `none | pending | clean | rejected`
- `file_1_name` / `file_2_name`: original filename as uploaded
- `file_1_path` / `file_2_path`: storage path in `design-files-approved`, only populated once `clean`

**Table Editor → `file_scan_log`** shows every scan attempt, including
rejected/malicious files and their VirusTotal detection stats — useful if
you ever want to know *why* something was blocked.

**Downloading an approved file:** buckets are private by design, so there
are no public URLs. In the Supabase Dashboard, go to **Storage →
design-files-approved**, find the file, and use "Create signed URL" to get
a temporary (e.g. 1 hour) download link. Never make the bucket public.

## Re-deploying after a code change

If you ever edit `supabase/functions/submit-contact-form/index.ts`:

```bash
cd "path/to/WATERJET FORM"
$env:SUPABASE_ACCESS_TOKEN = "your-personal-access-token"   # PowerShell
npx -y supabase functions deploy submit-contact-form --no-verify-jwt
```

If you ever add a new migration file under `supabase/migrations/`:

```bash
npx -y supabase db push --linked --yes
```

(A personal access token can be generated at
https://supabase.com/dashboard/account/tokens — treat it like a password.)

## Embed in WordPress

Paste the entire contents of `waterjet-contact-form.html` into a
**Custom HTML** block (or the Code Editor view of the page/post). No further
edits are needed — it's already pointed at your live project.

## Test it yourself

1. Load the page, fill out the form, attach a small test file, solve the
   CAPTCHA, and submit.
2. You should see a success message within a couple of seconds.
3. In the Supabase Dashboard → Table Editor → `contact_messages`, find your
   row. `file_1_scan_status` will likely show `pending` at first — refresh
   after a minute or two to see it flip to `clean`.
4. Check **Storage → design-files-approved** to confirm the file arrived.

This was already verified end-to-end during setup, including confirming
that a deliberately malicious test file (the industry-standard EICAR test
string, flagged by 55 antivirus engines) was correctly rejected, deleted
from quarantine, and never reached the approved bucket or the visible
message record.

## How this avoids the "uploaded malware got the site hacked" scenario

- **Private buckets only.** Neither storage bucket is public, and the anon
  key has no storage policies granting it access. A malicious file can
  never be fetched as a URL, even by direct link guessing.
- **Scan before store.** Files are scanned in quarantine; nothing is moved
  to the approved bucket, and no status ever reads "clean," until
  VirusTotal returns a clean verdict.
- **Fail closed.** If the VirusTotal scan errors out or times out, the file
  is deleted and marked `rejected` rather than silently accepted unscanned.
- **Type and size allowlist.** Only design-file extensions
  (PDF/DXF/DWG/SVG/EPS/AI/STEP/ZIP/PNG/JPG) up to 25MB are accepted — no
  executables, scripts, or arbitrary file types.
- **No direct client writes.** The service_role key (the only credential
  that can write to storage/DB) lives solely in the Edge Function's runtime
  (auto-injected by Supabase) — it is never present in the WordPress page's
  HTML/JS, so it can't be extracted by viewing page source.
- **Full audit trail.** Every scan attempt — clean or rejected — is logged
  in `file_scan_log` with the VirusTotal detection stats, so nothing is
  silently lost and you can always see what was blocked and why.
- **Staff access via signed URLs only**, generated on demand from the
  Supabase Dashboard — never permanent public links.

## Optional next steps

- Lock down `Access-Control-Allow-Origin` in `index.ts` (currently `*`) to
  your actual WordPress domain once it's live, then redeploy.
- Add an email notification (e.g. via Resend or SendGrid) inside the Edge
  Function after a successful insert, or after a scan completes, so you get
  notified per submission instead of checking Supabase manually.
- Add simple rate-limiting (e.g. by IP, using a Supabase table) if spam
  becomes an issue despite the CAPTCHA and honeypot.
- Build a small internal staff dashboard (Supabase Auth + a protected page)
  to browse `contact_messages` and generate signed download URls without
  needing the Supabase Dashboard.
