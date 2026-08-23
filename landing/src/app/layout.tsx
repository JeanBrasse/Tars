import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tars - Run a team of AI coding agents",
  description: "A desktop control room for AI coding agents: run them in parallel across your projects, deploy whole teams, share one memory, and drive it all from Hermes.",
  keywords: ["Tars", "Claude", "Codex", "Gemini", "AI", "Agent", "Manager", "Claude Code", "OpenAI", "Google"],
  icons: { icon: "/favicon-32.png", apple: "/icon-192.png" },
  openGraph: {
    title: "Tars - Run a team of AI coding agents",
    description: "A desktop control room for AI coding agents: parallel terminals, team deployment, shared memory, Hermes-driven.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}<Analytics /></body>
    </html>
  );
}
