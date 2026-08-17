import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ServiceWorkerRegistrar } from "@/components/layout/service-worker";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://alphamovement.app"),
  title: {
    default: "Alpha Movement — Train smarter, move better, last longer",
    template: "%s · Alpha Movement",
  },
  description:
    "A modern synthesis training system fusing GOATA joint mechanics, primal patterns, internal arts, hybrid strength, and smart cardio. Built for movement quality that lasts.",
  applicationName: "Alpha Movement",
  manifest: "/manifest.webmanifest",
  // Pointing at the SVG explicitly stops browsers falling back to /favicon.ico.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: ["/icon.svg"],
  },
  appleWebApp: {
    capable: true,
    title: "Alpha Movement",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: "Alpha Movement",
    title: "Alpha Movement",
    description:
      "Joint health, elegant movement quality, aesthetic development, cardiovascular resilience, mental clarity.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-100 focus:rounded-[10px] focus:border focus:border-line focus:bg-elevated focus:px-4 focus:py-2 focus:text-small focus:text-ink"
        >
          Skip to content
        </a>
        <div id="main">{children}</div>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
