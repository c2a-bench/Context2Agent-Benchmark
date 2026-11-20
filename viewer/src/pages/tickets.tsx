import { use, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, Search, X } from "lucide-react";
import { currentSearchParams, useJob } from "@/lib/route";
import Link, { TextLink } from "@/components/link";
import { getCases, getInteractions, getMeta } from "@/lib/data";
import { CaseDetail, checks } from "@/pages/cases";
import { Conversation } from "@/components/conversation";
import { cn } from "@/lib/utils";
import { FIELD, INFO_TYPES, REPLAY_VERDICTS, stepLabel } from "@/lib/format";
import { FaultTags } from "@/components/fault-tags";
import { evolutionForStage, fraction, pct } from "@/lib/knowledge-evolution";
import { TICKET_TYPES, TICKET_TYPE_DEFS, TICKET_TYPE_LABEL, ticketTypes } from "@/lib/ticket-types";
import { stageName } from "@/components/stage-select";
import { Picker } from "@/components/picker";
import { PARTY_LABEL } from "@/lib/parties";
import { NONE, ticketLeaves } from "@/lib/failure-types";
import { behaviorForStage, behaviorLabel, fmtQ, sortBehaviors } from "@/lib/behavior-coverage";
import type { CaseVersion, Failure, Ticket } from "@/lib/types";

/** A ticket in this run plus the grader's definition of it at that stage (the test case), when the run has one. */
type Item = Ticket & { cv?: CaseVersion; /** the run published no conversation for it; only its test case is known */ noTrace?: boolean };

const SIDE_LABEL: Record<string, string> = { builder: "Builder", bot: "Agent", us: "Our side" };

/** What a failed check was about, in words. */
function failedWhat(f: Failure) {
  return f.field
    ? (FIELD[f.field] ?? f.field)
    : f.line.startsWith("Not decided")
      ? "a value the code chose"
      : f.kind === "forbidden"
        ? "an action it must not take"
        : f.line.startsWith("Missing action")
          ? "a required action"
          : "the ticket";
}

function blameValues(
  t: Ticket,
  fromBlame: (b: NonNullable<Ticket["blames"]>[number]) => string | null | undefined,
  fromFailure: (f: Failure) => string | null | undefined,
): string[] {
  const vs = t.blames ? t.blames.map(fromBlame) : t.failures.map(fromFailure);
  return vs.filter((x): x is string => !!x);
}

/** Customer precision of one ticket: the agent's questions to the customer and how many ask for a decisive fact. */
function questionScore(t: Ticket): { relevant: number; asked: number } | null {
  const qs = t.factCheck?.questions;
  if (!qs) return null;
  const decisive = new Set(t.factCheck!.customer_facts.filter((c) => c.decisive).map((c) => c.text));
  return { relevant: qs.filter((q) => q.asks_for.some((a) => decisive.has(a))).length, asked: qs.length };
}

const QUESTION_VALUES = ["asked a not-relevant question", "all questions relevant", "no questions"];

type Filter = {
  key: string;
  label: string;
  /** The values a ticket has for this filter; a ticket matches when any of them is the chosen one. */
  values: (t: Item) => string[];
  show?: (v: string) => string;
  order?: (vs: string[]) => string[];
};

/** "Builder|Group|Type" as it reads in a filter: "Builder failure › Group › Type". */
const showPick = (v: string) => (v === NONE ? "No blame recorded" : v.split("|").map((x, i) => (i === 0 ? (PARTY_LABEL[x] ?? x) : x)).join(" › "));

