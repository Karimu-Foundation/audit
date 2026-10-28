import { accountsConfigured, userForInvite, acceptInvite, publicUser, assignmentsFor, AccountError } from "@/lib/accounts";
import { auditorToken } from "@/lib/auditorAuth";

export const runtime = "nodejs";

// The invite link an admin sends an auditor (/?invite=<token>) lands in
// the field app, which asks here who it belongs to (GET), then sets the
// password and signs the device in with it (POST). The same link is how a
// forgotten password gets reset — the admin just generates a new one.

export async function GET(request) {
  if (!accountsConfigured()) return Response.json({ ok: false, code: "not_configured" }, { status: 503 });
  const token = new URL(request.url).searchParams.get("token");
  const user = await userForInvite(token);
  if (!user) return Response.json({ ok: false, code: "invalid_invite" }, { status: 404 });
  return Response.json({ ok: true, name: user.name, email: user.email });
}

export async function POST(request) {
  if (!accountsConfigured()) return Response.json({ ok: false, code: "not_configured" }, { status: 503 });
  const body = await request.json().catch(() => null);
  try {
    const user = await acceptInvite(body && body.token, body && body.password);
    return Response.json({ ok: true, token: auditorToken(user), user: publicUser(user), assignments: await assignmentsFor(user.id) });
  } catch (err) {
    if (err instanceof AccountError) return Response.json({ ok: false, code: err.code, message: err.message }, { status: 400 });
    throw err;
  }
}
