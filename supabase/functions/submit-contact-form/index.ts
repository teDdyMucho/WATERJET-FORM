// ============================================================
// Edge Function: submit-contact-form
// ------------------------------------------------------------
// Receives the waterjet contact form submission (fields + up to
// 2 files) as multipart/form-data.
//
// Flow:
//   1. Validate required fields (fast, synchronous).
//   2. Upload any files to a PRIVATE "quarantine" storage bucket
//      using the service_role key (browser never touches storage
//      directly).
//   3. Insert the contact_messages row immediately with scan
//      status "pending" (or "none" if no files) and respond to
//      the browser right away — the user does not wait for the
//      antivirus scan to finish.
//   4. In the background (via EdgeRuntime.waitUntil, after the
//      response has already been sent), submit each file to
//      VirusTotal and poll for a verdict:
//        - Clean  -> move file from quarantine to the private
//                    "approved" bucket, update scan status.
//        - Malicious/suspicious/error -> delete the file from
//                    quarantine, mark it "rejected", and log it
//                    in file_scan_log. It is NEVER moved to the
//                    approved bucket and never becomes visible
//                    to staff as a normal attachment.
//
// This avoids blocking the HTTP response on VirusTotal's queue,
// which can take 1-3 minutes for a file it hasn't seen before —
// well past Edge Function request time limits.
//
// Deploy:
//   supabase functions deploy submit-contact-form --no-verify-jwt
//
// Secrets required:
//   SUPABASE_URL              (auto-provided by the platform)
//   SUPABASE_SERVICE_ROLE_KEY (auto-provided by the platform)
//   VIRUSTOTAL_API_KEY        (set via `supabase secrets set`)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VIRUSTOTAL_API_KEY = Deno.env.get("VIRUSTOTAL_API_KEY")!;

