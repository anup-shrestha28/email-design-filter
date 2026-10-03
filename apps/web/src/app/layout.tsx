import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Email Design Filter", template: "%s · Email Design Filter" },
  description:
    "Organises the newsletters, promotions and receipts you signed up for, and gives every designed email an explainable Design Score.",
  applicationName: "Email Design Filter",
  referrer: "strict-origin-when-cross-origin",
  robots: { index: false, follow: false },
  formatDetection: { email: false, address: false, telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1013" },
  ],
  colorScheme: "light dark",
};

/**
 * Root layout: static (no cookies/headers), so public pages prerender. Each route group applies
 * the saved theme before paint with its own inline script (see components/shell/theme-script).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
