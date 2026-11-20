import { use } from "react";
import { useJob } from "@/lib/route";
import { ALL, StageBar, useStage } from "@/components/stage-select";
import Link, { TextLink } from "@/components/link";
import { getInteractions, getMeta } from "@/lib/data";
import {
  ALL_STAGES,
  ATTRIBUTION_KINDS,
  ATTRIBUTION_LABELS,
  CATEGORY_ORDER,
  baselineKey,
  behaviorFamily,
  behaviorForStage,
  behaviorLabel,
  BEHAVIOR_DEFS,
  categoryLabel,
  familyRates,
  fmtQ,
  primaryBehaviorStage,
  sortBehaviors,
} from "@/lib/behavior-coverage";
import type { BehaviorStage } from "@/lib/behavior-coverage";
import type { FactsScore, GroupScore, StageScore, Ticket } from "@/lib/types";
import { cn } from "@/lib/utils";
import { stepLabel } from "@/lib/format";
import { ChartCard, Defined, How, RateBars, TipRow, VIZ } from "@/components/charts";

function Stat({ k, v, note, how }: { k: string; v: string; note?: string; how?: string }) {
  return (
    <div className="rounded-lg border px-4 py-4">
      <div className="font-sans text-xs text-muted-foreground">{k}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">
        <How how={how}>{v}</How>
      </div>
      {note && <div className="mt-1 font-sans text-[11px] leading-relaxed text-muted-foreground">{note}</div>}
    </div>
  );
}

function RateTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; passed: number; total: number; q?: number; extra?: string }[];
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-8">
      <h2 className="font-sans text-sm font-semibold">{title}</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 font-medium">key</th>
            <th className="py-2 pr-3 font-medium">passed</th>
            <th className="py-2 pr-3 font-medium">total</th>
            <th className="py-2 font-medium">rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const q = row.q ?? (row.total ? row.passed / row.total : 0);
            return (
              <tr key={row.key} className="border-b border-border/60">
                <td className="py-2 pr-3">
                  {row.key}
                  {row.extra ? (
                    <span className="ml-2 text-xs text-muted-foreground">{row.extra}</span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 tabular-nums">{row.passed}</td>
                <td className="py-2 pr-3 tabular-nums">{row.total}</td>
                <td className="py-2 tabular-nums">{fmtQ(q)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function signed(d: number | null): string {
  if (d == null || Number.isNaN(d)) return "—";
  const v = d.toFixed(2);
  return d > 0 ? `+${v}` : v === "-0.00" ? "0.00" : v;
}



/** Per-ticket format: one customer behavior subcategory per ticket; baseline is the control. */
function PerTicketTables({
  coverage,
  attribution,
  scope,
  tickets,
  factsBy,
}: {
  /** Decisive customer facts the agent got, by behavior (a run graded by facts; replaces the behavior replay). */
  factsBy?: FactsScore["by_behavior"] | null;
  scope: string;
  /** This scope's tickets (one stage, or every stage). */
  tickets: Ticket[];
  coverage: NonNullable<BehaviorStage["coverage"]>;
  attribution: BehaviorStage["ticketAttribution"];
}) {
  const byCat = coverage.by_category ?? {};
  const keys = sortBehaviors(Object.keys(byCat));
  const baseKey = baselineKey(keys);
  const baseRow = baseKey ? byCat[baseKey] : undefined;
  const base = baseRow?.total ? baseRow.passed / baseRow.total : null;
  const families = familyRates(coverage);
  const attrKeys = sortBehaviors(Object.keys(attribution?.by_behavior ?? {}));
  // Behavior replay: each failed ticket whose rule + facts replay passed is run again with the baseline customer
  // (facts given, no rule). Passing then means the ticket's customer behavior cost it; the baseline's own row is the
  // control (its customer does not change).
  const replayRows = attrKeys
    .map((b) => ({ b, v: attribution!.by_behavior[b] }))
    .filter(({ v }) => (v.plain_replayed ?? 0) > 0);
  const baseReplay = baseKey ? attribution?.by_behavior[baseKey] : undefined;
  const baseRate = baseReplay?.plain_replayed ? (baseReplay.plain_passed ?? 0) / baseReplay.plain_replayed : null;
  const replayTotal = replayRows.reduce((a, { v }) => a + (v.plain_replayed ?? 0), 0);
  const replayPassed = replayRows.reduce((a, { v }) => a + (v.plain_passed ?? 0), 0);
  const scopeTag = scope === "all stages" ? { label: "All stages" } : { label: scope, stage: true };
  const factRows = sortBehaviors(Object.keys(factsBy ?? {})).filter((b) => (factsBy![b].decisive ?? 0) > 0);
  const baseFacts = baseKey && factsBy?.[baseKey]?.decisive ? factsBy[baseKey].obtained / factsBy[baseKey].decisive : null;
  return (
    <>
      {factsBy && factRows.length > 0 && (
        <ChartCard
          title="Did the agent get the customer's facts?"
          scope={scopeTag}
          how="A model read each conversation and marked which of the ticket's customer facts the customer told the agent (the opening counts). Each bar: decisive facts the agent got ÷ decisive facts, over the tickets with that behavior. The line is the plain (baseline) customer's rate."
          subtitle="For each customer behavior, the share of the facts only the customer knows (and the ticket needs) that the agent got out of the conversation. A bar left of the line means that behavior made the agent miss more facts than with a plain customer. Replaces the behavior replay: nothing is run again. Hover a behavior for what it is."
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">behavior</th>
                  <th className="py-2 pr-3 font-medium">tickets</th>
                  <th className="py-2 pr-3 font-medium">decisive facts got</th>
                  <th className="py-2 font-medium">failed tickets missing one</th>
                </tr>
              </thead>
              <tbody>
                {factRows.map((b) => (
                  <tr key={b} className="border-b border-border/60">
                    <td className="py-2 pr-3">{behaviorLabel(b)}</td>
                    <td className="py-2 pr-3 tabular-nums">{factsBy![b].tickets}</td>
                    <td className="py-2 pr-3 tabular-nums">{factsBy![b].obtained}/{factsBy![b].decisive}</td>
                    <td className="py-2 tabular-nums">{factsBy![b].failed_missed}/{factsBy![b].failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <RateBars
            color={VIZ[0]}
            reference={baseFacts == null ? undefined : { value: baseFacts, label: `baseline ${baseFacts.toFixed(2)}` }}
            rows={factRows.map((b) => {
              const v = factsBy![b];
              return {
                key: b,
                group: behaviorFamily(b),
                label: <Defined def={BEHAVIOR_DEFS[b]}>{behaviorLabel(b)}</Defined>,
                passed: v.obtained,
                total: v.decisive,
                tip: (
                  <>
                    <div className="mb-1 font-medium">{behaviorLabel(b)}</div>
                    <TipRow color={VIZ[0]} value={`${v.obtained} of ${v.decisive}`} label="decisive customer facts the agent got" />
                    <div className="mt-1 text-muted-foreground">
                      {v.tickets} tickets; {v.failed_missed} of {v.failed} failed tickets missed one
                    </div>
                  </>
                ),
              };
            })}
          />
        </ChartCard>
      )}
      {factsBy && factRows.some((b) => (factsBy[b].questions ?? 0) > 0) && (() => {
        const rows = factRows.filter((b) => (factsBy[b].questions ?? 0) > 0);
        const base = baseKey && factsBy[baseKey]?.questions ? (factsBy[baseKey].relevant ?? 0) / factsBy[baseKey].questions! : null;
        // The plain customer gives its facts up front, so the agent asks it little: a few requests that are not for a
        // fact (e.g. "please send the receipt") move its rate a lot. Say so when its row rests on few questions.
        const baseQ = baseKey ? factsBy[baseKey]?.questions ?? 0 : 0;
        const otherQ = rows.filter((b) => b !== baseKey).reduce((a, b) => a + (factsBy[b].questions ?? 0), 0);
        const fewBase = baseKey != null && baseQ > 0 && baseQ < 40;
        return (
          <ChartCard
            title="Were the agent's questions relevant?"
          scope={scopeTag}
            how="A model read each conversation and, for every support turn that asks the customer for something, named the customer facts it asks for (its quote is checked against the turn). Each bar: turns asking for at least one decisive customer fact ÷ turns that ask for anything, over the tickets with that behavior. The line is the plain (baseline) customer's rate."
            subtitle="Customer precision: of the agent's questions to the customer, the share that ask for a fact the ticket actually needs. Low means the agent asks for things that do not decide the ticket. Hover a behavior for what it is."
          >
            <RateBars
              color={VIZ[1]}
              reference={base == null ? undefined : { value: base, label: `baseline ${base.toFixed(2)}` }}
              rows={rows.map((b) => {
                const v = factsBy[b];
                return {
                  key: b,
                  group: behaviorFamily(b),
                  label: <Defined def={BEHAVIOR_DEFS[b]}>{behaviorLabel(b)}</Defined>,
                  passed: v.relevant ?? 0,
                  total: v.questions ?? 0,
                  tip: (
                    <>
                      <div className="mb-1 font-medium">{behaviorLabel(b)}</div>
                      <TipRow color={VIZ[1]} value={`${v.relevant ?? 0} of ${v.questions ?? 0}`} label="questions asking for a decisive fact" />
                      <div className="mt-1 text-muted-foreground">{v.tickets} tickets</div>
                    </>
                  ),
                };
              })}
            />
            {fewBase && (
              <p className="mt-3 max-w-3xl font-sans text-xs text-muted-foreground">
                Read the baseline with care: it rests on {baseQ} questions over {factsBy[baseKey!].tickets} tickets, against{" "}
                {otherQ} for the other behaviors. A plain customer gives the facts up front, so the agent has little to ask,
                and a few requests that are not for a fact (such as &ldquo;please send the receipt&rdquo;) pull the rate
                down. Customers who hold facts back get mostly needed questions, so their rates sit higher.
              </p>
            )}
          </ChartCard>
        );
      })()}
      {replayRows.length > 0 && (
        <ChartCard
          title="Behavior replay: failed tickets run again with the baseline customer"
          scope={scopeTag}
          how="Only failed tickets that passed the rule + facts replay get this replay: the same ticket, the facts in the agent's system prompt, no rule, and a plain customer instead of its own behavior. Each bar: tickets that passed ÷ tickets replayed, for that behavior. The baseline line is the same rate for tickets that already had a plain customer."
          subtitle={`A failed ticket is run again with a plain customer instead of its own behavior (the customer's facts handed to the agent, no rule). A higher bar means more tickets passed once the behavior was gone, so the behavior caused more of the failures. The line is plain-customer tickets run the same way, for comparison. Only tickets that pass when given the rule and the facts get this replay (${replayTotal} here; ${replayPassed} passed). Hover a behavior for what it is.`}
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">behavior</th>
                  <th className="py-2 pr-3 font-medium">failed</th>
                  <th className="py-2 pr-3 font-medium">replayed with the baseline customer</th>
                  <th className="py-2 font-medium">passed then</th>
                </tr>
              </thead>
              <tbody>
                {replayRows.map(({ b, v }) => (
                  <tr key={b} className="border-b border-border/60">
                    <td className="py-2 pr-3">{behaviorLabel(b)}</td>
                    <td className="py-2 pr-3 tabular-nums">{v.failed ?? 0}</td>
                    <td className="py-2 pr-3 tabular-nums">{v.plain_replayed ?? 0}</td>
                    <td className="py-2 tabular-nums">{v.plain_passed ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <RateBars
            color={VIZ[0]}
            reference={baseRate == null ? undefined : { value: baseRate, label: `baseline ${baseRate.toFixed(2)}` }}
            rows={replayRows.map(({ b, v }) => ({
              key: b,
              group: behaviorFamily(b),
              label: <Defined def={BEHAVIOR_DEFS[b]}>{behaviorLabel(b)}</Defined>,
              passed: v.plain_passed ?? 0,
              total: v.plain_replayed ?? 0,
              tip: (
                <>
                  <div className="mb-1 font-medium">{behaviorLabel(b)}</div>
                  <TipRow color={VIZ[0]} value={`${v.plain_passed ?? 0} of ${v.plain_replayed ?? 0}`} label="passed with the baseline customer" />
                  <div className="mt-1 text-muted-foreground">
                    {v.failed ?? 0} failed tickets; {v.plain_replayed ?? 0} reached this replay
                  </div>
                </>
              ),
            }))}
          />
        </ChartCard>
      )}

      {keys.length > 0 && (
        <ChartCard
          title="Pass rate by behavior"
          scope={scopeTag}
          how="Each bar: tickets passed ÷ tickets with that customer behavior. The number next to a family: its behaviors' tickets added up, passed ÷ tickets. The line is the baseline (plain customer) rate."
          subtitle="Each ticket has one way the customer behaves; the correct handling is the same as for a plain customer. A bar left of the line means that behavior made the agent worse than with a plain customer. Different behaviors are on different tickets, so small gaps mostly reflect which tickets they got. The number next to each family is that family's pass rate. Hover a behavior for what it is."
          table={
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">behavior</th>
                  <th className="py-2 pr-3 font-medium">family</th>
                  <th className="py-2 pr-3 font-medium">tickets passed</th>
                  <th className="py-2 pr-3 font-medium">q</th>
                  <th className="py-2 font-medium">vs baseline</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((b) => {
                  const row = byCat[b];
                  const q = row.total ? row.passed / row.total : row.q;
                  return (
                    <tr key={b} className="border-b border-border/60">
                      <td className="py-2 pr-3">{behaviorLabel(b)}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{behaviorFamily(b)}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {row.passed}/{row.total}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{fmtQ(q)}</td>
                      <td className="py-2 tabular-nums">
                        {b === baseKey ? "baseline" : signed(base == null ? null : q - base)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          }
        >
          <RateBars
            reference={base == null ? undefined : { value: base, label: `baseline ${base.toFixed(2)}` }}
            rows={keys.map((b) => {
              const row = byCat[b];
              const q = row.total ? row.passed / row.total : row.q;
              const fam = families[behaviorFamily(b)];
              return {
                key: b,
                group: behaviorFamily(b),
                groupLabel: fam ? `${behaviorFamily(b)} · ${fmtQ(fam.q)}` : behaviorFamily(b),
                label: <Defined def={BEHAVIOR_DEFS[b]}>{behaviorLabel(b)}</Defined>,
                passed: row.passed,
                total: row.total,
                tip: (
                  <>
                    <div className="mb-1 font-medium">{behaviorLabel(b)}</div>
                    <TipRow color={VIZ[1]} value={`${fmtQ(q)} (${row.passed}/${row.total})`} label="passed" />
                    <div className="mt-1 text-muted-foreground">
                      {behaviorFamily(b)} · {b === baseKey ? "baseline" : `${signed(base == null ? null : q - base)} vs baseline`}
                    </div>
                  </>
                ),
              };
            })}
          />
          {baseKey && byCat[baseKey] && byCat[baseKey].total > 0 && byCat[baseKey].total < 30 && (
            <p className="mt-3 max-w-3xl font-sans text-xs text-muted-foreground">
              Read the baseline with care: it rests on {byCat[baseKey].total} tickets, against{" "}
              {keys.filter((b) => b !== baseKey).reduce((a, b) => a + (byCat[b].total ?? 0), 0)} for the other behaviors, so
              one hard ticket moves it a lot. With all stages shown, a ticket asked again at a later stage counts each time.
            </p>
          )}
        </ChartCard>
      )}

    </>
  );
}

function entriesFromRecord(
  rec: Record<string, GroupScore & { q?: number; frac?: string }> | undefined,
) {
  return Object.entries(rec ?? {})
    .map(([key, row]) => ({
      key,
      passed: row.passed,
      total: row.total,
      q: row.q,
      extra: row.frac,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export default function BehaviorPage() {
  const job = useJob();
  const meta = use(getMeta(job));
  const interactions = use(getInteractions(job));
  const { stage: picked, set } = useStage(meta, true, true);
  const stages = meta.stages ?? [];
  const rows = stages.map((s) => behaviorForStage(s, meta.scores[String(s)]));
  const preferred = primaryBehaviorStage(rows);

  if (stages.length && rows.every((r) => !r.coverage)) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="font-heading text-3xl font-normal tracking-tight">Behavioral coverage</h1>
        <p className="mt-4 text-sm text-muted-foreground">This run has no customer-behavior tickets, so RQ4 does not apply.</p>
      </div>
    );
  }
  if (!stages.length || !rows.length) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="font-heading text-3xl font-normal tracking-tight">Behavioral coverage</h1>
        <p className="mt-4 font-mono text-sm text-muted-foreground">
          stages=[] scores={"{"}
          {"}"} — no verifier numbers in meta.json for this run.
        </p>
      </div>
    );
  }

  const pickedStage = picked === ALL ? ALL_STAGES : picked;
  const active =
    rows.find((r) => r.stage === pickedStage) ?? (pickedStage === ALL_STAGES ? preferred : null) ?? rows[0];
  const combined = active.stage === ALL_STAGES;
  // A run graded by facts: decisive customer facts the agent got, by behavior (this stage, or every stage added up).
  const factsBy = (() => {
    const scores = combined ? Object.values(meta.scores) : [meta.scores[String(active.stage)]];
    const out: FactsScore["by_behavior"] = {};
    for (const sc of scores) {
      for (const [b, v] of Object.entries(sc?.facts?.by_behavior ?? {})) {
        const row = (out[b] ??= { tickets: 0, decisive: 0, obtained: 0, failed: 0, failed_missed: 0, questions: 0, relevant: 0 });
        for (const k of ["tickets", "decisive", "obtained", "failed", "failed_missed"] as const) row[k] += v[k];
        row.questions = (row.questions ?? 0) + (v.questions ?? 0);
        row.relevant = (row.relevant ?? 0) + (v.relevant ?? 0);
      }
    }
    return Object.keys(out).length ? out : null;
  })();
  const score: StageScore = meta.scores[String(active.stage)] ?? {};
  const corrections = (combined ? (meta.stages ?? []).map((s) => meta.scores[String(s)]?.agent_correction) : [score.agent_correction])
    .filter((c): c is NonNullable<StageScore["agent_correction"]> => !!c)
    .reduce((a, c) => ({ tickets: a.tickets + c.tickets, fixed: a.fixed + c.fixed }), { tickets: 0, fixed: 0 });
  const coverage = active.coverage;
  const realization = active.realization;
  const perTicket = active.perTicket;

  const byCat = coverage?.by_category ?? {};
  const catKeys = [
    ...CATEGORY_ORDER.filter((c) => c in byCat),
    ...Object.keys(byCat).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  const failedCases = (score.cases ?? []).filter((c) => !c.passed);
  const sumCats = () =>
    Object.values(byCat).reduce(
      (a, c) => ({ passed: a.passed + c.passed, total: a.total + c.total }),
      { passed: 0, total: 0 },
    );
  const behTickets = perTicket
    ? sumCats()
    : score.by_group?.behavior ??
    (Object.keys(byCat).length
      ? Object.values(byCat).reduce(
          (a, c) => ({ passed: a.passed + c.passed, total: a.total + c.total }),
          { passed: 0, total: 0 },
        )
      : null);
  const byBehavior = active.attribution?.by_behavior ?? {};

  return (
    <div>
      <div className="mx-auto max-w-5xl px-6 pt-10">
        <h1 className="font-heading text-3xl font-normal tracking-tight">Customer types</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Every ticket has one way the customer behaves (plain, vague, pushy, frustrated, …). The right handling is the same
          for all of them, so a lower pass rate for one type means that type trips the agent up.
        </p>
        <p className="mt-2 font-sans text-sm">
          <TextLink href={`/runs/${job}/tickets?stage=${active.stage === ALL_STAGES ? meta.stages[0] : active.stage}`}>Read the conversations</TextLink>
        </p>
      </div>
      <StageBar meta={meta} stage={active.stage === ALL_STAGES ? ALL : active.stage} onChange={set} allowAll={preferred?.stage === ALL_STAGES} className="mt-8" />
      <div className="mx-auto max-w-5xl px-6 pb-12">
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat
          k="Average across customer types"
          v={coverage ? fmtQ(coverage.q_coverage) : "—"}
          how={coverage && perTicket ? `For each of the ${catKeys.length} behaviors (the baseline included): tickets passed ÷ tickets with that behavior${combined ? ", every stage added up" : ""}. The average is the plain mean of those rates, so a behavior on 3 tickets counts as much as one on 40.` : undefined}
        />
        <Stat
          k="Tickets passed"
          how={combined ? `Tickets passed ÷ tickets, every stage added up (${active.headline.passed}/${active.headline.total}).` : behTickets ? `Tickets passed ÷ tickets in this stage (${behTickets.passed}/${behTickets.total}).` : undefined}
          v={
            combined
              ? `${active.headline.passed}/${active.headline.total}`
              : behTickets
                ? `${behTickets.passed}/${behTickets.total}`
                : "—"
          }
        />
        {perTicket ? (
          <Stat
            k="Got it right after a correction"
            how={corrections.tickets ? `Tickets where the customer model pointed out a wrong detail the agent stated (${corrections.tickets}); of those, the ones that still passed (${corrections.fixed}).${combined ? " Every stage added up." : ""}` : undefined}
            v={corrections.tickets ? `${corrections.fixed}/${corrections.tickets}` : "none"}
          />
        ) : (
          <Stat k="Qrealization" v={realization?.mean_q_realization == null ? "—" : fmtQ(realization.mean_q_realization)} />
        )}
      </div>

      {perTicket && coverage && (
        <PerTicketTables
          factsBy={factsBy}
          coverage={coverage}
          attribution={active.ticketAttribution}
          scope={combined ? "all stages" : stepLabel(score.step, active.stage)}
          tickets={combined ? interactions : interactions.filter((t) => t.stage === active.stage)}
        />
      )}

      {!perTicket && <RateTable
        title="by_category"
        rows={catKeys.map((cat) => ({
          key: cat,
          extra: categoryLabel(cat) !== cat ? categoryLabel(cat) : undefined,
          passed: byCat[cat].passed,
          total: byCat[cat].total,
          q: byCat[cat].q,
        }))}
      />}

      {!perTicket && Object.keys(byBehavior).length > 0 && (
        <section className="mt-8">
          <h2 className="font-sans text-sm font-semibold">by_behavior (control and wording variants split)</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">behavior</th>
                <th className="py-2 pr-3 font-medium">tickets</th>
                {ATTRIBUTION_KINDS.map((k) => (
                  <th key={k} className="py-2 pr-3 font-medium">
                    {ATTRIBUTION_LABELS[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(byBehavior)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([k, v]) => (
                  <tr key={k} className="border-b border-border/60">
                    <td className="py-2 pr-3">{k}</td>
                    <td className="py-2 pr-3 tabular-nums">{v.tickets}</td>
                    {ATTRIBUTION_KINDS.map((kind) => (
                      <td key={kind} className="py-2 pr-3 tabular-nums">
                        {v[kind] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      <RateTable title="by_purpose" rows={entriesFromRecord(score.by_purpose)} />
      <RateTable title="by_rule" rows={entriesFromRecord(score.by_rule)} />

      {!perTicket && coverage?.by_scenario &&
        coverage.by_scenario.some((r) => r.scenario !== "_") && (
          <RateTable
            title="by_scenario"
            rows={coverage.by_scenario.map((row) => ({
              key: `${row.scenario}/${row.category}`,
              passed: row.passed,
              total: row.total,
              q: row.q,
            }))}
          />
        )}

      {!perTicket && realization?.by_scenario && realization.by_scenario.length > 0 && (
        <section className="mt-8">
          <h2 className="font-sans text-sm font-semibold">
            realization_robustness mean=
            {fmtQ(realization.mean_q_realization)} n_multi=
            {realization.n_multi_realization_scenarios}
          </h2>
          <table className="mt-2 w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">scenario</th>
                <th className="py-2 pr-3 font-medium">category</th>
                <th className="py-2 pr-3 font-medium">|U|</th>
                <th className="py-2 pr-3 font-medium">q</th>
                <th className="py-2 font-medium">id:pass</th>
              </tr>
            </thead>
            <tbody>
              {realization.by_scenario.map((row) => (
                <tr
                  key={`${row.scenario}:${row.category}:u`}
                  className="border-b border-border/60 align-top"
                >
                  <td className="py-2 pr-3">{row.scenario}</td>
                  <td className="py-2 pr-3">{row.category}</td>
                  <td className="py-2 pr-3 tabular-nums">{row.n_realizations}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmtQ(row.q_realization)}</td>
                  <td className="py-1.5 text-xs">
                    {(row.realizations ?? [])
                      .map((u) => `${u.id}:${u.passed ? 1 : 0}`)
                      .join(" ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!perTicket && active.attribution && (
        <section className="mt-8">
          <h2 className="font-sans text-sm font-semibold">
            behavior or docs? behavior={active.attribution.behavior_failures} docs=
            {active.attribution.doc_failures} handled={active.attribution.handled} noisy=
            {active.attribution.noisy} control did not run={active.attribution.no_control ?? 0} ours=
            {active.attribution.ours ?? 0} bot_errors={active.attribution.bot_errors ?? 0}
          </h2>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            Each scenario&apos;s normal ticket is the control (same agent, same docs). A variant that fails
            while the control passes is a behavior failure; if the control fails too, the rule itself was
            missed. A variant that failed on a rule while the control lost to us or a agent error is counted
            as &quot;control did not run&quot;. Failures caused only by us (time limit, provider, customer model) and agent errors where no rule was tested (crash, no model call) are counted apart.
          </p>
          <table className="mt-2 w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">scenario</th>
                <th className="py-2 pr-3 font-medium">control</th>
                <th className="py-2 pr-3 font-medium">behavior failures</th>
                <th className="py-2 pr-3 font-medium">doc failures</th>
                <th className="py-2 pr-3 font-medium">control did not run</th>
                <th className="py-2 pr-3 font-medium">ours</th>
                <th className="py-2 font-medium">agent errors</th>
              </tr>
            </thead>
            <tbody>
              {(active.attribution.by_scenario ?? []).map((row) => (
                <tr key={row.scenario} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">{row.scenario}</td>
                  <td className="py-2 pr-3">
                    {row.control_passed
                      ? "passed"
                      : row.control_owner === "us"
                        ? "failed (us)"
                        : row.control_owner === "bot"
                          ? "failed (agent error)"
                          : "failed"}
                  </td>
                  <td className="py-2 pr-3 text-xs">{row.behavior_failures.join(" ") || "—"}</td>
                  <td className="py-2 pr-3 text-xs">{row.doc_failures.join(" ") || "—"}</td>
                  <td className="py-2 pr-3 text-xs">{(row.no_control ?? []).join(" ") || "—"}</td>
                  <td className="py-2 pr-3 text-xs">{(row.ours ?? []).join(" ") || "—"}</td>
                  <td className="py-1.5 text-xs">{(row.bot_errors ?? []).join(" ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {failedCases.length > 0 && (
        <section className="mt-8">
          <h2 className="font-sans text-sm font-semibold">
            failed cases ({failedCases.length})
          </h2>
          <div className="mt-2 space-y-1 text-xs">
            {failedCases.map((c) => (
              <div key={c.id}>
                {c.id} pass=0{c.termination ? ` term=${c.termination}` : ""}
              </div>
            ))}
          </div>
        </section>
      )}

      {(score.unscored_failed?.length ?? 0) > 0 && (
        <section className="mt-8">
          <h2 className="font-sans text-sm font-semibold">
            unscored_failed ({score.unscored_failed!.length})
          </h2>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {score.unscored_failed!.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </section>
      )}
      </div>
    </div>
  );
}
