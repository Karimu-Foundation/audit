import { handleUpload } from "@vercel/blob/client";
import { getAuditor } from "@/lib/auditorAuth";

export const runtime = "nodejs";

// Videos (added 2026-11-10) are too big for /api/sync's 4.5 MB request
// limit, so the phone uploads each one straight to Blob storage. This
// route only hands out the short-lived upload tokens: to signed-in staff,
// for paths under videos/{auditId}/ and video files up to 50 MB. The
// parallel sheet's Apps Script later moves each video to Google Drive
// (see app/api/admin/media/archive).
const VIDEO_PATH = /^videos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

export async function POST(request) {
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "Malformed request body." }, { status: 400 });

  // The upload-completed callback comes from Vercel Blob itself and is
  // checked by handleUpload(); token requests come from the phone.
  if (body.type === "blob.generate-client-token") {
    const user = await getAuditor(request);
    if (!user) return Response.json({ error: "Sign in again to sync." }, { status: 401 });
    if (user.role !== "staff") return Response.json({ error: "Only staff accounts can upload videos." }, { status: 403 });
    if (!VIDEO_PATH.test((body.payload && body.payload.pathname) || "")) return Response.json({ error: "Not a video path." }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!VIDEO_PATH.test(pathname)) throw new Error("Not a video path.");
        return {
          allowedContentTypes: ["video/*"],
          maximumSizeInBytes: 50 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: true,
        };
      },
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message || "Upload not allowed." }, { status: 400 });
  }
}
