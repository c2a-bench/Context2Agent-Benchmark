import { useRef, useState } from "react";
import { Bot, Brain, Check, ChevronDown, Search, User, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DocLink } from "@/components/doc-sheet";
import { FAULT_CLASS, FAULT_LABEL, FIELD, REPLAY_VERDICTS, STATUS_LABEL, failParts, lookupLabel, show, writeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Blocked, ChangeSource, Diff, Failure, Rule, RuleStatus, Run, Ticket } from "@/lib/types";

const statusClass: Record<RuleStatus, string> = {
  new: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  changed: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  unchanged: "bg-muted text-muted-foreground",
  starting: "bg-muted text-muted-foreground",
};

export function RuleStatusBadge({ status }: { status: RuleStatus }) {
  return <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", statusClass[status])}>{STATUS_LABEL[status]}</span>;
}

/** Some doc-change snippets were cut from the raw JSON files, so characters like ’ appear as "\u2019": show the character. */
export const unescapeJson = (text: string) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

export function WordDiff({ diff }: { diff: Diff }) {
  return (
    <>
      {diff.map(([op, raw]) => [op, unescapeJson(raw)] as const).map(([op, text], i) =>
        op === "=" ? <span key={i}>{text} </span>
        : op === "-" ? <del key={i} className="rounded bg-red-500/12 px-0.5 text-red-700 decoration-red-500/60 dark:text-red-300">{text}</del>
        : <ins key={i} className="rounded bg-emerald-500/12 px-0.5 font-medium text-emerald-700 no-underline dark:text-emerald-300">{text} </ins>,
      )}
    </>
  );
}

function FailLine({ line, className }: { line: string; className?: string }) {
  const p = failParts(line);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {p.label && <span>{p.label}</span>}
      {p.got && <code className="rounded border border-red-500/50 px-1.5 font-mono text-[12px] text-red-600 dark:text-red-400">{p.got}</code>}
      {p.got && p.want && <span className="text-muted-foreground">→</span>}
      {p.want && <code className="rounded bg-emerald-500/12 px-1.5 font-mono text-[12px] text-emerald-700 dark:text-emerald-300">{p.want}</code>}
      {p.plain && <span>{p.plain}</span>}
    </span>
  );
}

