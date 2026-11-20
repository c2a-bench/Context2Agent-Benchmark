import { use, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router";
import { currentSearchParams, useJob } from "@/lib/route";
import { getMeta, getTickets } from "@/lib/data";
import { ALL, StageBar, stageName, useStage } from "@/components/stage-select";
import Link, { TextLink } from "@/components/link";
import { ChartCard, Defined, Legend, StageColumns, TipRow, type Segment, type StageColumn } from "@/components/charts";
import { PARTY_COLOR, PARTY_HINT, PARTY_LABEL } from "@/lib/parties";
import { defOf, groupDef, NONE, PARTIES, rollup, specRank, under, withGap, type Rollup } from "@/lib/failure-types";
import { stepLabel } from "@/lib/format";
import type { Meta, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";

const NONE_COLOR = "color-mix(in oklab, var(--muted-foreground) 45%, transparent)";
const colorOf = (party: string) => (party === NONE ? NONE_COLOR : PARTY_COLOR[party] ?? NONE_COLOR);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");

/** Sum of several rollups (the pooled view over every stage). */
function sum(list: Rollup[]): Rollup {
  const out: Rollup = { failed: 0, parties: {}, groups: {}, leaves: {}, info: {} };
  for (const r of list) {
    out.failed += r.failed;
    Object.assign(out.info, r.info);
    for (const k of ["parties", "groups", "leaves"] as const) for (const [key, n] of Object.entries(r[k])) out[k][key] = (out[k][key] ?? 0) + n;
  }
  return out;
}

/** 1. The headline: how many tickets failed, and whose responsibility that was. */
function Headline({ r, total, scope }: { r: Rollup; total: number; scope: string }) {
  const parties = [...PARTIES, NONE].filter((p) => (r.parties[p] ?? 0) > 0.001);
  const segs: Segment[] = parties.map((p) => ({ key: p, label: p === NONE ? PARTY_LABEL.none : PARTY_LABEL[p], value: r.parties[p], color: colorOf(p), def: p === NONE ? "A failed ticket the grader could not attribute." : `${PARTY_HINT[p]}.` }));
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-sans text-3xl font-semibold tabular-nums tracking-tight">{Math.round(r.failed)}</span>
        <span className="font-sans text-sm text-muted-foreground">
          of {total} tickets failed ({pct(r.failed, total)}) · {scope}
        </span>
      </div>
      <div className="mt-3 flex h-6 gap-[2px] overflow-hidden rounded">
        {segs.map((s) => (
          <div key={s.key} className="flex items-center justify-center font-sans text-[11px] font-medium tabular-nums text-white" style={{ flexGrow: s.value, flexBasis: 0, background: s.color }} title={`${s.label}: ${fmt(Math.round(s.value * 10) / 10)}`}>
            {s.value / (r.failed || 1) > 0.08 ? fmt(Math.round(s.value * 10) / 10) : ""}
          </div>
        ))}
      </div>
      <Legend items={segs.map((s) => ({ ...s, value: Math.round(s.value * 10) / 10 }))} total={Math.round(r.failed)} />
      <p className="mt-2 font-sans text-xs text-muted-foreground">
        A ticket blamed on two parties counts half in each.
        {!parties.includes("Harness") && " No harness failures."}
      </p>
    </section>
  );
}

/** 2. Failed tickets at each stage, by party. A taller bar is a bigger share of the stage's tickets failing. */
function ByStage({ meta, per }: { meta: Meta; per: { st: number; r: Rollup; total: number; passed: number }[] }) {
  const keys = [...PARTIES, NONE].filter((p) => per.some((x) => (x.r.parties[p] ?? 0) > 0.001));
  const name = (st: number) => stepLabel(meta.scores[String(st)]?.step, st);
  const yMax = Math.max(0.2, Math.ceil(5 * Math.max(0, ...per.map((x) => (x.total ? x.r.failed / x.total : 0)))) / 5);
  const columns: StageColumn[] = per.map(({ st, r, total, passed }) => ({
    key: String(st),
    label: name(st),
    denominator: total,
    sub: total ? `${Math.round((100 * passed) / total)}% passed` : undefined,
    top: `${Math.round(r.failed)}/${total} failed`,
    segments: keys.map((k) => ({
      key: k,
      label: k === NONE ? PARTY_LABEL.none : PARTY_LABEL[k],
      value: Math.round((r.parties[k] ?? 0) * 10) / 10,
      color: colorOf(k),
      tip: (
        <>
          <div className="mb-1 font-medium">{name(st)} · {k === NONE ? PARTY_LABEL.none : PARTY_LABEL[k]}</div>
          <TipRow color={colorOf(k)} value={`${fmt(Math.round((r.parties[k] ?? 0) * 10) / 10)} of ${total} tickets`} label={pct(r.parties[k] ?? 0, total)} />
        </>
      ),
    })),
  }));
  const legend: Segment[] = keys.map((k) => ({ key: k, label: k === NONE ? PARTY_LABEL.none : PARTY_LABEL[k], value: Math.round(10 * per.reduce((a, x) => a + (x.r.parties[k] ?? 0), 0)) / 10, color: colorOf(k) }));
  return (
    <ChartCard
      className="mt-10"
      title="Failed tickets, by stage"
      how="Each bar is a stage. Its height is the stage's failed tickets ÷ the stage's tickets, so a taller bar means more of that stage failed. The colours say whose responsibility the failures were; a ticket blamed on two parties counts half in each."
      subtitle="A taller bar is a stage where more tickets failed. The label above each bar is the pass rate. To look at one stage, pick it in the Stage menu at the top."
      table={
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">stage</th>
              <th className="py-2 pr-3 font-medium">tickets</th>
              <th className="py-2 pr-3 font-medium">passed</th>
              {keys.map((k) => <th key={k} className="py-2 pr-3 font-medium">{k === NONE ? PARTY_LABEL.none : PARTY_LABEL[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {per.map((x) => (
              <tr key={x.st} className="border-b border-border/60">
                <td className="py-2 pr-3">{name(x.st)}</td>
                <td className="py-2 pr-3 tabular-nums">{x.total}</td>
                <td className="py-2 pr-3 tabular-nums">{x.passed}</td>
                {keys.map((k) => <td key={k} className="py-2 pr-3 tabular-nums">{fmt(Math.round((x.r.parties[k] ?? 0) * 10) / 10)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <StageColumns columns={columns} inkFirst={false} yMax={yMax} />
      <Legend items={legend} />
    </ChartCard>
  );
}

type RowProps = { level: 0 | 1 | 2; label: string; def?: string; n: number; failed: number; color: string; id: string; picked: boolean; onPick: (id: string) => void };

function Row({ level, label, def, n, failed, color, id, picked, onPick }: RowProps) {
  const v = Math.round(n * 10) / 10;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={picked}
      title={`${label}: ${fmt(v)} of ${Math.round(failed)} failed tickets`}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded px-2 py-1.5 text-left font-sans outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_8rem_auto]",
        picked && "bg-muted ring-1 ring-foreground/40",
        level === 0 && "mt-2 first:mt-0",
      )}
    >
      <span className={cn("min-w-0 truncate max-sm:col-start-1 max-sm:row-start-1", level === 0 ? "text-sm font-semibold" : "text-xs", level === 1 && "pl-4 font-medium", level === 2 && "pl-8")}>
        <Defined def={def}>{label}</Defined>
      </span>
      {/* Bars only on the types: they add up to every failed ticket, so the parties and groups need none. */}
      <span className={cn("sm:col-start-2", level === 2 ? "max-sm:col-span-2 max-sm:row-start-2" : "max-sm:hidden")}>
        {level === 2 && <span className="block h-2 rounded-r" style={{ width: `${Math.max(1, (100 * n) / (failed || 1))}%`, background: color }} />}
      </span>
      <span className={cn("text-right text-xs tabular-nums max-sm:col-start-2 max-sm:row-start-1 sm:col-start-3", level === 2 ? "text-muted-foreground" : "font-medium text-foreground")}>
        {pct(n, failed)}
      </span>
    </button>
  );
}

/** 3. What went wrong: party, then group, then type, one list. Click a row to see its tickets. */
function Breakdown({ r, pick, onPick }: { r: Rollup; pick: string | null; onPick: (id: string) => void }) {
  const failed = r.failed;
  const parties = [...PARTIES, NONE].filter((p) => (r.parties[p] ?? 0) > 0.001);
  const groupsOf = (p: string) =>
    Object.keys(r.groups)
      .filter((k) => k.startsWith(`${p}|`) || (p === NONE && k === NONE))
      .sort((a, b) => r.groups[b] - r.groups[a]);
  const leavesOf = (gk: string) =>
    Object.keys(r.leaves)
      .filter((k) => k !== NONE && `${r.info[k].party}|${r.info[k].group}` === gk)
      .sort((a, b) => r.leaves[b] - r.leaves[a] || specRank(r.info[a]) - specRank(r.info[b]));
  const table = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">party</th>
          <th className="py-2 pr-3 font-medium">group</th>
          <th className="py-2 pr-3 font-medium">type</th>
          <th className="py-2 pr-3 font-medium">failed tickets</th>
          <th className="py-2 font-medium">share</th>
        </tr>
      </thead>
      <tbody>
        {Object.keys(r.leaves).sort((a, b) => r.leaves[b] - r.leaves[a]).map((k) => (
          <tr key={k} className="border-b border-border/60">
            <td className="py-2 pr-3">{r.info[k].party === NONE ? "—" : PARTY_LABEL[r.info[k].party]}</td>
            <td className="py-2 pr-3">{r.info[k].group}</td>
            <td className="py-2 pr-3">{r.info[k].type}</td>
            <td className="py-2 pr-3 tabular-nums">{fmt(Math.round(r.leaves[k] * 10) / 10)}</td>
            <td className="py-2 tabular-nums">{pct(r.leaves[k], failed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard
      className="mt-0"
      title="What went wrong"
      how={`Three levels: who is responsible (party), what kind of problem (group), and the specific problem (type). Each failed ticket counts once, split evenly between the parties it is blamed on and then between that party's types, so the parts add up to the ${Math.round(failed)} failed tickets. Each bar is its share of all failed tickets in this scope. Click a row to list its tickets.`}
      subtitle="Click a row to see its tickets."
      table={table}
    >
      <div>
        {parties.map((p) => (
          <div key={p}>
            <Row level={0} label={p === NONE ? PARTY_LABEL.none : PARTY_LABEL[p]} def={p === NONE ? "A failed ticket the grader could not attribute." : `${PARTY_HINT[p]}.`} n={r.parties[p]} failed={failed} color={colorOf(p)} id={p} picked={pick === p} onPick={onPick} />
            {p !== NONE &&
              groupsOf(p).map((gk) => {
                const group = gk.slice(p.length + 1);
                return (
                  <div key={gk}>
                    <Row level={1} label={group} def={groupDef(group)} n={r.groups[gk]} failed={failed} color={colorOf(p)} id={gk} picked={pick === gk} onPick={onPick} />
                    {leavesOf(gk).map((lk) => (
                      <Row key={lk} level={2} label={r.info[lk].type} def={defOf(r.info[lk])} n={r.leaves[lk]} failed={failed} color={colorOf(p)} id={lk} picked={pick === lk} onPick={onPick} />
                    ))}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

/** 4. The failed tickets behind the picked row (or all of them). */
function TicketList({ meta, tickets, job, stage, pick, pickLabel, counted }: { meta: Meta; tickets: Ticket[]; job: string; stage: number | typeof ALL; pick: string | null; pickLabel: string; /** failed tickets the scores count here (for the picked row, or all) */ counted: number }) {
  const rows = tickets
    .filter((t) => !t.passed)
    .map((t) => ({ t, leaves: rollup([t]).info }))
    .filter(({ leaves }) => !pick || Object.keys(leaves).some((k) => under(k, pick)));
  const here = useRef<HTMLElement>(null);
  useEffect(() => {
    if (pick && window.innerWidth < 1024) here.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pick]);
  const link = `/runs/${job}/tickets?result=failed${stage === ALL ? "" : `&stage=${stage}`}${pick ? `&pick=${encodeURIComponent(pick)}` : ""}`;
  // Failures the score counts but this publication has no ticket record for (older runs): say so instead of listing fewer.
  const unlisted = pick && pick !== NONE ? 0 : Math.round(counted) - rows.length;
  return (
    <section ref={here} className="scroll-mt-28">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-sans text-[15px] font-semibold tracking-tight">
          {pick ? pickLabel : "All failed tickets"} <span className="font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        <TextLink href={link} className="font-sans text-xs">Open in Trajectories</TextLink>
      </div>
      {unlisted > 0 && (
        <p className="mt-3 font-sans text-xs text-muted-foreground">
          {unlisted} failed {unlisted === 1 ? "ticket" : "tickets"} counted in the scores {unlisted === 1 ? "has" : "have"} no ticket record in this publication, so {unlisted === 1 ? "it is" : "they are"} not listed.
        </p>
      )}
      {/* a fixed height, so picking another row never moves the page */}
      <ul className="mt-3 divide-y divide-border/60 overflow-y-auto rounded-lg border max-lg:max-h-[70vh] lg:h-[min(70vh,560px)]">
        {rows.map(({ t, leaves }) => (
          <li key={t.key}>
            <Link href={`/runs/${job}/tickets?stage=${t.stage}&t=${encodeURIComponent(t.id)}`} className="group/t flex items-center gap-3 px-3 py-2 font-sans outline-none hover:bg-muted/60 focus-visible:bg-muted/60">
              <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[13px] font-medium">{t.id}</span>
                {stage === ALL && <span className="text-xs text-muted-foreground">{stageName(meta, t.stage)}</span>}
                {/* the failure types only when listing every type; under a picked type they would repeat it */}
                {!pick && Object.values(leaves).map((l) => (
                  <span key={l.key} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="size-2 rounded-sm" style={{ background: colorOf(l.party) }} />
                    {l.type}
                  </span>
                ))}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground" title={t.title}>{t.title}</div>
              </div>
              {/* opens the ticket: the conversation and what the agent did */}
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover/t:text-foreground">
                <span className="hidden group-hover/t:inline">Open</span>
                <ChevronRight className="size-4" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
        {!rows.length && <li className="px-3 py-2 font-sans text-sm text-muted-foreground">No tickets here.</li>}
      </ul>
    </section>
  );
}

function FactGradedFailureAnalysis() {
  const job = useJob();
  const meta = use(getMeta(job));
  const tickets = use(getTickets(job));
  const { stage, set } = useStage(meta, true, true);
  const [params, setParams] = useSearchParams();
  const per = meta.stages.map((st) => {
    const sc = meta.scores[String(st)] ?? {};
    const total = sc.total ?? 0;
    const passed = sc.passed ?? 0;
    const r = withGap(rollup(tickets.filter((t) => t.stage === st)), total - passed);
    return { st, r, total, passed };
  });
  const cur = stage === ALL ? sum(per.map((x) => x.r)) : per.find((x) => x.st === stage)!.r;
  const total = stage === ALL ? per.reduce((a, x) => a + x.total, 0) : per.find((x) => x.st === stage)!.total;
  const label = stage === ALL ? "All stages" : stageName(meta, stage);
  const scoped = stage === ALL ? tickets : tickets.filter((t) => t.stage === stage);
  const want = params.get("pick");
  const pick = want && Object.keys(cur.leaves).some((k) => under(k, want)) ? want : null;
  const onPick = (id: string) => {
    const next = currentSearchParams();
    if (pick === id) next.delete("pick");
    else next.set("pick", id);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const pickLabel = pick ? pick.split("|").slice(-1)[0] : "";

  return (
    <div>
      <div className="mx-auto max-w-5xl px-6 pt-10">
        <h1 className="font-heading text-3xl font-normal tracking-tight">Failure analysis</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Why tickets failed, and whose responsibility it was: the builder (what it built), the agent (what it did) or our test setup.</p>
      </div>
      <StageBar meta={meta} stage={stage} onChange={set} allowAll className="mt-6" note="Everything below follows this." />
      <div className="mx-auto max-w-5xl px-6 pb-12">
        <Headline r={cur} total={total} scope={label} />
        {stage === ALL && <ByStage meta={meta} per={per} />}
        <div className="mt-12 grid items-start gap-10 lg:grid-cols-2">
          <Breakdown r={cur} pick={pick} onPick={onPick} />
          <TicketList meta={meta} tickets={scoped} job={job} stage={stage} pick={pick} pickLabel={pickLabel} counted={pick === NONE ? cur.leaves[NONE] ?? 0 : cur.failed} />
        </div>
      </div>
    </div>
  );
}

/** Every run is graded by the fact judge, so the page always shows its breakdown. */
export default function AcquisitionPage() {
  return <FactGradedFailureAnalysis />;
}
