import { isAuthorized } from "@/lib/adminAuth";
import { isConfigured, deleteAll } from "@/lib/blobStore";

export const runtime = "nodejs";
export const maxDuration = 60;

// Wipes every synced audit and photo from Blob storage — for clearing out
// test data before a real testing round or the mission itself starts.
// POST-only (and password-gated, same as the rest of /api/admin) since
// this is destructive and has no undo.
export async function POST(request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, message: "Not authorized." }, { status: 401 });
  }
  if (!isConfigured()) {
    return Response.json({ ok: false, code: "not_configured", message: "Blob storage isn't set up yet (missing BLOB_READ_WRITE_TOKEN)." }, { status: 503 });
  }
  const { deleted } = await deleteAll();
  return Response.json({ ok: true, deleted });
}
