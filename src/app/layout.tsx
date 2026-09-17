import type { Metadata, Viewport } from "next";
import { Roboto_Condensed, Roboto_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: no render-blocking request to Google at runtime,
// and the type system still works offline.
const sans = Roboto_Condensed({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans-loaded", display: "swap" });
const mono = Roboto_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-loaded", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif-loaded", display: "swap" });
import ClientLayout from "@/components/ClientLayout";

export const metadata: Metadata = {
  title: "Tars | Agent Control Center",
  description: "Manage and monitor your Claude Code agents, projects, and tasks in real-time",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Tars",
  },
  formatDetection: {
    telephone: false,
  },
};

// No `themeColor` here. It wrote `<meta name="theme-color" content="#121212">`
// into every page, and nothing in Tars reads it: measured, `did-change-theme-color`
// is the one way that value reaches the app, the event fires (a control that
// changed the tag was reported as #FF0000), and the main process has no listener
// for it, in any of its 115 compiled files. The window's colour comes from
// `electron/core/window-manager.ts`, which opens it `backgroundColor: '#121212'`,
// and `titleBarOverlay`, the only chrome a page could colour, is never used.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The script below rewrites this element's class and color-scheme before
    // React hydrates, so for a reader who chose light the DOM never matches
    // what this file renders. That is the point, not a mistake: without
    // suppressHydrationWarning React reported it on every page, and on the
    // pages where hydration failed for another reason it rebuilt the tree and
    // re-created the script, which is where the "Encountered a script tag"
    // error came from. Only this element's own attributes are excused.
    <html
      lang="en"
      className={`dark ${sans.variable} ${mono.variable} ${serif.variable}`}
      style={{ colorScheme: 'dark' }}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the stored theme before the first paint: without this the
            light palette renders for one frame on every cold load (white flash).
            It stays an inline tag in the document: `next/script` with
            `beforeInteractive` renders a `<script>` through React just the same
            and defers the code to Next's own runtime, which runs after the
            first paint (measured: see the report for lot 2). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var dark=localStorage.getItem('tars-theme')!=='light';var e=document.documentElement;e.classList.toggle('dark',dark);e.style.colorScheme=dark?'dark':'light';}catch(_){}})();`,
          }}
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased">
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
