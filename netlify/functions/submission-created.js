// ============================================================
// Netlify event function: submission-created
// ------------------------------------------------------------
// Netlify runs this automatically after every verified (non-spam)
// Netlify Forms submission. It reshapes the submission into the
// same JSON payload the old Supabase Edge Function sent, then
// POSTs it to the existing n8n webhook, so the n8n workflow that
// sends the notification email keeps working unchanged.
//
// The n8n webhook URL below can be overridden without a code change
// by setting N8N_WEBHOOK_URL in Netlify > Project configuration >
// Environment variables (scope must include Functions).
// ============================================================

const DEFAULT_N8N_WEBHOOK_URL =
  "https://primary-production-6722.up.railway.app/webhook/newlead-website-waterjet";
const NOTIFICATION_EMAIL_TO = "mail@waterjetnaturalcutting.com";
const SUBJECT = "New lead has entered through the website";

// Netlify gives an uploaded file as an object ({ url, filename, ... }),
// or occasionally as a plain URL string. Normalise both.
function toAttachment(value) {
  if (!value) return null;
  const url = typeof value === "string" ? value : value.url;
  if (!url) return null;
  const fileName =
    (typeof value === "object" && (value.filename || value.name)) ||
    decodeURIComponent(url.split("?")[0].split("/").pop() || "attachment");
  return {
    fileName,
    // Files are no longer virus-scanned (that was done by Supabase + VirusTotal).
    status: "unscanned",
    downloadUrl: url,
    downloadLinkExpiresInDays: null,
  };
}

function buildPayload(submission) {
  const data = submission.data || {};
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  return {
    event: "new_lead",
    submittedAt: submission.created_at || new Date().toISOString(),
    subject: SUBJECT,
    notificationEmail: NOTIFICATION_EMAIL_TO,
    lead: {
      name: text(data.name),
      email: text(data.email),
      phone: text(data.phone) || null,
      message: text(data.message),
    },
    attachments: [data.file1, data.file2].map(toAttachment).filter(Boolean),
  };
}

exports.handler = async (event) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL || DEFAULT_N8N_WEBHOOK_URL;

  const { payload: submission } = JSON.parse(event.body || "{}");
  if (!submission) {
    console.error("No submission payload received.");
    return { statusCode: 400, body: "no payload" };
  }

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(submission)),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error(`n8n webhook call failed: ${resp.status} ${detail}`);
    return { statusCode: 502, body: "n8n webhook failed" };
  }

  return { statusCode: 200, body: "ok" };
};

exports.buildPayload = buildPayload;
