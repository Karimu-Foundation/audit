import { isConfigured, listAudits } from "@/lib/blobStore";
import { getAuditor } from "@/lib/auditorAuth";
import { openIncidents } from "@/lib/incidents";

export const runtime = "nodejs";
export const maxDuration = 60;

// The water issues still waiting for a validation visit (added 2026-11-06),
// for the field app's "Validate fixes" screens. Staff only: volunteers
// don't do validation visits. The phone keeps the list for working offline
// and refreshes it whenever it's online.
export async function GET(request) {
  const user = await getAuditor(request);
  if (!user) return Response.json({ ok: false, code: "signed_out" }, { status: 401 });
  if (user.role !== "staff") return Response.json({ ok: false, code: "forbidden" }, { status: 403 });
  if (!isConfigured()) return Response.json({ ok: false, code: "not_configured" }, { status: 503 });
  return Response.json({ ok: true, incidents: openIncidents(await listAudits()) });
}
