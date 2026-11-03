# Waterjet Contact Form — Setup Guide

The form is a single static page (`index.html`) hosted on Netlify and
embedded into WordPress with an iframe. When a visitor submits, the page
posts the fields **and the attached files** straight to an n8n webhook.
n8n emails the lead to `mail@waterjetnaturalcutting.com` with the files
attached. There is no database or other backend.

## Files

- `index.html` — the form. The webhook address is set near the top of its script (`N8N_WEBHOOK_URL`).
- `waterjet-contact-form.html` — the snippet to paste into a WordPress **Custom HTML** block. It embeds the Netlify page in an iframe that resizes to fit.
- `n8n-workflow.json` — the n8n workflow (Webhook → Send Email). Import it into n8n to replace the existing workflow.
- `netlify.toml` — tells Netlify to publish the folder as-is (no build step).

## One-time setup

1. **Update the n8n workflow.** In n8n, open the existing *newlead-website-waterjet* workflow, select all nodes and delete them, then paste the contents of `n8n-workflow.json` onto the canvas. Check that **Send an Email** still uses the *water jet smtp* credential, save, and make sure the workflow is **Active**.
2. **Deploy** this folder to Netlify (push to GitHub).
3. **Netlify Forms is not used.** No form notifications are needed in Netlify, and form detection can be switched off.
4. **Embed in WordPress.** In `waterjet-contact-form.html`, replace `https://YOUR-SITE.netlify.app/` with the real Netlify URL and paste the snippet into a Custom HTML block.

## What the form sends

A `multipart/form-data` POST with these fields:

| Field | Value |
|---|---|
| `subject` | New lead has entered through the website |
| `name`, `email`, `phone`, `message` | what the visitor typed (phone may be empty) |
| `file1`, `file2` | the attached files, only present when chosen |

In n8n the text fields appear under `$json.body` and the files as binary
data named `file1` and `file2`. The email node attaches both and sets
reply-to to the visitor's email.

The webhook replies only after the email is sent. If sending fails, the
visitor sees an error and can try again instead of a false "sent" message.

## Test it

Submit the live form with a small attachment. The email should arrive
within a minute with the file attached. If it doesn't, open the
workflow's **Executions** in n8n to see which step failed.

## Limits and trade-offs

- **Attachments:** at most 10MB combined, to stay under mail-server and n8n upload limits. The form blocks larger uploads before sending.
- **Allowed file types:** PDF, DXF, DWG, SVG, EPS, AI, STEP/STP, ZIP, PNG, JPG.
- **No virus scanning.** Treat attachments from unknown senders with normal caution.
- **Spam protection** is only the hidden honeypot field and the on-page code check. The webhook address is visible in the page source, so a determined bot could post to it directly.
