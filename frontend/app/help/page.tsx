"use client";

import { useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { useAuth } from "@/lib/auth-context";
import { Container, PageHeader } from "@/components/ui/Section";
import { PAGE_SUBTITLES } from "@/lib/copy";
import {
  HELP_INTRO,
  HELP_SECTIONS,
  type HelpSection,
  type HelpStepGroup,
} from "@/lib/helpContent";
import { HELP_FIGURES } from "@/components/help/HelpFigures";

/** Frames every diagram identically and caps it at a readable width, so the
 * figures read as plates in a manual rather than loose decoration. */
function FigureBlock({ name }: { name: keyof typeof HELP_FIGURES }) {
  const Fig = HELP_FIGURES[name];
  return (
    <figure className="mt-4 mb-1 max-w-2xl overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 p-5">
      <Fig />
    </figure>
  );
}

function StepGroup({ group, index }: { group: HelpStepGroup; index: number }) {
  return (
    <div className={index === 0 ? "" : "mt-7"}>
      {group.heading && (
        <h3 className="mb-3 text-[15px] font-semibold text-text">{group.heading}</h3>
      )}
      <ol className="max-w-2xl space-y-2.5">
        {group.items.map((item, i) => (
          <li key={item} className="flex gap-3 text-sm leading-relaxed text-neutral-600">
            <span
              aria-hidden="true"
              className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-tint text-[11px] font-semibold text-primary-hover"
            >
              {i + 1}
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
      {group.figure && <FigureBlock name={group.figure} />}
    </div>
  );
}

function ReferenceTable({ section }: { section: HelpSection }) {
  if (!section.terms || section.terms.length === 0) return null;
  return (
    <div className="mt-7 max-w-2xl">
      <h3 className="mb-3 text-[15px] font-semibold text-text">
        {section.termsHeading ?? "Reference"}
      </h3>
      <dl className="overflow-hidden rounded-lg border border-neutral-200">
        {section.terms.map((t, i) => (
          <div
            key={t.term}
            className={`grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-5 ${
              i % 2 === 1 ? "bg-neutral-50" : ""
            }`}
          >
            <dt className="text-sm font-medium text-text">{t.term}</dt>
            <dd className="text-sm leading-relaxed text-neutral-600">{t.def}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SectionBody({ section, number }: { section: HelpSection; number: number }) {
  return (
    <section id={section.id} className="scroll-mt-24 border-t border-neutral-200 pt-10">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-sm font-semibold tabular-nums text-primary">
          {String(number).padStart(2, "0")}
        </span>
        <h2 className="text-2xl font-semibold tracking-tight text-text">{section.title}</h2>
        {section.adminOnly && (
          <span className="rounded-full bg-secondary-tint px-2.5 py-0.5 text-xs font-medium text-secondary-hover">
            Administrators only
          </span>
        )}
      </div>

      <p className="max-w-2xl text-[15px] leading-relaxed text-neutral-600">{section.blurb}</p>

      {section.figure && <FigureBlock name={section.figure} />}

      {section.groups && section.groups.length > 0 && (
        <div className="mt-7">
          {section.groups.map((group, i) => (
            <StepGroup key={group.heading ?? group.items[0]} group={group} index={i} />
          ))}
        </div>
      )}

      <ReferenceTable section={section} />

      {section.note && (
        <div className="mt-7 max-w-2xl rounded-lg border border-primary/25 bg-primary-tint px-4 py-3.5">
          <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-widest text-primary-hover">
            Note
          </p>
          <p className="text-sm leading-relaxed text-text">{section.note}</p>
        </div>
      )}
    </section>
  );
}

/** Contents list. Tracks the section currently in view with an
 * IntersectionObserver rather than scroll arithmetic, so it stays accurate
 * when a figure changes height on a narrow window. */
function SectionNav({ sections, activeId }: { sections: HelpSection[]; activeId: string }) {
  return (
    // `self-start` is load-bearing: as a flex child this would otherwise
    // stretch to the full height of the sections column (many thousands of
    // pixels), and a sticky box as tall as its container has nothing to stick
    // against, so it just scrolls away with the page.
    <nav aria-label="Contents" className="sticky top-24 hidden w-56 shrink-0 self-start lg:block">
      <p className="mb-3 px-3 font-mono text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
        Contents
      </p>
      <ol className="space-y-0.5">
        {sections.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={activeId === s.id ? "true" : undefined}
              className={`flex gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                activeId === s.id
                  ? "bg-primary-tint font-medium text-primary-hover"
                  : "text-neutral-500 hover:bg-neutral-100 hover:text-text"
              }`}
            >
              <span className="font-mono text-xs tabular-nums opacity-60">
                {String(i + 1).padStart(2, "0")}
              </span>
              {s.nav}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function HelpContent() {
  const { isAdmin } = useAuth();
  // The Administration section documents a page non-administrators cannot
  // reach, so it is hidden rather than describing an item they will not see.
  // Memoised because it is the dependency of the observer effect below; a
  // fresh array on every render would tear down and rebuild the observer
  // continuously.
  const sections = useMemo(
    () => HELP_SECTIONS.filter((s) => !s.adminOnly || isAdmin),
    [isAdmin],
  );
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const ids = sections.map((s) => s.id);
    const headings = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // Intersection state has to be accumulated across callbacks. Each
    // callback receives only the entries whose intersection CHANGED, so
    // choosing the topmost from `entries` alone reports whichever section
    // happened to cross the band last, not the one actually in view.
    const intersecting = new Map<string, boolean>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) intersecting.set(e.target.id, e.isIntersecting);
        // `ids` is in document order, so the first match is the topmost
        // section currently inside the band.
        const current = ids.find((id) => intersecting.get(id));
        if (current) setActiveId(current);
      },
      // Top weighted band: a section becomes current once it reaches the
      // upper third, and ceases to be current once it leaves the top.
      { rootMargin: "-80px 0px -66% 0px", threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <AppShell section="help" crumb="Help">
      <Container className="py-10">
        <PageHeader eyebrow="Help" subtitle={PAGE_SUBTITLES.help} title="Vid2Log user guide" />

        <div className="flex gap-12">
          <SectionNav sections={sections} activeId={activeId} />

          <div className="min-w-0 flex-1">
            <p className="mb-2 max-w-2xl border-l-2 border-primary pl-4 text-[15px] leading-relaxed text-neutral-600">
              {HELP_INTRO}
            </p>

            {/* Trailing space so that the final section can still scroll to
             * the top of the viewport. Without it the page runs out of scroll
             * before the last anchor reaches its position, and a link to
             * #troubleshooting lands part way down instead. */}
            <div className="mt-10 space-y-12 pb-[40vh]">
              {sections.map((s, i) => (
                <SectionBody key={s.id} section={s} number={i + 1} />
              ))}
            </div>
          </div>
        </div>
      </Container>
    </AppShell>
  );
}

export default function HelpPage() {
  return (
    <ProtectedRoute>
      <HelpContent />
    </ProtectedRoute>
  );
}
