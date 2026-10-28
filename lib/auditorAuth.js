// Auditor sessions for the field app (2026-10-28).
//
// After signing in (or setting a password from an invite link) the device
// gets a signed token it keeps in IndexedDB and sends as
// `Authorization: Bearer …` on /api/sync and /api/me. The app is
// offline-first, so the token is long-lived (90 days): the auditor signs in
// once, online, and can then work for days with no signal. It carries the
// user's sessionVersion; deactivating an auditor or resetting their
// password bumps it, so old tokens stop working at the next sync.
//
// Signed with a key derived from GOOGLE_CLIENT_SECRET (already a server
// secret here, see lib/adminAuth.js) under a different label than admin
// sessions, so the two can never be swapped for each other.
import crypto from "node:crypto";
import { getUser } from "@/lib/accounts";

const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

function key() {
  const secret = process.env.GOOGLE_CLIENT_SECRET || (process.env.NODE_ENV !== "production" ? "local-dev-only" : null);
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("karimu-auditor-session-v1").digest();
}
const sign = (k, payload) => crypto.createHmac("sha256", k).update(payload).digest("base64url");

export function auditorToken(user) {
  const k = key();
  if (!k) throw new Error("Auditor sign-in isn't configured (missing GOOGLE_CLIENT_SECRET).");
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, sv: user.sessionVersion || 1, exp: Math.floor(Date.now() / 1000) + MAX_AGE,
  })).toString("base64url");
  return payload + "." + sign(k, payload);
}

/** The signed-in auditor (the full stored user) or null. Checks the
 * signature, expiry, that the account is still active, and that the token
 * isn't from before a password reset / deactivation. */
export async function getAuditor(request) {
  const k = key();
  if (!k) return null;
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const [payload, sig] = auth.slice(7).split(".");
  if (!payload || !sig) return null;
  const expected = sign(k, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  const user = await getUser(claims.uid);
  if (!user || !user.active || (user.sessionVersion || 1) !== claims.sv) return null;
  return user;
}
