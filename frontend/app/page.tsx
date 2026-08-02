import Link from "next/link";
import { Container } from "@/components/ui/Section";
import { Card } from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { HeroPreview } from "@/components/HeroPreview";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

// SoftwareApplication JSON-LD - this is the actual "what is this product"
// structured data (the root layout's Organization JSON-LD only says who
// publishes it). Eligible for Google's software/app rich-result treatment.
// No `aggregateRating`/`review` - fabricating those to look good in search
// is exactly the kind of structured-data spam Google's guidelines
// explicitly penalize, so it's omitted rather than faked.
const softwareAppJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

function IconIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS = {
  chart: "M4 20V10M12 20V4M20 20v-7M3 20h18",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  git: "M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM6 3a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9v3a4 4 0 01-4 4H9",
  stack: "M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
};

const features = [
  {
    title: "Real test-set metrics",
    description: "A genuine train/val/test split with accuracy, per-action F1, and a confusion matrix.",
    icon: ICONS.chart,
  },
  {
    title: "CNN + OCR fusion",
    description: "On-screen text is fused with the image classifier so near-identical screens still get told apart.",
    icon: ICONS.layers,
  },
  {
    title: "Auto-discover actions",
    description: "Upload a demo recording and vid2log clusters it into candidate actions - review, merge, and rename before saving.",
    icon: ICONS.sparkle,
  },
  {
    title: "Scene-by-scene action logs",
    description: "A timestamped log of every screen or action, with confidence - viewable in-app or as CSV.",
    icon: ICONS.list,
  },
  {
    title: "Pattern mining",
    description: "SPM surfaces common workflows; DSM shows what actually differs between two groups of sessions.",
    icon: ICONS.git,
  },
  {
    title: "A real model registry",
    description: "Train, compare, and activate multiple models instead of managing one file by hand.",
    icon: ICONS.stack,
  },
];

const steps = [
  {
    number: "01",
    title: "Train",
    description: "Add example images per action - or auto-discover them from a demo recording - then get real test-set accuracy.",
  },
  {
    number: "02",
    title: "Process",
    description: "Upload a recording and pick a model - actions are detected automatically, scene by scene.",
  },
  {
    number: "03",
    title: "Export",
    description: "Download a structured, timestamped action log as CSV or JSON.",
  },
  {
    number: "04",
    title: "Analyze",
    description: "Run SPM and DSM across your logs to find common workflows and what separates one group from another.",
  },
];

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd) }}
      />
      {/* Hero */}
      <section className="overflow-hidden border-b border-neutral-200">
        <Container className="grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-2">
          <div>
            <h1 className="mt-5 text-5xl font-semibold text-text">
              Turn screen recordings into activity logs, automatically.
            </h1>
            <p className="mt-5 max-w-lg text-m text-neutral-600">
              Train an image classifier on your app&apos;s screens, then let
              vid2log watch any recording and produce a clean, analyzable log of
              what happened, when.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/signup"
                className={buttonClasses({ variant: "primary", size: "lg" })}
              >
                Get started free
              </Link>
              <Link
                href="#how-it-works"
                className={buttonClasses({ variant: "outline", size: "lg" })}
              >
                See how it works
              </Link>
            </div>
          </div>
          <HeroPreview />
        </Container>
      </section>

      {/* Features */}
      <section id="features" className="py-20">
        <Container>
          <h2 className="max-w-xl text-4xl font-semibold text-text">
            Built for what point-and-click tools miss
          </h2>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.title} interactive className="h-full">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary-tint text-primary">
                  <IconIcon path={f.icon} />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-text">
                  {f.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
                  {f.description}
                </p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      <div className="dither-divider" aria-hidden="true" />

      {/* How it works */}
      <section id="how-it-works" className="py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-xs font-semibold uppercase tracking-widest text-primary">
              How it works
            </p>
            <h2 className="mt-2 text-4xl font-semibold text-text">
              Four steps, start to insight
            </h2>
          </div>

          <ol className="mt-14 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <li key={step.number} className="relative">
                <Card interactive className="h-full">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary-tint font-mono text-sm font-semibold text-primary">
                    {step.number}
                  </span>
                  <h3 className="mt-4 text-lg font-semibold text-text">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                    {step.description}
                  </p>
                </Card>
                {i < steps.length - 1 && (
                  <span
                    className="absolute top-10 -right-4 hidden text-neutral-300 lg:block"
                    aria-hidden="true"
                  >
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* CTA */}
      <section className="pb-24">
        <Container>
          {/* dither-dots, not dither-panel - dither-panel's radial mask is
           * meant for an empty decorative block and crops/fades any real
           * text inside it unevenly. dither-dots is just a background dot
           * texture with no mask, so it's safe behind actual content. */}
          <div className="dither-dots flex flex-col items-start gap-6 rounded-2xl border border-primary/20 bg-primary-tint p-10 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-text">
                Ready to log your first video?
              </h2>
              <p className="mt-2 max-w-md text-base text-neutral-600">
                Create an account and process your first recording in minutes.
              </p>
            </div>
            <Link
              href="/signup"
              className={buttonClasses({
                variant: "primary",
                size: "lg",
                className: "shrink-0",
              })}
            >
              Get started free
            </Link>
          </div>
        </Container>
      </section>
    </>
  );
}
