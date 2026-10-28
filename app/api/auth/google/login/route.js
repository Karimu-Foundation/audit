import crypto from "node:crypto";
import { ALLOWED_DOMAIN, googleConfigured, stateCookie } from "@/lib/adminAuth";

export const runtime = "nodejs";

// Step 1 of "Sign in with Google": send the browser to Google's consent
// screen. `state` is a one-time random value kept in a short-lived cookie
// and checked on the way back (callback/route.js), so the callback can't
// be triggered from another site. `hd` only pre-selects Karimu accounts in
// Google's picker — the real domain check happens in the callback.
export async function GET(request) {
  const admin = new URL("/admin", request.url);
  if (!googleConfigured()) {
    admin.searchParams.set("error", "not_configured");
    return Response.redirect(admin, 302);
  }
  const state = crypto.randomBytes(24).toString("base64url");
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL("/api/auth/google/callback", request.url).toString(),
    response_type: "code",
    scope: "openid email profile",
    state,
    hd: ALLOWED_DOMAIN,
    prompt: "select_account",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: google.toString(), "Set-Cookie": stateCookie(state) },
  });
}