function StateChips({ state, wrong }: { state: Record<string, unknown>; wrong?: Set<string> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(state).map(([k, v]) => (
        <span key={k} className={cn("rounded-md px-2 py-0.5 font-mono text-[11.5px]", wrong?.has(k) ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-muted text-muted-foreground")}>
          {FIELD[k] ?? k} <span className="text-foreground">{show(v)}</span>
        </span>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mr-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</span>;
}

const SOURCE_TEXT: Record<ChangeSource["source"], string> = {
  model: "model (tool call)",
  code: "code decided",
  text: "reply text (no tools)",
};
const SOURCE_CLASS: Record<ChangeSource["source"], string> = {
  model: "bg-muted text-muted-foreground",
  code: FAULT_CLASS.builder,
  text: FAULT_CLASS.builder,
};

/** Who set each saved change. A note only: it never fails the ticket. */
function WhoDecided({ changes }: { changes: ChangeSource[] }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <Label>Who decided each change</Label>
      <p className="mt-1 text-[12px] text-muted-foreground">A note on how the builder wired the agent. It does not change pass or fail.</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
        {changes.map((c, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono">{c.field === "action" ? c.call : (FIELD[c.field] ?? c.field)} = {show(c.value)}</span>
            <span className={cn("rounded-full px-2 py-px text-[11px] font-medium", SOURCE_CLASS[c.source])}>{SOURCE_TEXT[c.source]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BlockedNote({ b }: { b: Blocked }) {
  return (
    <div className="rounded-lg bg-background/70 px-3 py-2 text-[12.5px]">
      <span className="font-mono font-semibold text-red-600 dark:text-red-400">{b.rule}</span> <RuleStatusBadge status={b.status} /> got in the way. The agent said:{" "}
      <span className="italic">“{b.quote}”</span>
    </div>
  );
}

function FailureCard({ f, id, onRule }: { f: Failure; id: string; onRule: (r: string) => void }) {
  return (
    <div id={id} className="w-full scroll-mt-24 rounded-xl border border-red-500/60 bg-red-500/[0.06] p-3">
      <div className="flex items-start gap-2 text-[13.5px] font-medium text-red-700 dark:text-red-300">
        <X className="mt-0.5 size-4 shrink-0" />
        <FailLine line={f.line} />
      </div>
      <div className="mt-1 pl-6 text-[12.5px]">{f.note}</div>
      {f.fault && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 pl-6 text-[12.5px]">
          <Label>Fault</Label>
          <span className={cn("rounded-full px-2 py-px text-[11px] font-medium", FAULT_CLASS[f.fault.side])}>{f.fault.side === "us" ? "Our fault" : `${FAULT_LABEL[f.fault.side]}'s fault`}</span>
          <span>{f.fault.text}{f.fault.side === "us" && " Our mistake, still counted as wrong."}</span>
          {f.fault.taxonomy && (
            <span className="text-[11px] text-muted-foreground">
              {f.fault.taxonomy.group ?? f.fault.taxonomy.family} · {f.fault.taxonomy.type}
            </span>
          )}
          {f.fault.detail && <span className="basis-full text-muted-foreground">{f.fault.detail}</span>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
        <Label>Breaks</Label>
        {f.rules.map((r) => (
          <button key={r.id} onClick={() => onRule(r.id)} className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 font-mono text-xs font-semibold hover:border-foreground/40">
            {r.id} <RuleStatusBadge status={r.status} />
          </button>
        ))}
      </div>
      {f.blockedBy.length > 0 && <div className="mt-2 flex flex-col gap-1.5 pl-6">{f.blockedBy.map((b) => <BlockedNote key={b.rule} b={b} />)}</div>}
    </div>
  );
}

function BotTurn({ run, t }: { run: Run; t: Ticket }) {
  const secs = run.calls.reduce((a, c) => a + (c.seconds ?? 0), 0);
  const tokens = Math.max(0, ...run.calls.map((c) => c.tokens ?? 0));
  return (
    <div className="w-full rounded-xl border border-dashed bg-card p-3 text-[13px]">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>Agent run {run.n}</span>
        <span className="normal-case tracking-normal">
          {run.calls.length ? `${run.calls.length} model call${run.calls.length > 1 ? "s" : ""} · ${secs.toFixed(1)}s${tokens ? ` · ${Math.round(tokens / 1000)}k prompt tokens` : ""}` : "no model call"}
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <Search className="mr-1 size-3.5 text-muted-foreground" />
          <Label>Looked up</Label>
          {run.lookups.length ? run.lookups.map((l) => <span key={l} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{lookupLabel(l, t.ticket, t.customerId)}</span>) : <span className="text-xs text-muted-foreground">nothing</span>}
        </div>
        {run.calls.map((c, i) => (
          <div key={i} className="flex flex-col gap-2">
            {c.error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">Model call failed: {c.error}</div>}
            {c.reasoning && (
              <div className="rounded-lg bg-muted/70 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                <span className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-foreground/70"><Brain className="size-3.5" /> Thinking</span>
                {c.reasoning}
              </div>
            )}
            {c.raw && <pre className="whitespace-pre-wrap rounded-lg bg-muted/70 px-3 py-2 text-xs text-muted-foreground">{c.raw}</pre>}
            {c.actions.length > 0 && (
              <div>
                <Label>Planned</Label>
                <div className="mt-1 flex flex-col gap-1">
                  {c.actions.map((a, j) => {
                    const args = a.args ?? {};
                    const detail = args.changes ? Object.entries(args.changes as Record<string, unknown>).map(([k, v]) => `${FIELD[k] ?? k} = ${show(v)}`).join(" · ") : args.body ? `“${String(args.body).slice(0, 90)}…”` : String(args.key_id ?? args.reason ?? "");
                    return (
                      <div key={j} className="flex gap-2 text-[12.5px]">
                        <span className="text-muted-foreground">→</span>
                        <span><span className="font-mono font-medium">{a.tool}</span> <span className="text-muted-foreground">{detail}</span></span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
        <div>
          <Label>Did</Label>
          {run.writes.length ? (
            <div className="mt-1 flex flex-col gap-1">
              {run.writes.map((w, i) => {
                const l = writeLabel(w, t.ticket);
                const ok = w.status < 300;
                return (
                  <div key={i} className="flex gap-2 text-[12.5px]">
                    <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded", ok ? "bg-emerald-500/15 text-emerald-600" : "bg-red-500/15 text-red-600")}>{ok ? <Check className="size-3" /> : <X className="size-3" />}</span>
                    <span>{l.title}{!ok && ` (failed ${w.status})`} <span className="text-muted-foreground">{l.detail.length > 180 ? l.detail.slice(0, 180) + "…" : l.detail}</span></span>
                  </div>
                );
              })}
            </div>
          ) : <span className="text-xs text-muted-foreground">Changed nothing.</span>}
        </div>
        {run.changes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Label>Ticket now</Label>
            {run.changes.map((c) => (
              <span key={c.field} className="rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[11.5px] text-emerald-700 dark:text-emerald-300">
                {FIELD[c.field] ?? c.field}: <s className="opacity-60">{show(c.from)}</s> → {show(c.to)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RuleBlock({ r, stage, highlighted }: { r: Rule; stage: number; highlighted: boolean }) {
  return (
    <div data-rule={r.id} className={cn("mt-3 border-t border-dashed pt-3 text-[12.5px] transition-colors", highlighted && "-mx-3 rounded-lg bg-muted px-3 pb-3")}>
      <div className="flex items-center gap-2"><span className="font-mono text-xs font-semibold">{r.id}</span><RuleStatusBadge status={r.status} /></div>
      <p className="mt-1 leading-relaxed text-muted-foreground">{r.diff ? <WordDiff diff={r.diff} /> : r.text}</p>
      <div className="mt-2 flex flex-col gap-1">
        {r.sources.map((s) => (
          <div key={s.path} className="flex items-baseline gap-2">
            <span className="shrink-0 rounded bg-emerald-500/12 px-1.5 text-[10px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">Real page</span>
            <span><DocLink doc={s} stage={stage} quote={r.quote} kind="real" /> <span className="text-muted-foreground/70">{s.status} {s.updated}</span></span>
          </div>
        ))}
        {r.traps.map((s) => (
          <div key={s.path} className="flex items-baseline gap-2">
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">Trap page</span>
            <span><DocLink doc={s} stage={stage} quote={r.trapQuote} kind="trap" /> <span className="text-muted-foreground/70">{s.status} {s.updated}</span></span>
          </div>
        ))}
      </div>
      {r.why && (
        <p className="mt-2">
          {r.why}
          {r.sure === false && <Badge variant="outline" className="ml-1.5 border-amber-500/50 text-amber-700 dark:text-amber-300">unconfirmed</Badge>}
        </p>
      )}
    </div>
  );
}

type Question = NonNullable<NonNullable<Ticket["factCheck"]>["questions"]>[number];

const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The judge's questions per agent run: S1, S2... are the agent's replies in order; a question's quote is in its reply. */
function questionsByRun(t: Ticket): Map<number, Question[]> | null {
  const qs = t.factCheck?.questions;
  if (!qs) return null;
  const replied = t.runs.filter((r) => r.reply);
  const out = new Map<number, Question[]>();
  for (const q of qs) {
    const run = replied.find((r) => q.quote && flat(r.reply!).includes(flat(q.quote))) ?? replied[Number(q.turn.slice(1)) - 1];
    if (run) out.set(run.n, [...(out.get(run.n) ?? []), q]);
  }
  return out;
}

/** Customer precision on the turn itself: whether this reply asks the customer for a decisive fact, and which. */
function QuestionTag({ qs, decisive }: { qs: Question[] | undefined; decisive: Set<string> }) {
  if (!qs?.length) return <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">no question to the customer</span>;
  const asked = [...new Set(qs.flatMap((q) => q.asks_for))];
  const hits = asked.filter((a) => decisive.has(a));
  const rest = asked.filter((a) => !decisive.has(a));
  return (
    <div className="max-w-full text-right text-[11.5px]">
      <span className={cn("rounded px-1.5 py-0.5 text-[11px]", hits.length ? FACT_LABEL.right : FACT_LABEL.absent)}>
        {hits.length ? "relevant question" : "not relevant question"}
      </span>
      {hits.map((a) => <div key={a} className="mt-0.5 text-muted-foreground">asks for decisive fact: {a}</div>)}
      {rest.map((a) => <div key={a} className="mt-0.5 text-muted-foreground">asks for (not decisive): {a}</div>)}
      {!asked.length && <div className="mt-0.5 text-muted-foreground">asks for no fact the ticket needs</div>}
    </div>
  );
}

export function Conversation({ ticket: t }: { ticket: Ticket }) {
  const [rule, setRule] = useState<string | null>(null);
  const byRun = questionsByRun(t);
  const decisiveFacts = new Set((t.factCheck?.customer_facts ?? []).filter((c) => c.decisive).map((c) => c.text));
  const [briefOpen, setBriefOpen] = useState(false);
  const why = useRef<HTMLDivElement>(null);
  const wrong = new Set(t.failures.map((f) => f.field).filter(Boolean) as string[]);
  const pinned = (n: number | "end") => t.failures.map((f, i) => ({ f, i })).filter(({ f }) => f.turn === n);
  const jump = (i: number) => document.getElementById(`fail-${i}`)?.scrollIntoView({ behavior: "instant", block: "center" });
  const showRule = (id: string) => {
    setRule(id);
    setTimeout(() => why.current?.querySelector(`[data-rule="${id}"]`)?.scrollIntoView({ behavior: "instant", block: "center" }), 50);
  };

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_380px] max-xl:grid-cols-1">
      <div className="min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pt-6 pb-32 sm:px-8 sm:pt-8">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-xl font-semibold">{t.id}</h1>
            <Badge variant="secondary">stage {t.stage}</Badge>
            <Badge variant="outline">{t.group}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t.title} · ticket {t.ticket}</p>

          <div className="mt-4 rounded-xl border bg-card">
            <button onClick={() => setBriefOpen(!briefOpen)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Ticket context <ChevronDown className={cn("size-4 transition-transform", briefOpen && "rotate-180")} />
            </button>
            {briefOpen && (
              <div className="grid gap-4 border-t px-4 py-3 text-[13.5px] md:grid-cols-2">
                <div>
                  <Label>What this ticket tests</Label>
                  <p className="mt-1">{t.test}</p>
                  {t.matters && <p className="mt-1.5 text-muted-foreground">{t.matters}</p>}
                </div>
                <div>
                  <Label>Customer’s private brief</Label>
                  <p className="mt-1">{t.brief}</p>
                  {t.facts.length > 0 && <ul className="mt-1.5 list-disc pl-4 text-muted-foreground">{t.facts.map((x) => <li key={x}>{x}</li>)}</ul>}
                </div>
                <div className="md:col-span-2">
                  <Label>Ticket at the start</Label>
                  <div className="mt-1.5"><StateChips state={t.start} /></div>
                </div>
              </div>
            )}
          </div>

          {t.factCheck && <FactCheck t={t} />}

          {t.crash && <div className="mt-4 rounded-xl border border-red-500/50 bg-red-500/[0.06] p-3 text-[13px] text-red-700 dark:text-red-300">{t.crash}</div>}
          {!t.turnsExact && <div className="mt-4 rounded-xl border border-amber-500/50 bg-amber-500/[0.06] p-3 text-[13px]">The agent’s lookups and actions could not be split by turn for this ticket; they are all shown on the first turn.</div>}

          <div className="mt-8 flex flex-col gap-6">
            {t.runs.map((run, k) => (
              <div key={run.n} className="flex flex-col gap-5">
                {t.messages[k] !== undefined && (
                  <div className="flex items-start gap-2.5">
                    <div className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><User className="size-4" /></div>
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border bg-card px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap">{t.messages[k]}</div>
                  </div>
                )}
                <div className="flex items-start gap-2.5 flex-row-reverse">
                  <div className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-800 text-slate-50 dark:bg-slate-200 dark:text-slate-900"><Bot className="size-4" /></div>
                  <div className="flex w-full max-w-[90%] flex-col items-end gap-2">
                    <BotTurn run={run} t={t} />
                    {run.reply ? (
                      <div className="rounded-2xl rounded-tr-sm bg-slate-800 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-slate-50 dark:bg-slate-200 dark:text-slate-900">{run.reply}</div>
                    ) : <span className="text-xs text-muted-foreground">No reply to the customer.</span>}
                    {run.reply && byRun && <QuestionTag qs={byRun.get(run.n)} decisive={decisiveFacts} />}
                    {pinned(run.n).map(({ f, i }) => <FailureCard key={i} f={f} id={`fail-${i}`} onRule={showRule} />)}
                  </div>
                </div>
              </div>
            ))}
            {t.messages[t.runs.length] !== undefined && (
              <div className="flex items-start gap-2.5">
                <div className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><User className="size-4" /></div>
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm border bg-card px-4 py-2.5 text-[14px] whitespace-pre-wrap">{t.messages[t.runs.length]}</div>
              </div>
            )}
            <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">End of conversation</div>
            {pinned("end").map(({ f, i }) => <FailureCard key={i} f={f} id={`fail-${i}`} onRule={showRule} />)}
            <div className="rounded-xl border bg-card p-4">
              <Label>Ticket at the end</Label>
              <div className="mt-2"><StateChips state={t.end} wrong={wrong} /></div>
            </div>
            {!!t.changeSources?.length && <WhoDecided changes={t.changeSources} />}
          </div>
        </div>
      </div>

      <aside ref={why} className="min-h-0 overflow-y-auto border-l bg-card/50 px-5 py-6 max-xl:hidden">
        {t.failures.length === 0 ? (
          <>
            <h2 className="text-sm font-semibold">Passed</h2>
            <p className="mb-3 text-xs text-muted-foreground">Every check on this ticket was right.</p>
          </>
        ) : (
          <>
            <h2 className="text-sm font-semibold">What went wrong</h2>
            <p className="mb-3 text-xs text-muted-foreground">{t.failures.length} failed check{t.failures.length === 1 ? "" : "s"}. Click one to jump to its turn.</p>
          </>
        )}
        {t.failures.map((f, i) => (
          <div key={i} onClick={() => jump(i)} className="mb-3 cursor-pointer rounded-xl border bg-card p-3 transition-colors hover:border-foreground/30">
            <div className="flex items-start justify-between gap-2 text-[13px] font-medium">
              <FailLine line={f.line} />
              <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{f.turn === "end" ? "end" : `turn ${f.turn}`}</span>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              {f.rules.map((r) => <RuleBlock key={r.id} r={r} stage={t.stage} highlighted={rule === r.id} />)}
              {f.blockedBy.map((b) => (
                <div key={b.rule} className="mt-3 border-t border-dashed pt-3 text-[12.5px]">
                  <div className="flex items-center gap-2"><span className="font-mono text-xs font-semibold text-red-600 dark:text-red-400">{b.rule}</span><RuleStatusBadge status={b.status} /><span>got in the way</span></div>
                  <p className="mt-1">{b.why}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

const FACT_LABEL: Record<string, string> = {
  right: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  absent: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

/** A run graded by facts: the facts this ticket needs as the judge found them in the agent, and its customer facts. */
function FactCheck({ t }: { t: Ticket }) {
  const f = t.factCheck!;
  const decisive = f.customer_facts.filter((c) => c.decisive);
  const verdict = t.replayVerdict ? REPLAY_VERDICTS[t.replayVerdict]?.label ?? t.replayVerdict : null;
  return (
    <div className="mt-4 rounded-xl border bg-card px-4 py-3 text-[13.5px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>What the judge found</Label>
        {verdict && <span className="text-xs text-muted-foreground">{verdict}</span>}
      </div>
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-xs text-muted-foreground">
            Facts this ticket needs (from the docs) · {f.rule_facts.filter((x) => x.label === "right").length}/{f.rule_facts.length} right in the agent
          </div>
          <ul className="mt-1.5 grid gap-1.5">
            {f.rule_facts.map((x) => (
              <li key={x.id}>
                <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[11px]", FACT_LABEL[x.label])}>{x.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{x.id}</span> {x.text}
                {x.quote && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">agent: “{x.quote}”</div>}
              </li>
            ))}
            {!f.rule_facts.length && <li className="text-muted-foreground">none</li>}
          </ul>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">
            Customer facts · {decisive.filter((c) => c.told).length}/{decisive.length} decisive facts obtained
          </div>
          <ul className="mt-1.5 grid gap-1.5">
            {f.customer_facts.map((c) => (
              <li key={c.text}>
                <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[11px]", c.told ? FACT_LABEL.right : FACT_LABEL.absent)}>
                  {c.told ? "obtained" : "not obtained"}
                </span>
                <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{c.decisive ? "decisive" : "not decisive"}</span>
                {c.text}
              </li>
            ))}
          </ul>
          {f.questions && f.questions.length > 0 && (
            <div className="mt-3 text-xs text-muted-foreground">
              Customer precision · {f.questions.filter((q) => q.asks_for.some((a) => decisive.some((d) => d.text === a))).length}/{f.questions.length} of
              the agent&apos;s questions ask for a decisive fact (tagged on each agent turn below)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
