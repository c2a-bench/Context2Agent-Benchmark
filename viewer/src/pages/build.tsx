import { Suspense, use, useMemo, useState } from "react";
import { AlertTriangle, Brain, ChevronRight, MessageSquare, Search, Terminal } from "lucide-react";
import Link from "@/components/link";
import { useJob, useQuery } from "@/lib/route";
import { getBuildEvents, getBuilds, getLogText } from "@/lib/data";
import type { BuildEvent, BuildStage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The builder's working time per step, from its own logs (scripts/build_logs.py). */

const label = (s: BuildStage) => {
  const m = s.step.match(/^stage(\d+)$/);
  return m ? `Stage ${m[1]}` : s.step;
};
const money = (usd: number | null | undefined) => (usd == null ? "–" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
const num = (n: number | null | undefined) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

export default function BuildPage() {
  const job = useJob();
  const q = useQuery();
  const builds = use(getBuilds(job));
  if (!builds || !builds.stages.length) {
    return <p className="px-6 py-12 text-sm text-muted-foreground">This run has no builder logs (it was built before they were kept, or its builder wrote none).</p>;
  }
  const i = Math.min(Math.max(Number(q.s ?? 0) || 0, 0), builds.stages.length - 1);
  const stage = builds.stages[i];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch gap-1.5 overflow-x-auto border-b px-6 py-3">
        {builds.stages.map((s) => {
          return (
            <Link key={s.index} href={`?s=${s.index}`} className={cn("min-w-40 rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-muted", s.index === i && "border-foreground bg-muted")}>
              <div className="flex items-center gap-1.5 font-medium">
                {label(s)} build
              </div>
              <div className="text-muted-foreground tabular-nums">
                {s.format ? `${money(s.summary.cost)} · ${s.summary.commands} cmds` : "no log"}
              </div>
            </Link>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Summary job={job} stage={stage} harness={builds.harness} />
        {stage.format ? (
          <Suspense key={stage.index} fallback={<p className="px-6 py-8 text-sm text-muted-foreground">Loading the build log…</p>}>
            <Timeline job={job} stage={stage} />
          </Suspense>
        ) : (
          <p className="px-6 py-8 text-sm text-muted-foreground">No builder log was kept for this step.</p>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0 border-t pt-2">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="text-lg font-medium tabular-nums">{v}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Summary({ job, stage, harness }: { job: string; stage: BuildStage; harness: string | null }) {
  const s = stage.summary;
  const tok = s.tokens;
  const cached = tok?.input && tok.cached ? Math.round((100 * tok.cached) / tok.input) : null;
  return (
    <section className="border-b px-6 py-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{label(stage)}: how the builder built the agent</h2>
        <span className="text-xs text-muted-foreground">{[harness, s.model, s.thinking && `${s.thinking} thinking`].filter(Boolean).join(" · ")}</span>
        <Link href={`/runs/${job}/code?v=s${stage.step.match(/^stage(\d+)$/)?.[1] ?? stage.index}`} className="link-text ml-auto text-xs">The agent it left →</Link>
      </div>
      {s.error && <p className="mt-3 rounded-md border px-3 py-2 text-sm">The build stopped with {s.error}.</p>}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat k="Cost" v={money(s.cost)} />
        <Stat k="Model calls" v={num(s.calls)} />
        <Stat k="Commands" v={num(s.commands)} sub={s.failed ? `${s.failed} failed` : undefined} />
        <Stat k="Tokens out" v={num(tok?.output)} />
        <Stat k="Tokens in" v={num(tok?.input)} sub={cached != null ? `${cached}% cached` : undefined} />
      </div>
      {Object.keys(s.tools ?? {}).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {Object.entries(s.tools ?? {}).map(([name, n]) => (
            <span key={name} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px]">{name} · {n}</span>
          ))}
        </div>
      )}
      {s.last && (
        <div className="mt-4">
          <div className="text-xs text-muted-foreground">The builder's last message</div>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-sm">{s.last}</p>
        </div>
      )}
    </section>
  );
}

type Filter = "all" | "say" | "tool" | "think" | "failed";
const FILTERS: [Filter, string][] = [["all", "All"], ["say", "Messages"], ["tool", "Commands"], ["think", "Thinking"], ["failed", "Failed"]];

function Timeline({ job, stage }: { job: string; stage: BuildStage }) {
  const events = use(getBuildEvents(job, stage.index));
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return events.filter((e) => {
      if (filter === "failed" ? !e.e : filter !== "all" && e.k !== filter) return false;
      return !t || [e.x, e.o, e.n].some((v) => v?.toLowerCase().includes(t));
    });
  }, [events, filter, term]);
  const count = (f: Filter) => (f === "all" ? events.length : f === "failed" ? events.filter((e) => e.e).length : events.filter((e) => e.k === f).length);
  return (
    <section className="px-6 py-4">
      <div className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center gap-2 border-b bg-background/95 px-6 py-2 backdrop-blur">
        {FILTERS.map(([f, name]) => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={cn("rounded-full border px-2.5 py-1 text-xs", filter === f ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
            {name} <span className="tabular-nums opacity-70">{count(f)}</span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
          <Search className="size-3.5 text-muted-foreground" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search commands and output" className="w-48 bg-transparent outline-none" />
        </label>
      </div>
      <ol className="mt-2 divide-y">
        {shown.map((e, n) => <Event key={n} job={job} e={e} />)}
        {!shown.length && <li className="py-6 text-sm text-muted-foreground">Nothing matches.</li>}
      </ol>
    </section>
  );
}

function Full({ job, refId, what }: { job: string; refId: string; what: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="link-text mt-1 text-xs">Show the whole {what}</button>;
  }
  return (
    <Suspense fallback={<div className="mt-1 text-xs text-muted-foreground">Loading…</div>}>
      <FullText job={job} refId={refId} />
    </Suspense>
  );
}
function FullText({ job, refId }: { job: string; refId: string }) {
  const text = use(getLogText(job, refId));
  return <pre className="mt-1 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-[12px]">{text}</pre>;
}

function Event({ job, e }: { job: string; e: BuildEvent }) {
  if (e.k === "say") {
    return (
      <li className="flex gap-3 py-3">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm">{e.x}</p>
          {e.r && <Full job={job} refId={e.r} what="message" />}
        </div>
      </li>
    );
  }
  if (e.k === "think") {
    return (
      <li className="flex gap-3 py-2">
        <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <details className="min-w-0 flex-1 text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none italic">Thinking: {(e.x ?? "").slice(0, 120)}{(e.x ?? "").length > 120 ? "…" : ""}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words italic">{e.x}</p>
          {e.r && <Full job={job} refId={e.r} what="thinking" />}
        </details>
      </li>
    );
  }
  const lines = (e.o ?? "").split("\n").length;
  return (
    <li className="flex gap-3 py-3">
      {e.e ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{e.n ?? "tool"}</span>
          {e.d != null && <span className="text-muted-foreground tabular-nums">{e.d}s</span>}
          {e.e && <span className="font-medium text-red-600 dark:text-red-400">failed</span>}
        </div>
        {e.x && <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-[12px]">{e.x}</pre>}
        {e.ri && <Full job={job} refId={e.ri} what="input" />}
        {e.o != null && (
          <details className="mt-1.5 group">
            <summary className="flex cursor-pointer select-none items-center gap-1 text-xs text-muted-foreground">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /> Output · {lines} line{lines === 1 ? "" : "s"}
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-[12px]">{e.o || "(no output)"}</pre>
            {e.r && <Full job={job} refId={e.r} what="output" />}
          </details>
        )}
      </div>
    </li>
  );
}
