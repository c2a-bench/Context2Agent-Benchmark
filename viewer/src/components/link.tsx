import { Link as RouterLink, type LinkProps } from "react-router";
import { ArrowRight, ArrowUpRight, FileText, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Router link with the href prop the pages were written with. */
export default function Link({ href, scroll: _scroll, ...rest }: Omit<LinkProps, "to"> & { href: string; scroll?: boolean }) {
  return <RouterLink to={href} {...rest} />;
}

/** What a text link does, shown by its icon: go to another view, open a doc, open another site, clear a filter. */
export const LINK_ICON = { go: ArrowRight, doc: FileText, external: ArrowUpRight, clear: X } satisfies Record<string, LucideIcon>;
export type LinkKind = keyof typeof LINK_ICON;

export function LinkIcon({ kind }: { kind: LinkKind }) {
  const Icon = LINK_ICON[kind];
  return <Icon aria-hidden className="ml-0.5 inline size-3 shrink-0 align-[-1px]" />;
}

/** A link inside text or a table: underlined and marked with an icon without needing a hover. */
export function TextLink({ href, kind = "go", className, children, ...rest }: Omit<LinkProps, "to"> & { href: string; kind?: LinkKind }) {
  return (
    <RouterLink to={href} className={cn("link-text", className)} {...rest}>
      {children}
      <LinkIcon kind={kind} />
    </RouterLink>
  );
}
