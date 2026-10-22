import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { AppShell } from "@/components/shared/AppShell";
import { Providers } from "@/components/shared/Providers";
import { readViewerSessionFromCookies } from "@/lib/server/viewer-auth";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  SOCIAL_IMAGE_ALT
} from "@/lib/site-metadata";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  applicationName: SITE_NAME,
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`
  },
  description: SITE_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [{
      url: "/opengraph-image",
      width: 1200,
      height: 630,
      alt: SOCIAL_IMAGE_ALT
    }]
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ["/twitter-image"]
  },
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true
  }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" }
  ]
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewerSession = await readViewerSessionFromCookies().catch(() => null);
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} min-h-screen`}>
        <Providers viewerSession={viewerSession}>
          <AppShell>{children}</AppShell>
          <Toaster richColors />
        </Providers>
      </body>
    </html>
  );
}