const FILTERS: Filter[] = [
  // The party, group and type a failed ticket is blamed on (Failure analysis); a ticket matches at any of the three levels.
  {
    key: "pick",
    label: "Failure (party › group › type)",
    values: (t) => (t.passed ? [] : [...new Set(ticketLeaves(t).flatMap((l) => { const p = l.key.split("|"); return p.map((_, i) => p.slice(0, i + 1).join("|")); }))]),
    show: showPick,
  },
  // Every blame record when the data has them; older viewer data only has the label picked per failed check.
  { key: "cause", label: "Failure cause", values: (t) => blameValues(t, (b) => b.label, (f) => f.fault?.label) },
  { key: "side", label: "Whose fault", values: (t) => blameValues(t, (b) => b.side, (f) => f.fault?.side), show: (v) => SIDE_LABEL[v] ?? v },
  { key: "type", label: "Failure type", values: (t) => blameValues(t, (b) => b.type, (f) => f.fault?.taxonomy?.type) },
  { key: "field", label: "What failed", values: (t) => t.failures.map(failedWhat) },
  {
    key: "rule",
    label: "Rule",
    values: (t) => t.failures.flatMap((f) => f.rules.map((r) => r.id)),
    order: (vs) => [...vs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b)),
  },
  {
    key: "info",
    label: "Answer comes from",
    values: (t) => (t.infoType != null ? [String(t.infoType)] : []),
    show: (v) => `${v}. ${INFO_TYPES[v] ?? v}`,
    order: (vs) => [...vs].sort(),
  },
  {
    key: "verdict",
    label: "Replay verdict",
    values: (t) => (t.replayVerdict ? [t.replayVerdict] : []),
    show: (v) => REPLAY_VERDICTS[v]?.label ?? v,
    order: (vs) => Object.keys(REPLAY_VERDICTS).filter((k) => vs.includes(k)).concat(vs.filter((v) => !(v in REPLAY_VERDICTS))),
  },
  { key: "group", label: "Ticket group", values: (t) => (t.group ? [t.group] : []) },
  {
    key: "ttype",
    label: "Against earlier stages",
    values: (t) => (t.ticketType ? [t.ticketType] : []),
    order: (vs) => TICKET_TYPES.filter((k) => vs.includes(k)),
  },
  { key: "behavior", label: "Customer type", values: (t) => (t.behavior ? [t.behavior] : []), show: behaviorLabel, order: sortBehaviors },
  {
    key: "questions",
    label: "Agent's questions",
    values: (t) => {
      const q = questionScore(t);
      return !q ? [] : [!q.asked ? "no questions" : q.relevant < q.asked ? "asked a not-relevant question" : "all questions relevant"];
    },
    order: (vs) => QUESTION_VALUES.filter((v) => vs.includes(v)),
  },
  // From the test case (the grader's definition of the ticket at this stage).
  {
    key: "need",
    label: "Rule it needs",
    values: (t) => t.cv?.rules.map((r) => r.id) ?? [],
    order: (vs) => [...vs].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b)),
  },
  { key: "check", label: "What it checks", values: (t) => (t.cv ? checks(t.cv) : []) },
  { key: "change", label: "Doc change", values: (t) => (t.cv?.tags.change_type ? [t.cv.tags.change_type] : []) },
  { key: "tier", label: "Customer tier", values: (t) => (t.cv?.customer.tier ? [t.cv.customer.tier] : []) },
  {
    key: "flag",
    label: "Flag",
    values: (t) => [...(t.crash ? ["agent error"] : []), ...(t.blocked.length ? ["rule in the way"] : []), ...(t.oursOnly ? ["our side only"] : [])],
  },
];

const RESULTS = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "passed", label: "Passed" },
] as const;

function matches(t: Item, params: URLSearchParams, skip?: string) {
  const result = params.get("result") ?? "all";
  if (skip !== "result" && result === "failed" && t.passed) return false;
  if (skip !== "result" && result === "passed" && !t.passed) return false;
  const find = params.get("find")?.trim().toLowerCase();
  if (find && !`${t.id} ${t.title} ${t.ticket}`.toLowerCase().includes(find)) return false;
  for (const f of FILTERS) {
    const want = params.get(f.key);
    if (want && f.key !== skip && !f.values(t).includes(want)) return false;
  }
  return true;
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("rounded bg-background px-1.5 text-[10px] text-muted-foreground ring-1 ring-border", className)}>{children}</span>;
}

