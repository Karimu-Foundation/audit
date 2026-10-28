import crypto from "node:crypto";
import {
  STATE_COOKIE, googleConfigured, checkIdTokenClaims,
  sessionCookie, clearStateCookie,
} from "@/lib/adminAuth";

export const runtime = "nodejs";

// Step 2 of "Sign in with Google": Google sends the browser back here with
// a one-time `code`. Check `state`, swap the code for an ID token directly
// with Google (server to server, using the client secret), check the
// account is a verified @karimufoundation.org Workspace account, then set
// the admin session cookie. Every failure lands back on /admin with a
// short reason the page turns into a message.
function backToAdmin(request, error, extraCookie) {
  const admin = new URL("/admin", request.url);
  if (error) admin.searchParams.set("error", error);
  const headers = new Headers({ Location: admin.toString() });
  headers.append("Set-Cookie", clearStateCookie());
  if (extraCookie) headers.append("Set-Cookie", extraCookie);
  return new Response(null, { status: 302, headers });
}

function sameString(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function GET(request) {
  if (!googleConfigured()) return backToAdmin(request, "not_configured");
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return backToAdmin(request, "cancelled"); // e.g. the user closed Google's consent screen
  const code = url.searchParams.get("code");
  if (!code || !sameString(url.searchParams.get("state"), request.cookies.get(STATE_COOKIE)?.value)) {
    return backToAdmin(request, "state");
  }

  let claims = null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: new URL("/api/auth/google/callback", request.url).toString(),
        grant_type: "authorization_code",
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id_token) {
      console.error("google token exchange failed", res.status, body.error);
      return backToAdmin(request, "google");
    }
    claims = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString("utf8"));
  } catch (err) {
    console.error("google sign-in failed", err);
    return backToAdmin(request, "google");
  }

  const check = checkIdTokenClaims(claims, process.env.GOOGLE_CLIENT_ID);
  if (!check.ok) return backToAdmin(request, check.reason);
  return backToAdmin(request, null, sessionCookie(check.email, check.name));
}
