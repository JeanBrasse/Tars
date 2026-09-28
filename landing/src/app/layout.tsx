import type { Metadata } from "next";
import { Instrument_Serif, Roboto_Condensed, Roboto_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// The app's three families, self-hosted by next/font as the app does it. The
// page used to link fonts.googleapis.com for Instrument Serif and an Inter that
// nothing used, while Roboto Condensed and Roboto Mono were never loaded at
// all: the body fell back to system-ui, and every visitor's address went to
// Google on the way.
const ui = Roboto_Condensed({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-ui", display: "swap" });
const mono = Roboto_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });
const display = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  // Absolute URLs for the preview picture: the production domain on Vercel,
  // localhost anywhere else (src/lib/site.ts).
  metadataBase: new URL(SITE_URL),
  title: "Tars - Run a team of AI coding agents",
  description: "A desktop control room for AI coding agents: run them in parallel across your projects, deploy whole teams, share one memory, and drive it all from Hermes.",
  keywords: ["Tars", "Claude", "Codex", "Gemini", "AI", "Agent", "Manager", "Claude Code", "OpenAI", "Google"],
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/favicon-32.png", sizes: "32x32" }], apple: "/icon-192.png" },
  openGraph: {
    title: "Tars - Run a team of AI coding agents",
    description: "A desktop control room for AI coding agents: parallel terminals, team deployment, shared memory, Hermes-driven.",
    type: "website",
  },
  // The picture is app/opengraph-image.png; X reads it through og:image.
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable} ${display.variable}`}>
      <body className="antialiased">{children}<Analytics /></body>
    </html>
  );
}
