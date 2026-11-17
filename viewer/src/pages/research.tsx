import { use } from "react";
import { useJob } from "@/lib/route";
import Link from "@/components/link";
import { ArrowRight } from "lucide-react";
import { getMeta, getTickets, listJobs, parseRunKey } from "@/lib/data";
import { fmtQ as fmtRate, ticketParties } from "@/lib/knowledge-application";
import { architectureForStage } from "@/lib/runtime-architecture";
import { INFO_TYPES, REPLAY_VERDICTS, stepLabel } from "@/lib/format";
import { VERDICT_COLOR, VERDICT_ORDER } from "@/lib/verdicts";
import { VerdictGuide } from "@/components/verdict-guide";
import { behaviorForStage, fmtQ as fmtBeh, primaryBehaviorStage } from "@/lib/behavior-coverage";
import { evolutionForStage, type CriterionScore } from "@/lib/knowledge-evolution";
import { TICKET_TYPES, TICKET_TYPE_DEFS, TICKET_TYPE_LABEL, ticketTypes } from "@/lib/ticket-types";
import { PARTY_COLOR, PARTY_HINT, PARTY_LABEL } from "@/lib/parties";
import { FAILURE_PARTIES } from "@/lib/knowledge-application";
import { behaviorLabel } from "@/lib/behavior-coverage";
import {
  BarList,
  ChartCard,
  How,
  PartsBar,
  DeltaDots,
  Legend,
  RateBars,
  StageColumns,
  TipRow,
  VIZ,
  type BarRow,
  type Segment,
  type StageColumn,
} from "@/components/charts";

function fmtMin(v: number | null | undefined) {
  return v == null ? "—" : v < 10 ? v.toFixed(1) : Math.round(v).toString();
}

function sumOf(t: NonNullable<Awaited<ReturnType<typeof getMeta>>["timing"]>, key: "build_min" | "grade_min") {
  const vals = Object.values(t.steps).map((s) => s[key]);
  return vals.every((v) => v != null) ? vals.reduce((a, v) => a + (v as number), 0) : null;
}

const frac = (n: number, d: number) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : "—");


