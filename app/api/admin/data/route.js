import { getSession, googleConfigured, exportKeyInfo } from "@/lib/adminAuth";
import { isConfigured, listAudits, findingsFrom } from "@/lib/blobStore";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request) {
  const user = getSession(request);
  if (!user) {
    return Response.json({ ok: false, googleConfigured: googleConfigured(), message: "Not authorized." }, { status: 401 });
  }
  const exportKey = exportKeyInfo();
  if (!isConfigured()) {
    return Response.json({ ok: false, user, exportKey, code: "not_configured", message: "Blob storage isn't set up yet (missing BLOB_READ_WRITE_TOKEN)." }, { status: 503 });
  }
  // A person looking at the admin page wants what's synced right now.
  const audits = await listAudits({ maxAgeMs: 0 });
  const findings = findingsFrom(audits);
  return Response.json({ ok: true, user, exportKey, audits, findings });
}
