import type { Metadata } from "next";
import { IBM_Plex_Mono, Open_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-provider";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} - Screen recordings to activity logs`,
    // Child routes set their own <title>; this template keeps the brand
    // name attached instead of every tab just saying "Dashboard".
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "vid2log",
    "screen recording to activity log",
    "video to log converter",
    "image classifier training",
    "CNN OCR fusion classification",
    "sequential pattern mining",
    "differential sequence mining",
    "educational data mining",
    "activity log analytics",
    "screen recording analysis",
  ],
  authors: [{ name: "vid2log" }],
  category: "technology",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/vid2log-logo.png",
    apple: "/apple-touch-icon.png",
  },
  // Site-wide default — indexable. Pages with nothing public to show
  // (the signed-in app itself) override this to noindex in their own
  // segment layout.tsx (see app/dashboard/layout.tsx and siblings).
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: `${SITE_NAME} - Screen recordings to activity logs`,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    // No explicit `images` — Next.js picks up app/opengraph-image.tsx
    // automatically and injects the correct og:image tags (and reuses it
    // for Twitter's card below) for every page that doesn't define its own.
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} - Screen recordings to activity logs`,
    description: SITE_DESCRIPTION,
  },
};

// Organization JSON-LD — site-wide (not page-specific), so search engines
// can attribute every page to the same brand entity regardless of which
// route was crawled. The landing page additionally carries its own
// SoftwareApplication JSON-LD (see app/page.tsx) describing the product
// itself; this one is just "who publishes this site."
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/vid2log-logo.png`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // next-themes sets data-theme on this element before React hydrates
      // (via its injected inline script) so there's no flash-of-wrong-theme
      // — but that means the server-rendered markup and the first client
      // paint legitimately differ here, which is exactly what
      // suppressHydrationWarning exists for (see next-themes' own docs).
      suppressHydrationWarning
      className={`${openSans.variable} ${spaceGrotesk.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <script
          type="application/ld+json"
          // JSON.stringify is the standard way to inject JSON-LD safely —
          // it escapes quotes/backslashes so nothing here can break out of
          // the <script> tag the way raw string interpolation could.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <ThemeProvider>
          <AuthProvider>
            <Navbar />
            <main className="flex-1">{children}</main>
            <Footer />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
