import Link from "@/components/link";
import { preloadPage, type PageName } from "@/lib/pages";
import { useLocation } from "react-router";
import { cn } from "@/lib/utils";
import type { Meta } from "@/lib/types";

/** The analysis tabs, in reading order. `rq` is the paper's research question, kept as a small badge. */
export const TABS = [
  { slug: "", label: "Overview", rq: "" },
  { slug: "rq1", label: "Scores by stage", rq: "RQ1 · RQ6" },
  { slug: "acquisition", label: "Failure analysis", rq: "RQ2" },
  { slug: "architecture", label: "Agent design", rq: "RQ3" },
  { slug: "behavior", label: "Customer types", rq: "RQ4" },
  { slug: "rq5", label: "Doc packaging", rq: "RQ5" },
] as const;

/** Pages that are not tabs but belong to one: they keep that tab lit and link back to it. */
export const LINKED: Record<string, (typeof TABS)[number]["slug"]> = {
  tickets: "acquisition",
  code: "architecture",
  build: "architecture",
};

/** The tab a linked page belongs to; the tickets page can say where it was opened from with ?from=<tab slug>. */
function parentOf(page: string, search: string) {
  const from = new URLSearchParams(search).get("from");
  return (page === "tickets" && TABS.find((t) => t.slug && t.slug === from)?.slug) || LINKED[page];
}

/** Doc packaging only exists for runs that build one agent per knowledge condition (support-agent-knowledge). */
export function hasKnowledgeConditions(meta: Meta) {
  const conds = meta.stages.filter((s) => {
    const sc = meta.scores[String(s)];
    return sc?.knowledge_condition || (typeof sc?.step === "string" && /^R/.test(sc.step));
  });
  return conds.length > 1;
}

/** The tab a path belongs to ("" is Overview), or null off the analysis pages. */
export function activeSlug(path: string, job: string, search = ""): (typeof TABS)[number]["slug"] | null {
  const research = `/runs/${job}/research`;
  if (path === research || path === `${research}/`) return "";
  const rest = path.startsWith(`${research}/`) ? path.slice(research.length + 1).split("/")[0] : null;
  if (rest) return TABS.find((t) => t.slug === rest)?.slug ?? null;
  const linked = path.startsWith(`/runs/${job}/`) ? path.slice(`/runs/${job}/`.length).split("/")[0] : "";
  return parentOf(linked, search) ?? null;
}

export function JobNav({ job, meta }: { job: string; meta: Meta }) {
  const { pathname: path, search } = useLocation();
  const active = activeSlug(path, job, search);
  // Carry the picked stage to the next tab (not tab-specific filters such as ?family=).
  const stage = new URLSearchParams(search).get("stage");
  const keep = stage && (stage === "all" || meta.stages.includes(Number(stage))) ? `?stage=${stage}` : "";
  const tabs = TABS.filter((t) => t.slug !== "rq5" || hasKnowledgeConditions(meta));
  return (
    <nav className="-mx-3 flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]" aria-label="Run">
      {tabs.map((t) => (
        <Link
          key={t.label}
          href={`${t.slug ? `/runs/${job}/research/${t.slug}` : `/runs/${job}/research`}${keep}`}
          onMouseEnter={() => preloadPage((t.slug || "overview") as PageName)}
          onFocus={() => preloadPage((t.slug || "overview") as PageName)}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors",
            active === t.slug ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.rq && <span className="ml-1.5 hidden rounded 2xl:inline bg-muted px-1 py-px align-[1px] text-[10px] font-normal text-muted-foreground">{t.rq}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A slim bar on the linked pages (Conversations, Agent code, Test cases): what they are, and the way back. */
export function BackBar({ job }: { job: string }) {
  const { pathname: path, search: query } = useLocation();
  const page = path.slice(`/runs/${job}/`.length).split("/")[0];
  const parent = parentOf(page, query);
  if (parent == null) return null;
  const tab = TABS.find((t) => t.slug === parent)!;
  const title = { tickets: "Trajectories", code: "Agent code", build: "Build logs" }[page];
  const search = new URLSearchParams(query);
  const stage = search.get("stage");
  const back = `/runs/${job}/research/${parent}${stage ? `?stage=${stage}` : ""}`;
  return (
    <div className="flex items-center gap-3 border-b bg-muted/30 px-6 py-1.5 font-sans text-xs">
      <Link href={back} className="link-text">← {tab.label}</Link>
      <span className="text-muted-foreground">/</span>
      <span className="font-medium">{title}</span>
    </div>
  );
}