/** Everything the Summary and the RQ1, RQ2 and RQ5 tabs show for a run: the numbers and the chart cards. */
export function useRunSummary() {
  const job = useJob();
  const meta = use(getMeta(job));
  const tickets = use(getTickets(job));
  const jobInfo = use(listJobs(parseRunKey(job).task)).find((j) => j.key === job || j.id === parseRunKey(job).job);
  const stages = meta.stages ?? [];
  const sc = (s: number) => meta.scores[String(s)] ?? {};
  const name = (s: number) => stepLabel(sc(s).step, s);

  // RQ1: answerable cases (total − ours), every stage and stage 0.
  const e2e = stages.map((s) => {
    const passed = sc(s).passed ?? 0;
    const answerable = (sc(s).total ?? 0) - (sc(s).ours ?? 0);
    return { stage: s, passed, answerable };
  });
  const allPassed = e2e.reduce((a, r) => a + r.passed, 0);
  const allAnswerable = e2e.reduce((a, r) => a + r.answerable, 0);
  const first = e2e.find((r) => r.stage === 0) ?? e2e[0];

  // RQ2, all stages.
  const verdicts: Record<string, number> = {};
  for (const s of stages) for (const [k, n] of Object.entries(sc(s).replay_verdicts ?? {})) verdicts[k] = (verdicts[k] ?? 0) + n;
  const verdictTotal = Object.values(verdicts).reduce((a, n) => a + n, 0);
  const subsets = stages.map((s) => sc(s).knowledge_application?.subset).filter((x) => !!x);
  const subsetRules = subsets.reduce((n, x) => n + x.rules, 0);
  const subsetKept = subsets.reduce((n, x) => n + x.kept, 0);
  const buckets = ticketParties(tickets);
  const failedAll = Object.values(buckets).reduce((a, n) => a + n, 0);

  // RQ3, all stages.
  const arch = stages.map((s) => architectureForStage(s, sc(s)));
  const classes = [...new Set(arch.map((a) => a.archClass ?? "unknown"))];

  // RQ4: pooled over stages.
  const behPrimary = primaryBehaviorStage(stages.map((s) => behaviorForStage(s, sc(s))));

  // RQ5: knowledge conditions (support-agent-knowledge).
  const kCond = stages
    .map((s) => {
      const cond = sc(s).knowledge_condition ?? (typeof sc(s).step === "string" && /^R/.test(sc(s).step!) ? sc(s).step! : null);
      const qk = sc(s).Qk ?? (sc(s).total ? (sc(s).passed ?? 0) / sc(s).total! : null);
      return cond ? { stage: s, cond, qk, passed: sc(s).passed ?? 0, total: sc(s).total ?? 0 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const complete = kCond.find((r) => r.cond === "Rcomplete" || r.cond === "complete");

  // RQ6: tickets pooled over the stages that test doc changes.
  const evo = stages.map((s) => evolutionForStage(s, sc(s)));
  const evolves = evo.some((r) => !r.update.empty || !r.staleness.empty);
  const pool = (k: "update" | "staleness" | "regression") =>
    evo.reduce((a, r) => (r[k].empty ? a : { passed: a.passed + r[k].passed, total: a.total + r[k].total }), { passed: 0, total: 0 } as CriterionScore);
  // Ticket types (discovery / regression / adaptability) pooled over the stages, when the run's data has them.
  const typedStages = stages.map((s) => ticketTypes(sc(s))).filter((t): t is NonNullable<typeof t> => !!t);
  const poolType = (k: (typeof TICKET_TYPES)[number]) =>
    typedStages.reduce((a, t) => ({ passed: a.passed + t[k].passed, total: a.total + t[k].total }), { passed: 0, total: 0 });
  const pctOf = (c: CriterionScore) => (c.total ? `${((100 * c.passed) / c.total).toFixed(1)}% (${c.passed}/${c.total})` : "—");

  // Cost: the builder from Harbor; bot, customer model, replays and sandboxes from each stage's cost block.
  const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
  const costs = stages.map((s) => sc(s).cost).filter((c) => !!c);
  const sumCost = (f: (c: NonNullable<(typeof costs)[number]>) => number) => costs.reduce((a, c) => a + f(c), 0);
  const graded = costs.length ? sumCost((c) => c.usd) : null;
  const unpriced = sumCost((c) => c.bot.unpriced + c.customer.unpriced + (c.replay_bot?.unpriced ?? 0) + (c.replay_customer?.unpriced ?? 0));
  // A run graded by facts (scripts/fact_run.py) runs no replays; its judge takes their place.
  const factRun = stages.some((s) => sc(s).facts);
  const extraCost = factRun
    ? `judge ${usd(sumCost((c) => c.judge?.usd ?? 0))}`
    : `replays ${usd(sumCost((c) => (c.replay_bot?.usd ?? 0) + (c.replay_customer?.usd ?? 0)))}`;
  const costRow: { rq: string; metric: string; value: string; href: string; note: string; calc?: string } = {
    rq: "Cost",
    metric: "Whole run",
    value: graded == null
      ? `builder ${usd(jobInfo?.cost)}`
      : `${usd((jobInfo?.cost ?? 0) + graded)}: builder ${usd(jobInfo?.cost)} · agent ${usd(sumCost((c) => c.bot.usd))} · customer ${usd(sumCost((c) => c.customer.usd))} · ${extraCost} · sandboxes ${usd(sumCost((c) => c.sandbox.usd))}`,
    href: `/runs/${job}/research/rq1`,
    calc: undefined,
    note: graded == null
      ? "builder from Harbor's result.json · this run was graded before agent, customer and sandbox costs were recorded"
      : `builder from Harbor; models at litellm's list price, sandboxes at Daytona's list rates (${Math.round(sumCost((c) => c.sandbox.seconds) / 60)} sandbox-minutes)${unpriced ? ` · ${unpriced} calls had no price` : ""}`,
  };

  const stageSums = (f: (s: number) => string) => stages.map((s) => `${name(s)} ${f(s)}`).join(" + ");
  const costHow =
    graded == null
      ? `The builder's model cost from Harbor's result.json (${usd(jobInfo?.cost)}). The agent, customer model and sandboxes were not priced when this run was graded.`
      : `Builder ${usd(jobInfo?.cost)} (Harbor's result.json) + every model call the agent, customer model and ${factRun ? "fact judge" : "replays"} made, at litellm's list price + sandbox time at Daytona's list rates, added up over ${costs.length} stages (${Math.round(sumCost((c) => c.sandbox.seconds) / 60)} sandbox-minutes)${unpriced ? `; ${unpriced} calls had no price` : ""}.`;
  // Where the answer comes from, pooled over stages.
  const infoStages = stages.filter((s) => sc(s).info);
  const infoPooled = Object.keys(INFO_TYPES).map((t) => {
    const p = infoStages.reduce((a, s) => {
      const row = sc(s).info!.by_type[t];
      return row ? { passed: a.passed + row.passed, total: a.total + row.total } : a;
    }, { passed: 0, total: 0 });
    return { t, ...p };
  });
  const pairs = infoStages.reduce((a, s) => ({ passed: a.passed + sc(s).info!.pairs_passed, total: a.total + sc(s).info!.pairs }), { passed: 0, total: 0 });

  // Replay verdicts per stage, as 100% of each stage's failed tickets.
  const verdictStages = stages.filter((s) => sc(s).replay_verdicts);
  const verdictKeys = VERDICT_ORDER.filter((k) => verdictStages.some((s) => sc(s).replay_verdicts![k]));
  const verdictColumns: StageColumn[] = verdictStages.map((s) => {
    const v = sc(s).replay_verdicts!;
    const n = Object.values(v).reduce((a, x) => a + x, 0);
    return {
      key: String(s),
      label: name(s),
      href: `?stage=${s}`,
      denominator: sc(s).total,
      sub: sc(s).total ? `${Math.round((100 * (sc(s).passed ?? 0)) / sc(s).total!)}% passed` : undefined,
      top: `${n}/${sc(s).total} failed`,
      segments: verdictKeys.map((k) => ({
        key: k,
        label: REPLAY_VERDICTS[k]?.label ?? k,
        value: v[k] ?? 0,
        color: VERDICT_COLOR[k],
        tip: (
          <>
            <div className="mb-1 font-medium">{name(s)} · {REPLAY_VERDICTS[k]?.label ?? k}</div>
            <TipRow color={VERDICT_COLOR[k]} value={`${v[k] ?? 0} of ${n}`} label="failed tickets" />
            <div className="mt-1 max-w-72 text-muted-foreground">{REPLAY_VERDICTS[k]?.detail}</div>
          </>
        ),
      })),
    };
  });

  // Time per step.
  const timing = meta.timing;
  const timeRows: BarRow[] = timing
    ? Object.entries(timing.steps).map(([step, t]) => ({
        key: step,
        label: step.replace(/^stage(\d+)$/, "stage $1"),
        value: `${fmtMin(t.build_min != null && t.grade_min != null ? t.build_min + t.grade_min : null)} min`,
        parts: [
          { key: "build", label: "build", value: t.build_min ?? 0, color: VIZ[0] },
          { key: "grade", label: "grade", value: t.grade_min ?? 0, color: VIZ[1] },
        ],
        tip: (
          <>
            <div className="mb-1 font-medium">{step}</div>
            <TipRow color={VIZ[0]} value={`${fmtMin(t.build_min)} min`} label="build" />
            <TipRow color={VIZ[1]} value={`${fmtMin(t.grade_min)} min`} label="grade" />
          </>
        ),
      }))
    : [];

  const parts = {
    rq5: (
      <>
      {complete?.qk != null && kCond.length > 1 && (
        <ChartCard
          title="Score drop vs. complete docs, by knowledge condition"
          how={`Score = tickets passed ÷ tickets for the agent built from one pack; every pack is graded on the same ${complete.total} tickets. Drop = complete-docs score − this pack's score, so a dot right of zero is a pack that scored below the complete one.`}
          subtitle={`Drop = complete-docs score − this pack's score on the same tickets; right of zero = worse than the complete pack (complete docs ${complete.qk.toFixed(2)}, ${complete.passed}/${complete.total}). One build per pack, so one ticket moves a score by ${(1 / (complete.total || 1)).toFixed(3)}.`}
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">condition</th>
                  <th className="py-2 pr-3 font-medium">score</th>
                  <th className="py-2 font-medium">drop vs. complete</th>
                </tr>
              </thead>
              <tbody>
                {kCond.map((r) => (
                  <tr key={r.cond} className="border-b border-border/60">
                    <td className="py-2 pr-3">{r.cond}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.qk == null ? "—" : `${r.qk.toFixed(2)} (${r.passed}/${r.total})`}</td>
                    <td className="py-2 tabular-nums">{r.qk == null ? "—" : (complete.qk! - r.qk).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <DeltaDots
            rows={kCond
              .filter((r) => r !== complete && r.qk != null)
              .map((r) => ({
                key: r.cond,
                label: r.cond,
                value: complete.qk! - r.qk!,
                tip: (
                  <>
                    <div className="mb-1 font-medium">{r.cond}</div>
                    <TipRow color={VIZ[0]} value={`${complete.qk! - r.qk! > 0 ? "+" : ""}${(complete.qk! - r.qk!).toFixed(2)}`} label="drop vs. complete docs" />
                    <div className="mt-1 text-muted-foreground">score {r.qk!.toFixed(2)} ({r.passed}/{r.total}) vs complete docs {complete.qk!.toFixed(2)}</div>
                  </>
                ),
              }))}
            left="better than complete"
            right="worse than complete"
          />
        </ChartCard>
      )}
      </>
    ),
    /** `active` marks the stage the page is showing details for. */
    verdicts: (active?: number) => (
      <>
      {verdictColumns.length > 0 && (
        <ChartCard
          title="What went wrong in the failed tickets, by stage"
          scope={{ label: "All stages" }}
          how={factRun ? "No replays: a judge model read each stage's agent files and labelled every fact a ticket needs as right (in the agent's files) or absent, quoting the agent's own text; a model read each conversation for which customer facts the customer gave. A failed ticket is the builder's when a fact deciding a failed check is absent or wrong in the agent; else the agent's: it missed a decisive customer fact, or it had the facts and still got it wrong. A bar's height is the stage's failed tickets ÷ the stage's tickets." : "Each failed ticket is replayed up to three times: (1) with the rule and the customer's facts in the agent's system prompt; if that passes, (2) with the rule alone and (3) with the facts alone. Which replays pass decides its group (see How the groups are decided). A bar's height is the stage's failed tickets ÷ the stage's tickets."}
          subtitle="Each bar is a stage. Its height is the share of that stage's tickets that failed, so a taller bar means more failures. The colours say why each one failed. Click a stage to see its details below."
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">step</th>
                  {verdictKeys.map((k) => (
                    <th key={k} className="py-2 pr-3 font-medium" title={REPLAY_VERDICTS[k]?.detail}>{REPLAY_VERDICTS[k]?.label ?? k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {verdictStages.map((s) => (
                  <tr key={s} className="border-b border-border/60">
                    <td className="py-2 pr-3">{name(s)}</td>
                    {verdictKeys.map((k) => (
                      <td key={k} className="py-2 pr-3 tabular-nums">{sc(s).replay_verdicts![k] ?? 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <StageColumns columns={verdictColumns.map((c) => ({ ...c, selected: active != null && c.key === String(active) }))} inkFirst={false} yMax={Math.max(0.2, Math.ceil(5 * Math.max(0, ...verdictColumns.map((c) => (c.segments.reduce((a, x) => a + x.value, 0)) / (c.denominator || 1)))) / 5)} />
          <VerdictGuide facts={factRun} />
          <Legend items={verdictKeys.map((k): Segment => ({ key: k, label: REPLAY_VERDICTS[k]?.label ?? k, value: verdicts[k] ?? 0, color: VERDICT_COLOR[k] }))} />
        </ChartCard>
      )}
      </>
    ),
    info: (
      <>
      {infoStages.length > 0 && (
        <ChartCard
          title="Pass rate by where the answer comes from · all stages"
          how="Each bar: tickets passed ÷ tickets of that type, every stage added up. Twin pairs: pairs where both tickets passed ÷ pairs."
          subtitle="What a ticket's answer needs: 1 = the API only (a control), 2 = the customer's facts, 3 = an API call built from the customer's info, 4 = a question built from what the API shows. Twin tickets share their opening word for word but have different answers; a pair counts only when both pass, so an agent that guesses instead of asking gets at most one."
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">step</th>
                  {Object.entries(INFO_TYPES).map(([t, label]) => (
                    <th key={t} className="py-2 pr-3 font-medium">{t}. {label}</th>
                  ))}
                  <th className="py-2 pr-3 font-medium">twin pairs, both passed</th>
                  <th className="py-2 font-medium">one half only</th>
                </tr>
              </thead>
              <tbody>
                {infoStages.map((s) => {
                  const info = sc(s).info!;
                  return (
                    <tr key={s} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3">{name(s)}</td>
                      {Object.keys(INFO_TYPES).map((t) => (
                        <td key={t} className="py-2 pr-3 tabular-nums">{info.by_type[t] ? `${info.by_type[t].passed}/${info.by_type[t].total}` : "–"}</td>
                      ))}
                      <td className="py-2 pr-3 tabular-nums">{info.pairs ? `${info.pairs_passed}/${info.pairs}` : "–"}</td>
                      <td className="py-1.5 text-xs">{info.pairs_one_half.map((p) => p.join(" / ")).join(", ") || "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          }
        >
          <RateBars
            rows={[
              ...infoPooled.filter((r) => r.total).map((r) => ({ key: r.t, label: `${r.t}. ${INFO_TYPES[r.t]}`, passed: r.passed, total: r.total })),
              ...(pairs.total ? [{ key: "pairs", label: "twin pairs, both passed", passed: pairs.passed, total: pairs.total }] : []),
            ]}
          />
        </ChartCard>
      )}
      </>
    ),
    time: (
      <>
      {timing && timeRows.length > 0 && (
        <ChartCard
          title={`Time per step · whole run ${fmtMin(timing.total_min)} min`}
          how="From Harbor's result.json: build = the step's agent_execution (start to finish), grade = its verifier run. The whole run is the trial's start to finish, so it also holds setup and the gaps between steps."
          subtitle={`Build = the builder agent working on the agent; grade = the agent answering every ticket with the customer model, then grading and replays. Setup (installing the builder) ${fmtMin(timing.setup_min)} min; the whole run also includes the short gaps between steps. From Harbor's result.json.`}
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">step</th>
                  <th className="py-2 pr-3 font-medium">build (min)</th>
                  <th className="py-2 pr-3 font-medium">grade (min)</th>
                  <th className="py-2 font-medium">step total (min)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(timing.steps).map(([step, t]) => (
                  <tr key={step} className="border-b border-border/60">
                    <td className="py-2 pr-3">{step}</td>
                    <td className="py-2 pr-3 tabular-nums">{fmtMin(t.build_min)}</td>
                    <td className="py-2 pr-3 tabular-nums">{fmtMin(t.grade_min)}</td>
                    <td className="py-2 tabular-nums">{fmtMin(t.build_min != null && t.grade_min != null ? t.build_min + t.grade_min : null)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">whole run</td>
                  <td className="py-2 pr-3 tabular-nums">{fmtMin(sumOf(timing, "build_min"))}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmtMin(sumOf(timing, "grade_min"))}</td>
                  <td className="py-2 tabular-nums">{fmtMin(timing.total_min)}</td>
                </tr>
              </tbody>
            </table>
          }
        >
          <Legend
            items={[
              { key: "build", label: "build", value: Math.round(sumOf(timing, "build_min") ?? 0), color: VIZ[0] },
              { key: "grade", label: "grade", value: Math.round(sumOf(timing, "grade_min") ?? 0), color: VIZ[1] },
            ]}
          />
          <div className="mt-3">
            <BarList rows={timeRows} />
          </div>
        </ChartCard>
      )}
      </>
    ),
  };
  return {
    meta, stages, sc, name, e2e, allPassed, allAnswerable, first, kCond, complete, costRow: { ...costRow, calc: costHow }, parts,
    typedStages, poolType, evolves, pool, pctOf, buckets, failedAll, subsetKept, subsetRules, factRun, behPrimary, classes, verdictTotal, jobInfo, usd, graded, sumCost, extraCost,
  };
}

const pc = (p: number, t: number) => (t ? `${Math.round((100 * p) / t)}%` : "—");

/** A headline card: one big number in words and the formula in the page (not a tooltip). */
function Card({ title, children, calc, className }: { title: string; children: React.ReactNode; calc?: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border px-5 py-4 ${className ?? ""}`}>
      <div className="font-sans text-xs font-medium text-muted-foreground">{title}</div>
      <div className="mt-2">{children}</div>
      {calc && (
        <details className="mt-3 font-sans text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">How is this calculated?</summary>
          <div className="mt-1.5 max-w-prose leading-relaxed">{calc}</div>
        </details>
      )}
    </div>
  );
}

function Big({ passed, total }: { passed: number; total: number }) {
  return (
    <div className="font-sans text-2xl font-semibold tracking-tight">
      {passed} <span className="text-base font-normal text-muted-foreground">of {total} ({pc(passed, total)})</span>
    </div>
  );
}

function MiniRate({ label, def, passed, total }: { label: string; def?: string; passed: number; total: number }) {
  return (
    <div title={def}>
      <div className="flex items-baseline justify-between gap-3 font-sans text-xs">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{passed}/{total} · {pc(passed, total)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full rounded bg-foreground/70" style={{ width: `${total ? (100 * passed) / total : 0}%` }} /></div>
    </div>
  );
}

export default function OverviewPage() {
  const job = useJob();
  const r = useRunSummary();
  const { allPassed, allAnswerable, first, name, stages } = r;
  const typed = r.typedStages.length > 0;
  const types = TICKET_TYPES.map((k) => ({ k, ...r.poolType(k) })).filter((t) => t.total);

  // Failures by party; a party with none is left out (harness is usually 0).
  const parties = [...FAILURE_PARTIES, "none"].map((k) => ({ k, n: Math.round(10 * (r.buckets[k as keyof typeof r.buckets] ?? 0)) / 10 })).filter((x) => x.n > 0);
  const failed = Math.round(r.failedAll || parties.reduce((a, x) => a + x.n, 0));
  const share = (k: string) => pc(parties.find((x) => x.k === k)?.n ?? 0, failed);

  const cov = r.behPrimary?.coverage?.by_category ?? {};
  const covRows = Object.entries(cov).filter(([, c]) => c.total >= 5).map(([k, c]) => ({ k, rate: c.passed / c.total, ...c }));
  covRows.sort((a, b) => a.rate - b.rate);


  const next: { href: string; label: string; text: React.ReactNode }[] = [
    {
      href: `/runs/${job}/research/rq1`,
      label: "Scores by stage",
      text: typed
        ? <>Across {stages.length} stages: {types.map((t) => `${TICKET_TYPE_LABEL[t.k].split(" (")[0].toLowerCase()} ${pc(t.passed, t.total)}`).join(" · ")}.</>
        : <>How the pass rate moves from stage to stage.</>,
    },
    ...(failed
      ? [{
          href: `/runs/${job}/research/acquisition`,
          label: "Failure analysis",
          text: <>Of {failed} failed tickets, {parties.filter((x) => x.k === "Builder" || x.k === "Bot").map((x) => `${share(x.k)} were ${PARTY_LABEL[x.k].toLowerCase()}s`).join(" and ")}. Pick a stage to see which facts were missing.</>,
        }]
      : []),
    {
      href: `/runs/${job}/research/architecture`,
      label: "Agent design",
      text: <>{r.classes.length === 1 ? `Knowledge reaches the model through ${r.classes[0]}.` : "The design changes between stages."} Reply speed, and the agent&apos;s code stage by stage.</>,
    },
    ...(covRows.length
      ? [{
          href: `/runs/${job}/research/behavior`,
          label: "Customer types",
          text: <>Pass rate runs from {pc(covRows[0].passed, covRows[0].total)} ({behaviorLabel(covRows[0].k)} customers) to {pc(covRows.at(-1)!.passed, covRows.at(-1)!.total)} ({behaviorLabel(covRows.at(-1)!.k)}).</>,
        }]
      : []),
    {
      href: `/runs/${job}/tickets`,
      label: "Tickets",
      text: <>Read any of the {allAnswerable} tickets: the conversation, or how the grader defines it (customer facts, rules, pass criteria).</>,
    },
    ...(r.complete?.qk != null && r.kCond.length > 1
      ? [{ href: `/runs/${job}/research/rq5`, label: "Doc packaging", text: <>How much each way of packaging the docs costs against the complete docs.</> }]
      : []),
  ];

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        The whole run, every stage added up. Each card says what is counted.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card
          title="Tickets passed"

          calc={`Tickets passed ÷ tickets, each stage added up: ${r.e2e.map((x) => `${x.passed}/${x.answerable}`).join(" + ")} = ${allPassed}/${allAnswerable}. Tickets lost to our side (time limit, provider error) do not count.`}
        >
          <Big passed={allPassed} total={allAnswerable} />
          {first && (
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              After the first build ({name(first.stage)}): {first.passed} of {first.answerable} ({pc(first.passed, first.answerable)}).
            </p>
          )}
        </Card>

        <Card
          title="Old vs. new tickets"

          calc={typed
            ? `For each kind: tickets passed ÷ tickets of that kind, every stage added up. New = a ticket no earlier stage had; old tickets, old facts = an earlier stage's ticket whose expected answer did not change; old tickets, new facts = an earlier stage's ticket whose expected answer changed with the docs. Every ticket is exactly one kind.`
            : undefined}
        >
          {typed ? (
            <div className="space-y-3">
              {types.map((t) => <MiniRate key={t.k} label={TICKET_TYPE_LABEL[t.k]} def={TICKET_TYPE_DEFS[t.k]} passed={t.passed} total={t.total} />)}
            </div>
          ) : r.evolves ? (
            <div className="space-y-3">
              <MiniRate label="Tickets on new or changed rules (update)" passed={r.pool("update").passed} total={r.pool("update").total} />
              <MiniRate label="Tickets on changed rules only (staleness)" passed={r.pool("staleness").passed} total={r.pool("staleness").total} />
              <MiniRate label="Tickets on unchanged rules (regression)" passed={r.pool("regression").passed} total={r.pool("regression").total} />
            </div>
          ) : (
            <p className="font-sans text-sm text-muted-foreground">This run does not change the docs between stages.</p>
          )}
        </Card>

        <Card
          title="Why tickets fail"

          calc={failed ? `Each failed ticket counts once, split evenly between the parties its blame records name (blamed on both = ½ each). ${parties.map((x) => `${PARTY_LABEL[x.k]} ${x.n}`).join(" + ")} = ${failed} failed tickets. ${FAILURE_PARTIES.filter((k) => parties.some((x) => x.k === k)).map((k) => `${PARTY_LABEL[k]}: ${PARTY_HINT[k]}.`).join(" ")}` : undefined}
        >
          {failed ? (
            <>
              <div className="font-sans text-2xl font-semibold tracking-tight">
                {failed} <span className="text-base font-normal text-muted-foreground">failed tickets</span>
              </div>
              <div className="mt-3">
                <PartsBar
                  segments={parties.map((x) => ({
                    key: x.k,
                    label: PARTY_LABEL[x.k],
                    value: x.n,
                    color: PARTY_COLOR[x.k] ?? "color-mix(in oklab, var(--muted-foreground) 64%, transparent)",
                    def: PARTY_HINT[x.k],
                  }))}
                />
              </div>
            </>
          ) : (
            <p className="font-sans text-sm text-muted-foreground">No failed tickets.</p>
          )}
        </Card>

        <Card
          title="Builder cost per stage"
          calc={r.jobInfo?.cost != null ? `The builder's model cost from Harbor's result.json (${r.usd(r.jobInfo.cost)}) ÷ ${stages.length} stages. Harbor reports one cost for the whole run, so this is an average.` : undefined}
        >
          <div className="font-sans text-2xl font-semibold tracking-tight">
            {r.jobInfo?.cost != null ? r.usd(r.jobInfo.cost / Math.max(1, stages.length)) : "—"}
            <span className="ml-2 text-base font-normal text-muted-foreground">per stage</span>
          </div>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            {r.jobInfo?.cost != null ? `${r.usd(r.jobInfo.cost)} for the builder over ${stages.length} stages.` : "The builder's cost was not recorded for this run."}
          </p>
          {r.graded != null && (
            <details className="mt-3 font-sans text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">All costs of the run: {r.usd((r.jobInfo?.cost ?? 0) + r.graded)}</summary>
              <ul className="mt-1.5 space-y-0.5 tabular-nums">
                <li>Builder {r.usd(r.jobInfo?.cost)}</li>
                <li>Agent {r.usd(r.sumCost((c) => c.bot.usd))}</li>
                <li>Customer model {r.usd(r.sumCost((c) => c.customer.usd))}</li>
                <li>{r.extraCost.replace(/^./, (c) => c.toUpperCase())}</li>
                <li>Sandboxes {r.usd(r.sumCost((c) => c.sandbox.usd))}</li>
              </ul>
              <p className="mt-1.5 max-w-prose leading-relaxed">{r.costRow.calc}</p>
            </details>
          )}
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Link href={`/runs/${job}/tickets`} className="group flex items-center justify-between gap-6 rounded-xl border bg-card px-6 py-8 hover:border-foreground/30 sm:px-8 sm:py-10">
          <div>
            <div className="font-sans text-2xl font-semibold tracking-tight group-hover:underline">See Trajectories</div>
            <p className="mt-2 max-w-xl font-sans text-sm leading-relaxed text-muted-foreground">
              Read any of the {allAnswerable} tickets: the full conversation and what the agent did, or how the grader defines the ticket
              (customer facts, rules, pass criteria).
            </p>
          </div>
          <ArrowRight className="size-6 shrink-0 text-muted-foreground group-hover:text-foreground" />
        </Link>
        <Link href={`/runs/${job}/research/architecture`} className="group flex items-center justify-between gap-6 rounded-xl border bg-card px-6 py-8 hover:border-foreground/30 sm:px-8 sm:py-10">
          <div>
            <div className="font-sans text-2xl font-semibold tracking-tight group-hover:underline">See Agent design</div>
            <p className="mt-2 max-w-xl font-sans text-sm leading-relaxed text-muted-foreground">
              How the agent the builder made gets its knowledge, how fast it replies, and the code it wrote, stage by stage.
            </p>
          </div>
          <ArrowRight className="size-6 shrink-0 text-muted-foreground group-hover:text-foreground" />
        </Link>
      </div>
    </div>
  );
}
