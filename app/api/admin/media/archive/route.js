import { isExportAuthorized } from "@/lib/adminAuth";
import { isConfigured, archiveVideo } from "@/lib/blobStore";

export const runtime = "nodejs";

// Called by the parallel sheet's Apps Script (apps-script/Incidents.gs)
// once it has copied a video into the "Occurrence Photos" Drive folder:
// the audit record now points at the Drive copy and the video is deleted
// from Blob storage, which keeps storage far below the plan's 1 GB (added
// 2026-11-10). Same `?key=` export key as the export route. Safe to call
// twice for the same video.
export async function POST(request) {
  if (!isExportAuthorized(request)) return new Response("Not authorized.", { status: 401 });
  if (!isConfigured()) return new Response("Blob storage isn't set up yet (missing BLOB_READ_WRITE_TOKEN).", { status: 503 });

  const body = await request.json().catch(() => null);
  const { auditId, url, driveUrl } = body || {};
  if (!/^[A-Za-z0-9-]+$/.test(auditId || "")
    || !/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/videos\//i.test(url || "")
    || !/^https:\/\/drive\.google\.com\//.test(driveUrl || "")) {
    return Response.json({ ok: false, code: "bad_request", message: "Need auditId, a Blob video url and a Drive url." }, { status: 400 });
  }
  try {
    return Response.json({ ok: true, ...(await archiveVideo(auditId, url, driveUrl)) });
  } catch (err) {
    console.error("archive failed", auditId, url, err);
    return Response.json({ ok: false, code: "upstream_error", message: err.message || "Could not archive the video." }, { status: 502 });
  }
}
