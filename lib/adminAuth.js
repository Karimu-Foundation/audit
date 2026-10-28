// Access control for the /admin page and its API routes (2026-10-28).
//
// People: "Sign in with Google", restricted to @karimufoundation.org Google
// Workspace accounts (see app/api/auth/google/*). A successful sign-in
// sets a signed, httpOnly session cookie; there is no password login any
// more. This replaced a single shared keyword ("K@rimu") that sat in this
// repo's source — and the repo is public, so anyone could read every audit
// or wipe them all through /api/admin/reset.
//
// Machines: Google Sheets' IMPORTDATA (and the daily Drive-photo routine)
// can't sign in with Google, so the read-only CSV/JSON export
// (/api/admin/export) still also accepts a shared key, via `?key=` or
// `Authorization: Bearer`. That key is ADMIN_PASSWORD in Vercel's
// environment variables; the "K@rimu" fallback only keeps existing Sheet
// formulas working until a real value is set (the admin page warns while
// it's still the fallback). The key opens nothing else — not the admin
// data route, and never reset.
import crypto from "node:crypto";

export const ALLOWED_DOMAIN = "karimufoundation.org";

const EXPORT_KEY_FALLBACK = "K@rimu";
const EXPORT_KEY = process.env.ADMIN_PASSWORD || EXPORT_KEY_FALLBACK;

const SESSION_COOKIE = "karimu_admin_session";
export const STATE_COOKIE = "karimu_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Sessions are signed with a key derived from the OAuth client secret, so
// there's no extra secret to manage. Rotating the client secret signs
// everyone out, which is the right outcome anyway.
function sessionKey() {
  return crypto.createHmac("sha256", process.env.GOOGLE_CLIENT_SECRET).update("karimu-admin-session-v1").digest();
}
const b64url = (buf) => Buffer.from(buf).toString("base64url");
function sign(payload) {
  return b64url(crypto.createHmac("sha256", sessionKey()).update(payload).digest());
}

function sessionToken(email, name) {
  const payload = b64url(JSON.stringify({ email, name, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE }));
  return payload + "." + sign(payload);
}

/** The signed-in admin ({email, name}), or null. */
export function getSession(request) {
  if (!googleConfigured()) return null;
  const raw = request.cookies?.get?.(SESSION_COOKIE)?.value;
  if (!raw || !raw.includes(".")) return null;
  const [payload, sig] = raw.split(".");
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!s.exp || s.exp < Math.floor(Date.now() / 1000)) return null;
    if (!isAllowedEmail(s.email)) return null;
    return { email: s.email, name: s.name || "" };
  } catch {
    return null;
  }
}

function isAllowedEmail(email) {
  return typeof email === "string" && email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN);
}

/** Checks the claims of a Google ID token obtained straight from Google's
 * token endpoint over TLS (OpenID Connect allows trusting it without a
 * signature check in that case — it never passed through the browser).
 * `hd` is the Workspace domain claim: personal Gmail accounts have none,
 * which is what actually keeps them out. */
export function checkIdTokenClaims(claims, clientId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!claims) return { ok: false, reason: "google" };
  if (claims.aud !== clientId) return { ok: false, reason: "google" };
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") return { ok: false, reason: "google" };
  if (!claims.exp || claims.exp < nowSec) return { ok: false, reason: "google" };
  if (claims.email_verified !== true) return { ok: false, reason: "domain" };
  if (claims.hd !== ALLOWED_DOMAIN || !isAllowedEmail(claims.email)) return { ok: false, reason: "domain" };
  return { ok: true, email: claims.email.toLowerCase(), name: claims.name || "" };
}

/** Admin page + its data/reset routes: Google session only. */
export function isAuthorized(request) {
  return getSession(request) !== null;
}

/** Read-only export: Google session, or the shared machine key. */
export function isExportAuthorized(request) {
  if (getSession(request)) return true;
  const url = new URL(request.url);
  if (url.searchParams.get("key") === EXPORT_KEY) return true;
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") && auth.slice(7) === EXPORT_KEY;
}

/** For the admin page's ready-to-paste Sheets formulas — only ever sent
 * to a signed-in @karimufoundation.org admin. */
export function exportKeyInfo() {
  return { key: EXPORT_KEY, isFallback: EXPORT_KEY === EXPORT_KEY_FALLBACK };
}

function cookie(name, value, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
export const sessionCookie = (email, name) => cookie(SESSION_COOKIE, sessionToken(email, name), SESSION_MAX_AGE);
export const clearSessionCookie = () => cookie(SESSION_COOKIE, "", 0);
export const stateCookie = (state) => cookie(STATE_COOKIE, state, 600);
export const clearStateCookie = () => cookie(STATE_COOKIE, "", 0);
