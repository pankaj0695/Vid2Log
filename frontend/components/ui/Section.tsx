import Link from "next/link";
import { Tooltip } from "@/components/ui/Tooltip";
import { BUTTON_TOOLTIPS } from "@/lib/copy";
import { IconHelp } from "@/components/app-shell/icons";

export function Container({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 ${className}`} {...props} />;
}

export function PageHeader({
  eyebrow,
  subtitle,
  title,
  description,
  action,
  helpAnchor,
}: {
  eyebrow?: string;
  /** One plain-language line shown directly BELOW the title — for
   * non-technical users, explaining in ordinary words what this page is
   * for once they've read the (sometimes jargon-adjacent) title. Distinct
   * from `eyebrow` (a small-caps section kicker above the title) and from
   * `description` (longer, page-specific detail that sits below this) —
   * see lib/copy.ts's PAGE_SUBTITLES for the actual wording. */
  subtitle?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Section id in lib/helpContent.ts. Renders a small `?` beside the title
   * that jumps to that section of /help. Sits inline next to the heading
   * rather than in `action`, so adding it never disturbs a page's existing
   * buttons. Use the HELP_ANCHORS constants so a renamed section fails to
   * compile instead of silently producing a dead link. */
  helpAnchor?: string;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        {eyebrow && (
          <p className="mb-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-primary">{eyebrow}</p>
        )}
        <div className="flex items-center gap-2">
          <h1 className="text-4xl font-semibold text-text">{title}</h1>
          {helpAnchor && (
            <Tooltip label={BUTTON_TOOLTIPS.help}>
              <Link
                href={`/help#${helpAnchor}`}
                aria-label={`Help: ${title}`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <IconHelp className="h-[18px] w-[18px]" />
              </Link>
            </Tooltip>
          )}
        </div>
        {subtitle && <p className="mt-2 max-w-2xl text-sm text-neutral-500">{subtitle}</p>}
        {description && <p className="mt-2 max-w-2xl text-base text-neutral-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}