const QUARANTINE_BUCKET = "design-files-quarantine";
const APPROVED_BUCKET = "design-files-approved";

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB (VirusTotal public API limit is 32MB)
const ALLOWED_EXTENSIONS = [
  ".pdf", ".dxf", ".dwg", ".svg", ".eps", ".ai",
  ".png", ".jpg", ".jpeg", ".step", ".stp", ".zip",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your WordPress domain once live
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function isValidEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function getExtension(filename: string) {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

async function sha256Hex(buf: ArrayBuffer) {
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function checkExistingReport(hash: string) {
  const resp = await fetch(`https://www.virustotal.com/api/v3/files/${hash}`, {
    headers: { "x-apikey": VIRUSTOTAL_API_KEY },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`VirusTotal lookup failed: ${resp.status}`);
  const data = await resp.json();
  return data?.data?.attributes?.last_analysis_stats ?? null;
}

async function scanWithVirusTotal(bytes: Uint8Array, filename: string) {
  const hash = await sha256Hex(bytes.buffer as ArrayBuffer);

  const existing = await checkExistingReport(hash);
  if (existing) {
    return existing;
  }

  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);

  const uploadResp = await fetch("https://www.virustotal.com/api/v3/files", {
    method: "POST",
    headers: { "x-apikey": VIRUSTOTAL_API_KEY },
    body: form,
  });
  if (!uploadResp.ok) {
    throw new Error(`VirusTotal upload failed: ${uploadResp.status}`);
  }
  const uploadData = await uploadResp.json();
  const analysisId = uploadData?.data?.id;
  if (!analysisId) throw new Error("VirusTotal did not return an analysis id");

  // Poll for the result. Runs in the background (post-response), so it's
  // safe to wait several minutes for a first-seen file's full scan.
  const maxAttempts = 40;
  const delayMs = 8000; // up to ~5.3 minutes total
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const analysisResp = await fetch(
      `https://www.virustotal.com/api/v3/analyses/${analysisId}`,
      { headers: { "x-apikey": VIRUSTOTAL_API_KEY } },
    );
    if (!analysisResp.ok) throw new Error(`VirusTotal analysis check failed: ${analysisResp.status}`);
    const analysisData = await analysisResp.json();
    const status = analysisData?.data?.attributes?.status;

    if (status === "completed") {
      return analysisData.data.attributes.stats;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error("VirusTotal scan timed out");
}

function isClean(stats: Record<string, number> | null) {
  if (!stats) return false;
  const malicious = stats.malicious ?? 0;
  const suspicious = stats.suspicious ?? 0;
  return malicious === 0 && suspicious === 0;
}

// Runs after the HTTP response has already been sent. Scans one file,
// then moves/deletes it and updates the DB row + audit log accordingly.
async function scanAndFinalizeFile(
  supabase: ReturnType<typeof createClient>,
  messageId: string,
  slot: 1 | 2,
  quarantinePath: string,
  originalName: string,
  bytes: Uint8Array,
) {
  const statusColumn = slot === 1 ? "file_1_scan_status" : "file_2_scan_status";
  const pathColumn = slot === 1 ? "file_1_path" : "file_2_path";

  try {
    const stats = await scanWithVirusTotal(bytes, originalName);

    if (!isClean(stats)) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([quarantinePath]);
      await supabase.from("contact_messages").update({
        [statusColumn]: "rejected",
        [pathColumn]: null,
      }).eq("id", messageId);
      await supabase.from("file_scan_log").insert({
        contact_message_id: messageId,
        file_name: originalName,
        quarantine_path: quarantinePath,
        status: "rejected",
        virustotal_stats: stats,
        detail: "File flagged by VirusTotal and was not delivered.",
      });
      return;
    }

    const approvedPath = `${crypto.randomUUID()}_${originalName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    const { error: moveErr } = await supabase.storage
      .from(QUARANTINE_BUCKET)
      .move(quarantinePath, approvedPath, { destinationBucket: APPROVED_BUCKET });

    if (moveErr) {
      throw new Error(`Approved move failed: ${moveErr.message}`);
    }

    await supabase.from("contact_messages").update({
      [statusColumn]: "clean",
      [pathColumn]: approvedPath,
    }).eq("id", messageId);
    await supabase.from("file_scan_log").insert({
      contact_message_id: messageId,
      file_name: originalName,
      quarantine_path: approvedPath,
      status: "clean",
      virustotal_stats: stats,
    });
  } catch (err) {
    // Fail closed: any scanning error results in the file being withheld,
    // never silently delivered unscanned.
    await supabase.storage.from(QUARANTINE_BUCKET).remove([quarantinePath]).catch(() => {});
    await supabase.from("contact_messages").update({
      [statusColumn]: "rejected",
      [pathColumn]: null,
    }).eq("id", messageId);
    await supabase.from("file_scan_log").insert({
      contact_message_id: messageId,
      file_name: originalName,
      quarantine_path: quarantinePath,
      status: "error",
      detail: (err as Error).message,
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const uploadedQuarantinePaths: string[] = [];

  try {
    const formData = await req.formData();

    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const email2 = String(formData.get("email2") ?? "").trim();
    const phone = String(formData.get("phone") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const honeypot = String(formData.get("website") ?? "").trim();

    // Honeypot: silently pretend success without doing any work.
    if (honeypot !== "") {
      return jsonResponse({ success: true });
    }

    if (!name || !isValidEmail(email) || email !== email2 || !message) {
      return jsonResponse({ error: "Missing or invalid required fields." }, 400);
    }

    const fileEntries = ["file1", "file2"]
      .map((key) => formData.get(key))
      .filter((f): f is File => f instanceof File && f.size > 0);

    for (const file of fileEntries) {
      if (file.size > MAX_FILE_BYTES) {
        return jsonResponse({ error: `File "${file.name}" exceeds the 25MB limit.` }, 400);
      }
      const ext = getExtension(file.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return jsonResponse(
          { error: `File type "${ext}" is not allowed for "${file.name}".` },
          400,
        );
      }
    }

    // Upload to quarantine synchronously (fast, just a storage write) so we
    // can be sure the bytes are safely persisted before responding.
    type PendingFile = { slot: 1 | 2; quarantinePath: string; originalName: string; bytes: Uint8Array };
    const pendingFiles: PendingFile[] = [];

    for (const [index, file] of fileEntries.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const quarantinePath = `${crypto.randomUUID()}_${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from(QUARANTINE_BUCKET)
        .upload(quarantinePath, bytes, {
          contentType: file.type || "application/octet-stream",
        });
      if (uploadErr) throw new Error(`Quarantine upload failed: ${uploadErr.message}`);

      uploadedQuarantinePaths.push(quarantinePath);
      pendingFiles.push({
        slot: (index + 1) as 1 | 2,
        quarantinePath,
        originalName: safeName,
        bytes,
      });
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("contact_messages")
      .insert({
        name,
        email,
        phone: phone || null,
        message,
        file_1_path: null,
        file_2_path: null,
        file_1_name: pendingFiles.find((f) => f.slot === 1)?.originalName ?? null,
        file_2_name: pendingFiles.find((f) => f.slot === 2)?.originalName ?? null,
        file_1_scan_status: pendingFiles.some((f) => f.slot === 1) ? "pending" : "none",
        file_2_scan_status: pendingFiles.some((f) => f.slot === 2) ? "pending" : "none",
      })
      .select("id")
      .single();

    if (insertErr) throw new Error(`Database insert failed: ${insertErr.message}`);

    // Kick off scanning in the background — the browser does not wait.
    for (const pf of pendingFiles) {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil(
        scanAndFinalizeFile(supabase, inserted.id, pf.slot, pf.quarantinePath, pf.originalName, pf.bytes),
      );
    }

    return jsonResponse({ success: true });
  } catch (err) {
    for (const path of uploadedQuarantinePaths) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
    }
    console.error(err);
    return jsonResponse({ error: "Something went wrong processing your submission. Please try again." }, 500);
  }
});