export default function InteractionsPage() {
  const job = useJob();
  const [params, setParams] = useSearchParams();
  const meta = use(getMeta(job));
  const loaded = use(getInteractions(job));
  const cases = use(getCases(job));
  const stageOf = (step: string) => {
    const hit = Object.entries(meta.scores).find(([, sc]) => sc.step === step);
    return hit ? Number(hit[0]) : Number(step.replace(/\D/g, "")) || 0;
  };
  const caseById = new Map((cases?.tickets ?? []).map((c) => [c.id, [...c.versions].sort((a, b) => stageOf(a.step) - stageOf(b.step))]));
  const have = new Set(loaded.map((t) => `${t.id}|${t.stage}`));
  // Runs published before passed.json have no conversations for the tickets that passed; their test cases still list.
  const stubs: Item[] = [...caseById.entries()].flatMap(([id, versions]) =>
    versions
      .filter((v) => meta.stages.includes(stageOf(v.step)) && !have.has(`${id}|${stageOf(v.step)}`))
      .map((v): Item => ({
        key: `${id}:${stageOf(v.step)}:stub`, stage: stageOf(v.step), id, title: v.title, test: v.test, matters: v.matters, brief: v.brief,
        facts: [], ticket: v.ticket, customerId: v.customer.id, group: v.tags.group ?? "", behavior: v.tags.behavior ?? null,
        ticketType: v.tags.type ?? null, infoType: v.tags.info_type ?? null, start: {}, end: {}, messages: [], runs: [], failures: [],
        blocked: [], crash: "", turnsExact: false, passed: v.result?.passed ?? true, cv: v, noTrace: true,
      })),
  );
  const all: Item[] = [...loaded.map((t) => ({ ...t, cv: caseById.get(t.id)?.find((v) => stageOf(v.step) === t.stage) })), ...stubs];
  const withTickets = meta.stages.filter((s) => all.some((t) => t.stage === s));
  const qStage = params.get("stage");
  const stage = qStage !== null ? Number(qStage) : withTickets[0] ?? 0;
  const stageItems = all.filter((t) => t.stage === stage);
  const items = stageItems.filter((t) => matches(t, params));
  const selected = items.find((t) => t.id === params.get("t")) ?? items[0];
  const evo = evolutionForStage(stage, meta.scores[String(stage)]);
  const types = ticketTypes(meta.scores[String(stage)]);
  const beh = behaviorForStage(stage, meta.scores[String(stage)]);
  // On a phone the list and the ticket take turns: the list until a ticket is picked (?t=), then the ticket with a way back.
  const detailOpen = !!params.get("t") && items.some((t) => t.id === params.get("t"));
  const hasPassed = !all.some((t) => t.noTrace);
  const hasCases = caseById.size > 0;
  const view = hasCases && params.get("view") === "case" ? "case" : "conversation";

  const active = FILTERS.filter((f) => params.get(f.key));
  const narrowed = active.length > 0 || !!params.get("find") || (params.get("result") ?? "all") !== "all";
  const [open, setOpen] = useState(active.length > 0);

  /** Change some query keys and keep the rest (stage, other filters). */
  const set = (changes: Record<string, string | null>) => {
    // Start from the address bar, not this render's params: a click right after another may land before the re-render.
    const next = currentSearchParams();
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null) next.delete(k);
      else next.set(k, v);
    }
    return `?${next}`;
  };
  const clearAll = () => set({ result: null, find: null, t: null, ...Object.fromEntries(FILTERS.map((f) => [f.key, null])) });

  // Counts per result and per filter value, each over the tickets the other filters leave.
  const resultCount = (r: string) => stageItems.filter((t) => matches(t, params, "result") && (r === "all" || (r === "passed") === !!t.passed)).length;
  const options = (f: Filter) => {
    const counts = new Map<string, number>();
    for (const t of stageItems) {
      if (!matches(t, params, f.key)) continue;
      for (const v of new Set(f.values(t))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const want = params.get(f.key);
    if (want && !counts.has(want)) counts.set(want, 0);
    const keys = [...counts.keys()];
    const ordered = f.order ? f.order(keys) : keys.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    return ordered.map((v) => ({ v, n: counts.get(v) ?? 0 }));
  };
  // The failure filter names the fact-graded failure types, so older runs do not get it.
  const factGraded = meta.stages.some((s) => meta.scores[String(s)]?.facts);
  const usable = FILTERS.map((f) => ({ f, opts: options(f) })).filter(({ f, opts }) => (f.key !== "pick" || factGraded) && (opts.length > 0 || params.get(f.key)));

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-1">
      <aside className={cn("flex min-h-0 flex-col border-b max-lg:overflow-y-auto lg:border-r lg:border-b-0", detailOpen && "max-lg:hidden")}>
        <div className="flex items-center gap-2 border-b p-3">
          <span className="font-sans text-sm font-semibold">Stage</span>
          <Picker
            id="stage-select"
            label="Stage"
            className="flex-1 text-sm"
            value={String(stage)}
            onPick={(v) => setParams(new URLSearchParams(href({ stage: v, t: null }).slice(1)), { replace: true })}
            options={meta.stages.map((s) => {
              const score = meta.scores[String(s)];
              return { value: String(s), text: stageName(meta, s), meta: score?.total ? `${score.passed}/${score.total} passed` : undefined };
            })}
          />
        </div>
        {beh.answersRq && beh.coverage && (
          <Link
            href={`/runs/${job}/research/behavior`}
            className={cn("grid gap-px border-b bg-border text-center text-[10px] hover:bg-muted/40", beh.perTicket ? "grid-cols-1" : "grid-cols-2")}
          >
            <div className="bg-background px-1 py-2">
              <div className="text-muted-foreground">Average across customer types</div>
              <div className="font-medium tabular-nums">{fmtQ(beh.coverage.q_coverage)}</div>
              <div className="tabular-nums text-muted-foreground">
                {beh.perTicket
                  ? `${Object.keys(beh.coverage.by_category ?? {}).length} behaviors`
                  : `${beh.coverage.n_scenarios} cells`}
              </div>
            </div>
            {!beh.perTicket && (
              <div className="bg-background px-1 py-2">
                <div className="text-muted-foreground">Qrealization</div>
                <div className="font-medium tabular-nums">{fmtQ(beh.realization?.mean_q_realization)}</div>
                <div className="tabular-nums text-muted-foreground">Customer types →</div>
              </div>
            )}
          </Link>
        )}
        {types && (
          <div className="grid grid-cols-3 gap-px border-b bg-border text-center text-[10px]">
            {TICKET_TYPES.map((k) => (
              <div key={k} className="bg-background px-1 py-2" title={TICKET_TYPE_DEFS[k]}>
                <div className="text-muted-foreground">{TICKET_TYPE_LABEL[k]}</div>
                <div className="font-medium tabular-nums">{fraction(types[k])}</div>
                <div className="tabular-nums text-muted-foreground">{pct(types[k])}</div>
              </div>
            ))}
          </div>
        )}
        {!types && evo.answersRq && (
          <div className="grid grid-cols-4 gap-px border-b bg-border text-center text-[10px]">
            {(
              [
                ["Update", evo.update],
                ["Stale", evo.staleness],
                ["Regression", evo.regression],
                ["Behavior (unchanged rule)", evo.behavior],
              ] as const
            ).map(([label, s]) => (
              <div key={label} className="bg-background px-1 py-2">
                <div className="text-muted-foreground">{label}</div>
                <div className="font-medium tabular-nums">{fraction(s)}</div>
                <div className="tabular-nums text-muted-foreground">{pct(s)}</div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 border-b px-3 py-3">
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {RESULTS.map((r) => {
              const on = (params.get("result") ?? "all") === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => set({ result: r.key === "all" ? null : r.key, t: null })}
                  className={cn("flex-1 rounded-md px-2 py-1 text-xs", on ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {r.label} <span className="tabular-nums opacity-70">{resultCount(r.key)}</span>
                </button>
              );
            })}
          </div>
          {!hasPassed && (
            <p className="text-[11px] text-muted-foreground">This run was published without its passed conversations; those tickets list with their test case only.</p>
          )}
          <label className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={params.get("find") ?? ""}
              onChange={(e) => set({ find: e.target.value, t: null })}
              placeholder="Search ticket id or title"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {params.get("find") && (
              <button type="button" onClick={() => set({ find: null })} aria-label="Clear search" className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span>
              Filters{active.length ? <span className="ml-1 rounded bg-foreground px-1.5 text-[10px] text-background">{active.length}</span> : null}
            </span>
            <ChevronDown className={cn("size-3.5", open && "rotate-180")} />
          </button>
          {open && (
            <div className="grid grid-cols-2 gap-2">
              {usable.map(({ f, opts }) => (
                <label key={f.key} className="min-w-0 text-[10.5px] text-muted-foreground">
                  {f.label}
                  <Picker
                    label={f.label}
                    menuLabel={false}
                    className={cn("mt-0.5 flex w-full px-1.5 text-foreground", params.get(f.key) && "border-foreground/50")}
                    value={params.get(f.key) ?? ""}
                    onPick={(v) => set({ [f.key]: v, t: null })}
                    options={[{ value: "", text: "Any" }, ...opts.map(({ v, n }) => ({ value: String(v), text: String((f.show ?? String)(v)), meta: String(n) }))]}
                  />
                </label>
              ))}
            </div>
          )}
          {active.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {active.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => set({ [f.key]: null, t: null })}
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px] hover:bg-muted"
                  title={`Remove ${f.label}`}
                >
                  <span className="text-muted-foreground">{f.label}:</span> {(f.show ?? String)(params.get(f.key)!)}
                  <X className="size-3 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {items.length} of {stageItems.length} tickets
          </div>
          {narrowed && (
            <button type="button" onClick={clearAll} className="link-text text-[11px]">
              clear all
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 px-3 pb-6 lg:overflow-y-auto">
          {items.map((t) => {
            const rules = [...new Set(t.failures.flatMap((f) => f.rules.map((r) => r.id)))];
            const blocked = [...new Set(t.blocked.map((b) => b.rule))];
            const q = questionScore(t);
            return (
              <Link key={t.key} href={href({ t: t.id })} scroll={false} className={cn("mb-2 block rounded-lg border border-transparent p-3 transition-colors hover:bg-muted", t.key === selected?.key && "border-border bg-muted")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[13px] font-medium">{t.id}</span>
                  {t.passed ? (
                    <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-400">✓ passed</span>
                  ) : (
                    <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">✗ {t.failures.length}</span>
                  )}
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t.title}</div>
                {(t.group || (q && q.asked > 0)) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {q && q.asked > 0 && (
                      <Chip
                        className={q.relevant < q.asked ? "bg-rose-500/10 text-rose-700 ring-rose-500/30 dark:text-rose-300" : "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300"}
                      >
                        <span title="Customer precision: the agent's questions to the customer that ask for a decisive fact">questions {q.relevant}/{q.asked} relevant</span>
                      </Chip>
                    )}
                    {t.group && <Chip className="font-mono">{t.group}</Chip>}
                    {t.scenario && (
                      <Chip className="font-mono">
                        {t.scenario}
                        {t.realization && t.realization !== "base" ? ` · ${t.realization}` : ""}
                      </Chip>
                    )}
                    {!t.scenario && t.behavior && <Chip>{behaviorLabel(t.behavior)}</Chip>}
                  </div>
                )}
                <FaultTags
                  items={t.failures.filter((f) => f.fault).map((f) => ({
                    side: f.fault!.side,
                    text: f.fault!.taxonomy ? `${f.fault!.text} (${f.fault!.taxonomy.type})` : f.fault!.text,
                    what: failedWhat(f),
                  }))}
                />
                {(rules.length > 0 || blocked.length > 0 || t.crash) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {rules.map((r) => <span key={r} className="rounded bg-background px-1.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-border">{r}</span>)}
                    {blocked.map((r) => <span key={r} className="rounded bg-red-500/10 px-1.5 font-mono text-[10.5px] text-red-600 dark:text-red-400">{r} in the way</span>)}
                    {t.crash && <span className="rounded bg-red-500/10 px-1.5 text-[10.5px] text-red-600 dark:text-red-400">agent error</span>}
                  </div>
                )}
              </Link>
            );
          })}
          {!items.length && (
            <p className="p-3 text-sm text-muted-foreground">
              {stageItems.length ? "No tickets match these filters." : "No tickets in this stage."}{" "}
              {narrowed && stageItems.length > 0 && <TextLink href={`?stage=${stage}`} kind="clear">clear filters</TextLink>}
            </p>
          )}
        </div>
      </aside>
      {selected ? (
        <div className={cn("flex min-h-0 min-w-0 flex-col", !detailOpen && "max-lg:hidden")}>
          <div className="shrink-0 border-b px-4 py-2 lg:hidden">
            <button type="button" onClick={() => set({ t: null })} className="link-text font-sans text-sm">← All tickets</button>
          </div>
          {hasCases && (
            <div className="flex shrink-0 items-center gap-1 border-b px-4 py-2 sm:px-8" role="tablist" aria-label="View">
              {(
                [
                  ["conversation", "Conversation", "What the agent and the customer said, and what went wrong"],
                  ["case", "Test case", "How the grader defines this ticket: customer facts, rules, pass criteria"],
                ] as const
              ).map(([k, label, hint]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={view === k}
                  type="button"
                  title={hint}
                  onClick={() => set({ view: k === "conversation" ? null : k })}
                  className={cn("rounded-md px-3 py-1 text-sm transition-colors", view === k ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {view === "case" && caseById.get(selected.id) ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CaseDetail
                key={selected.key}
                id={selected.id}
                versions={caseById.get(selected.id)!}
                step={selected.cv?.step ?? caseById.get(selected.id)![0].step}
                job={job}
                stageOf={stageOf}
                stageHref={(step) => href({ stage: String(stageOf(step)), t: selected.id })}
                conversationHref={href({ view: null })}
              />
            </div>
          ) : selected.noTrace ? (
            <p className="p-8 text-sm text-muted-foreground">
              No conversation was published for this ticket.{hasCases && " Open its Test case tab for how the grader defines it."}
            </p>
          ) : (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
              <Conversation key={selected.key} ticket={selected} />
            </div>
          )}
        </div>
      ) : (
        <div />
      )}
    </div>
  );
}
