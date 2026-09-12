"use client";

import { useEffect } from "react";
import "leaflet/dist/leaflet.css";

// engine.js pulls in Leaflet, which touches `window` at module scope, so it
// can't be statically imported here (that would break server prerendering
// of this page). It stays a lazy import() — but that means the chunk has
// to actually load before any button on the page works (mount() attaches
// every click handler), which is exactly the kind of thing that can fail
// silently offline. Two things make that safe: the service worker caches
// this chunk cache-first (see public/sw.js) so once it's loaded online
// once, loading it again needs no network round-trip at all; and here we
// retry once on failure instead of giving up with every button dead.
function loadEngine(onReady) {
  import("@/lib/engine").then(onReady).catch(() => {
    // One retry — covers a transient hiccup right at the online/offline
    // boundary. If this also fails, the device most likely never cached
    // this chunk yet (its very first-ever load happened offline).
    import("@/lib/engine").then(onReady).catch(() => {});
  });
}

export default function Page() {
  useEffect(() => {
    let cancelled = false;
    loadEngine((mod) => { if (!cancelled) mod.mount(); });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Offline app-shell caching is a nice-to-have — the app still
        // works without it as long as the page was loaded once.
      });
    }
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">KF</div>
            <div className="brand-text">
              <div className="brand-name">Karimu Field Audit</div>
              <div className="brand-sub" id="brandSub">Offline ready</div>
            </div>
          </div>
          <div className="topbar-spacer"></div>
          <button className="iconbtn" id="langBtn" title="Change language" aria-label="Change language">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.7 4 6.2 4 9s-1.5 6.3-4 9c-2.5-2.7-4-6.2-4-9s1.5-6.3 4-9Z" />
            </svg>
            <span id="langLabel" className="lang-code">EN</span>
          </button>
          <button className="iconbtn" id="themeBtn" title="Switch theme" aria-label="Switch theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
          <button className="syncpill" id="syncPill">
            <span className="dot" id="netDot"></span>
            <span id="syncLabel">Sync</span>
          </button>
        </header>
        <main id="view"></main>
      </div>
      <div id="bottom"></div>
    </>
  );
}
