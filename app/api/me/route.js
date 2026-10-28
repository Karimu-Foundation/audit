import { publicUser, assignmentsFor } from "@/lib/accounts";
import { getAuditor } from "@/lib/auditorAuth";

export const runtime = "nodejs";

// The field app calls this whenever it's online to refresh who's signed
// in and which groups they're assigned (cached on the device for offline
// use). A 401 means the device has to sign in again.
export async function GET(request) {
  const user = await getAuditor(request);
  if (!user) return Response.json({ ok: false, code: "signed_out" }, { status: 401 });
  return Response.json({ ok: true, user: publicUser(user), assignments: await assignmentsFor(user.id) });
}
