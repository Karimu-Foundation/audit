import "./globals.css";

export const metadata = {
  title: "Karimu Field Audit",
  description: "Offline-first maintenance audits for Karimu Foundation volunteers.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Karimu Field Audit",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F5F7F5",
};

export default function RootLayout({ children }) {
  // data-theme="light" is forced here (not just a default) — the app used
  // to have a light/dark toggle plus a "follow system" fallback, but a
  // dark screen turned out unreadable in direct sun for field audits, so
  // by request it's light-only now, regardless of the device's own theme
  // setting. See app/globals.css for the (now dead) dark palette — kept
  // there rather than deleted in case this gets revisited later.
  return (
    <html lang="en" data-theme="light">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Public+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
