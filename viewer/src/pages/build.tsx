import { Suspense, use, useMemo, useState } from "react";
import { Bot, Brain, ChevronRight, Clock, FilePen, FileText, Search, Terminal, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
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

/** The log as the builder's story: each message it wrote starts a step, and the actions it took after it (commands,
 *  file reads and writes, helpers, thinking) sit folded under that message, like an agent's transcript. */
type Step = { say: BuildEvent | null; acts: BuildEvent[] };
function stepsOf(events: BuildEvent[]): Step[] {
  const out: Step[] = [];
  for (const e of events) {
    if (e.k === "say" || !out.length) out.push({ say: e.k === "say" ? e : null, acts: [] });
    if (e.k !== "say") out[out.length - 1].acts.push(e);
  }
  return out;
}

function Timeline({ job, stage }: { job: string; stage: BuildStage }) {
  const events = use(getBuildEvents(job, stage.index));
  const steps = useMemo(() => stepsOf(events), [events]);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [all, setAll] = useState<boolean | null>(null); // Expand all / Collapse all (null: each step as the reader left it)
  const [term, setTerm] = useState("");
  const q = term.trim().toLowerCase();
  const hit = (e: BuildEvent) => !q || [e.x, e.o, e.n].some((v) => v?.toLowerCase().includes(q));
  const shown = steps.filter((s) => (!onlyFailed || s.acts.some((a) => a.e)) && (!q || (s.say && hit(s.say)) || s.acts.some(hit)));
  const failed = steps.filter((s) => s.acts.some((a) => a.e)).length;
  return (
    <section className="mt-8">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 py-2 backdrop-blur">
        <button type="button" onClick={() => setOnlyFailed(false)} className={cn("rounded-full border px-2.5 py-1 text-xs", !onlyFailed ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
          All steps <span className="tabular-nums opacity-70">{steps.length}</span>
        </button>
        <button type="button" onClick={() => setOnlyFailed(true)} disabled={!failed} className={cn("rounded-full border px-2.5 py-1 text-xs disabled:opacity-40", onlyFailed ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
          Steps with a failure <span className="tabular-nums opacity-70">{failed}</span>
        </button>
        <button type="button" onClick={() => setAll(all ? false : true)} className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">
          {all ? "Collapse all" : "Expand all"}
        </button>
        <label className="ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
          <Search className="size-3.5 text-muted-foreground" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search commands and output" className="w-48 bg-transparent outline-none" />
        </label>
      </div>
      <ol className="mt-4 space-y-5">
        {shown.map((s, n) => <StepView key={`${n}-${all}-${onlyFailed}-${q}`} job={job} step={s} open={all ?? (onlyFailed || !!q)} />)}
        {!shown.length && <li className="py-6 text-sm text-muted-foreground">Nothing matches.</li>}
      </ol>
    </section>
  );
}

/** What a step's actions did, in a few words: "9 actions · 1 failed · wrote agent.py, kg.py". */
function stepSummary(acts: BuildEvent[]): string {
  const tools = acts.filter((a) => a.k === "tool");
  const failed = tools.filter((a) => a.e).length;
  const wrote = [...new Set(tools.map(describe).filter((d) => d.verb === "Write" || d.verb === "Edit").map((d) => d.target.split("/").pop()!))];
  const thinking = acts.filter((a) => a.k === "think").length;
  return [
    tools.length && `${tools.length} action${tools.length === 1 ? "" : "s"}`,
    failed && `${failed} failed`,
    wrote.length && `changed ${wrote.slice(0, 3).join(", ")}${wrote.length > 3 ? ` +${wrote.length - 3}` : ""}`,
    !tools.length && thinking && "thinking",
  ].filter(Boolean).join(" · ");
}

function StepView({ job, step, open: startOpen }: { job: string; step: Step; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const failed = step.acts.some((a) => a.e);
  return (
    <li className="flex gap-3">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", failed ? "bg-red-500" : "bg-foreground/40")} aria-hidden />
      <div className="min-w-0 flex-1">
        {step.say ? (
          <div className="prose-sm max-w-none text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_li]:ml-4 [&_li]:list-disc [&_p+p]:mt-2 [&_strong]:font-semibold [&_ul]:mt-1">
            <ReactMarkdown>{step.say.x ?? ""}</ReactMarkdown>
            {step.say.r && <Full job={job} refId={step.say.r} what="message" />}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Started</div>
        )}
        {step.acts.length > 0 && (
          <div className="mt-1.5">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              <span className={cn(failed && "text-red-600 dark:text-red-400")}>{stepSummary(step.acts)}</span>
            </button>
            {open && (
              <ol className="mt-2 space-y-1 border-l pl-3">
                {step.acts.map((a, i) => <Action key={i} job={job} e={a} />)}
              </ol>
            )}
          </div>
        )}
      </div>
    </li>
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

const ICON = { "$": Terminal, Read: FileText, Write: FilePen, Edit: FilePen, "Sub-agent": Bot, Wait: Clock } as const;

/** One action in a step: an icon, what it did in one line, and (on click) the whole command or file and its output. */
function Action({ job, e }: { job: string; e: BuildEvent }) {
  const [open, setOpen] = useState(false);
  if (e.k === "think") {
    return (
      <li>
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-start gap-2 rounded px-1.5 py-1 text-left text-xs text-muted-foreground italic hover:bg-muted/50">
          <Brain className="mt-0.5 size-3.5 shrink-0" />
          <span className={cn("min-w-0", !open && "truncate")}>{open ? e.x : `Thinking: ${e.x ?? ""}`}</span>
        </button>
        {open && e.r && <div className="pl-7"><Full job={job} refId={e.r} what="thinking" /></div>}
      </li>
    );
  }
  const d = describe(e);
  const Icon = ICON[d.verb as keyof typeof ICON] ?? Wrench;
  const body = d.body && d.body.trim() !== d.target.trim() ? d.body : null;
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className={cn("flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50", open && "bg-muted/50")}>
        <Icon className={cn("size-3.5 shrink-0", e.e ? "text-red-500" : "text-muted-foreground")} />
        <span className="shrink-0 text-xs font-medium">{d.verb === "$" ? "Shell" : d.verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={d.target}>{d.target}</span>
        {e.e && <span className="shrink-0 text-[11px] font-medium text-red-600 dark:text-red-400">failed</span>}
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-6 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 font-mono text-[12px] text-neutral-200 [--link-line:#f2f536] [--link:#f2f2f1]">
          <pre className="max-h-72 overflow-auto px-3 py-2 whitespace-pre-wrap break-words">
            {d.shell ? <span className="text-neutral-500">$ </span> : null}{body ?? d.target}
          </pre>
          {e.o != null && (
            <pre className={cn("max-h-80 overflow-auto border-t border-neutral-800 px-3 py-2 whitespace-pre-wrap break-words", e.e ? "text-red-300" : "text-neutral-400")}>{e.o || "(no output)"}</pre>
          )}
          {(e.r || e.ri) && (
            <div className="flex gap-4 border-t border-neutral-800 px-3 py-1.5 font-sans">
              {e.r && <Full job={job} refId={e.r} what="output" />}
              {e.ri && <Full job={job} refId={e.ri} what="raw call" />}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

