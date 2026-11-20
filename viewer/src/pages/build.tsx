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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-6 px-6 py-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        {/* the stages: a column that stays in view on wide screens, a row to swipe on a phone */}
        <nav aria-label="Stages" className="flex gap-1.5 overflow-x-auto lg:sticky lg:top-6 lg:flex-col lg:self-start lg:overflow-visible">
          {builds.stages.map((s) => (
            <Link key={s.index} href={`?s=${s.index}`} className={cn("shrink-0 rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-muted lg:w-full", s.index === i && "border-foreground bg-muted")}>
              <div className="font-medium">{label(s)} build</div>
              <div className="text-muted-foreground tabular-nums">
                {s.format ? `${money(s.summary.cost)} · ${s.summary.commands} commands` : "no log"}
              </div>
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <Summary job={job} stage={stage} harness={builds.harness} />
          {stage.format ? (
            <Suspense key={stage.index} fallback={<p className="py-8 text-sm text-muted-foreground">Loading the build log…</p>}>
              <Timeline job={job} stage={stage} />
            </Suspense>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">No builder log was kept for this step.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ job, stage, harness }: { job: string; stage: BuildStage; harness: string | null }) {
  const s = stage.summary;
  const tok = s.tokens;
  const cached = tok?.input && tok.cached ? Math.round((100 * tok.cached) / tok.input) : null;
  const facts = [
    `${money(s.cost)}`,
    s.calls != null && `${num(s.calls)} model calls`,
    s.commands != null && `${num(s.commands)} commands${s.failed ? ` (${s.failed} failed)` : ""}`,
    tok?.input != null && `${num(tok.input)} tokens in${cached != null ? ` (${cached}% cached)` : ""}`,
    tok?.output != null && `${num(tok.output)} out`,
  ].filter(Boolean);
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-2xl font-normal tracking-tight">{label(stage)} build</h2>
        <span className="text-xs text-muted-foreground">{[harness, s.model, s.thinking && `${s.thinking} thinking`].filter(Boolean).join(" · ")}</span>
        <Link href={`/runs/${job}/code?v=s${stage.step.match(/^stage(\d+)$/)?.[1] ?? stage.index}`} className="link-text ml-auto text-xs">The agent it left</Link>
      </div>
      <p className="mt-2 text-sm text-muted-foreground tabular-nums">{facts.join(" · ")}</p>
      {s.error && <p className="mt-3 rounded-md border px-3 py-2 text-sm">The build stopped with {s.error}.</p>}
      {s.last && <LastMessage text={s.last} />}
    </section>
  );
}

/** The builder's closing message: three lines, with a toggle to read it all. */
function LastMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > 3 || text.length > 300;
  return (
    <div className="mt-4 rounded-lg border bg-muted/30 px-4 py-3">
      <div className="text-xs text-muted-foreground">The builder&apos;s last message</div>
      <p className={cn("mt-1 whitespace-pre-wrap break-words text-sm", !open && "line-clamp-3")}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs underline decoration-border underline-offset-4 hover:decoration-current">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
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
    <section className="mt-8">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 py-2 backdrop-blur">
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

/** What a tool call did, in one readable line: the shell command(s), or the file it read, wrote or edited, or the
 *  helper it used. Builders log calls in their own shapes (Codex wraps shell commands in exec_command({cmd: …});
 *  Claude Code and pi send {command} or {file_path, content}); the raw input stays one click away. */
type Said = { verb: string; target: string; body?: string; shell?: boolean };
const unq = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
function describe(e: BuildEvent): Said {
  const name = e.n ?? "tool";
  const raw = e.x ?? "";
  let o: Record<string, unknown> | null = null;
  try { const v = JSON.parse(raw); if (v && typeof v === "object") o = v as Record<string, unknown>; } catch { /* a plain string, or cut short */ }
  const str = (k: string) => (typeof o?.[k] === "string" ? (o[k] as string) : (raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1] && unq(raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))![1])) || "");
  // Codex: JavaScript that calls exec_command({cmd: "…"}) once or several times.
  const input = str("input");
  const cmds = [...(input || raw).matchAll(/exec_command\(\{\s*cmd\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"\s*[,}]/g)].map((m) => unq(unq(m[1])));
  if (cmds.length) return { verb: "$", target: cmds[0], body: cmds.join("\n"), shell: true };
  const command = str("command") || str("cmd");
  if (/^(bash|shell|exec|exec_command|run)$/i.test(name) || (!o && raw && /^(bash|shell)$/i.test(name))) return { verb: "$", target: (command || raw).split("\n")[0], body: command || raw, shell: true };
  const path = str("file_path") || str("path");
  if (/^read$/i.test(name) && path) return { verb: "Read", target: path };
  if (/^write$/i.test(name) && path) return { verb: "Write", target: path, body: str("content") };
  if (/^(edit|multiedit)$/i.test(name) && path) return { verb: "Edit", target: path, body: str("new_string") || str("newText") };
  if (/^agent$/i.test(name)) return { verb: "Sub-agent", target: str("description") || "a helper agent", body: str("prompt") };
  if (/^monitor$/i.test(name)) return { verb: "Wait", target: str("description") || command, body: command };
  if (command) return { verb: name, target: command.split("\n")[0], body: command, shell: true };
  return { verb: name, target: path || str("description") || str("query") || "" };
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
  const d = describe(e);
  const lines = (e.o ?? "").split("\n").length;
  const more = !!d.body && d.body.trim() !== d.target.trim();
  return (
    <li className="flex gap-3 py-2.5">
      {e.e ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        {/* one line: what it did */}
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("shrink-0 font-mono text-xs", d.shell ? "text-muted-foreground" : "rounded bg-muted px-1.5 py-0.5")}>{d.verb}</span>
          <span className="min-w-0 truncate font-mono text-[12.5px]" title={d.target}>{d.target || "—"}</span>
          {e.e && <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">failed</span>}
        </div>
        {/* folded: the whole command or file text, the output, the raw call */}
        <Folds
          job={job}
          parts={[
            ...(more ? [{ key: "body", label: d.shell ? `whole command · ${d.body!.split("\n").length} lines` : `content · ${d.body!.split("\n").length} lines`, text: d.body! }] : []),
            ...(e.o != null ? [{ key: "out", label: `output · ${lines} line${lines === 1 ? "" : "s"}`, text: e.o || "(no output)", fullRef: e.r }] : []),
          ]}
          raw={e.ri}
        />
      </div>
    </li>
  );
}

/** The folded parts of a call (its whole command or file text, its output): toggles on one line, the open one below. */
function Folds({ job, parts, raw }: { job: string; parts: { key: string; label: string; text: string; fullRef?: string }[]; raw?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!parts.length && !raw) return null;
  const shown = parts.find((p) => p.key === open);
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {parts.map((p) => (
          <button key={p.key} type="button" onClick={() => setOpen(open === p.key ? null : p.key)} aria-expanded={open === p.key}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", open === p.key && "rotate-90")} /> {p.label}
          </button>
        ))}
        {raw && <Full job={job} refId={raw} what="raw call" />}
      </div>
      {shown && (
        <>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-[12px]">{shown.text}</pre>
          {shown.fullRef && <Full job={job} refId={shown.fullRef} what="output" />}
        </>
      )}
    </div>
  );
}
