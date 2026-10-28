import { accountsConfigured, verifyLogin, publicUser, assignmentsFor } from "@/lib/accounts";
import { auditorToken } from "@/lib/auditorAuth";

export const runtime = "nodejs";

// Field-app sign-in: email + password -> a long-lived device token (see
// lib/auditorAuth.js) plus the auditor's current assignments, so the
// device can work offline right away.
export async function POST(request) {
  if (!accountsConfigured()) {
    return Response.json({ ok: false, code: "not_configured", message: "Accounts aren't set up on this deployment yet." }, { status: 503 });
  }
  const body = await request.json().catch(() => null);
  const user = body ? await verifyLogin(body.email, body.password) : null;
  if (!user) {
    await new Promise((r) => setTimeout(r, 600)); // slows down password guessing
    return Response.json({ ok: false, code: "bad_credentials", message: "Wrong email or password." }, { status: 401 });
  }
  return Response.json({ ok: true, token: auditorToken(user), user: publicUser(user), assignments: await assignmentsFor(user.id) });
}
