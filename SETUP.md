# Waterjet Contact Form — Setup Guide

The form is a single static page (`index.html`) hosted on Netlify and
embedded into WordPress with an iframe. Submissions are handled by
**Netlify Forms**: Netlify stores each submission, including file
attachments, then runs a small function that POSTs it to an **n8n webhook**. The n8n workflow sends
the email to the business. There is no database or other backend to
keep running.

## Files

- `index.html` — the form. Netlify serves it and detects the form at deploy time.
- `waterjet-contact-form.html` — the snippet to paste into a WordPress **Custom HTML** block. It embeds the Netlify page in an iframe that resizes to fit.
- `netlify/functions/submission-created.js` — runs automatically after every non-spam submission and forwards it to n8n in the same JSON format the old setup used.
- `netlify.toml` — tells Netlify to publish the folder as-is (no build step) and where the function lives.

## One-time Netlify setup

1. **Deploy** this folder to the Netlify site (push to the connected Git repo, or drag the folder into Netlify's deploy page).
2. **Turn on form detection.** In the Netlify dashboard open the site, go to **Forms**, and click **Enable form detection**. Then trigger a new deploy so Netlify picks up the form. A form named `contact` should appear under Forms.
3. **Nothing to add under Form submission notifications.** The function already sends every submission to `https://primary-production-6722.up.railway.app/webhook/newlead-website-waterjet`. Adding an HTTP POST notification there too would send each lead twice. To point at a different webhook later, set `N8N_WEBHOOK_URL` under **Project configuration → Environment variables** and redeploy.
4. **Embed in WordPress.** Open `waterjet-contact-form.html`, replace `https://YOUR-SITE.netlify.app/` with the real Netlify URL, and paste the snippet into a Custom HTML block.

## What n8n receives

The same payload the old setup sent, so the existing n8n workflow works unchanged:

```json
{
  "event": "new_lead",
  "submittedAt": "2026-11-03T12:00:00.000Z",
  "subject": "New lead has entered through the website",
  "notificationEmail": "mail@waterjetnaturalcutting.com",
  "lead": { "name": "…", "email": "…", "phone": "… or null", "message": "…" },
  "attachments": [
    { "fileName": "design.pdf", "status": "unscanned", "downloadUrl": "https://…", "downloadLinkExpiresInDays": null }
  ]
}
```

Two values differ from before: attachment `status` is now `unscanned`
(it used to be `clean`), and `downloadLinkExpiresInDays` is `null`.

## Test it

Submit the live form with a small attachment. The email should arrive within a minute or two. If it doesn't, check two places. In Netlify, open **Forms → contact**: a submission flagged under **Spam submissions** does not trigger the webhook. In n8n, open the workflow's **Executions** to see whether the webhook fired and which step failed.

## Limits and trade-offs

- **Attachments:** at most 8MB combined per submission (a Netlify limit). The form blocks larger uploads before sending.
- **Allowed file types:** PDF, DXF, DWG, SVG, EPS, AI, STEP/STP, ZIP, PNG, JPG.
- **No virus scanning.** The previous Supabase setup scanned files with VirusTotal. Netlify does not. Treat attachments from unknown senders with normal caution.
- **Monthly submission and upload quotas** depend on the Netlify plan. Check the site's Forms usage page if traffic grows.
- **Spam protection:** a hidden honeypot field, the on-page code check, and Netlify's built-in spam filter.
