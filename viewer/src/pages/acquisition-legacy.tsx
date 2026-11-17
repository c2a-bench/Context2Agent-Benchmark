import { use } from "react";
import { currentSearchParams, useJob } from "@/lib/route";
import { FAMILY_COLOR, PARTY_COLOR, PARTY_LABEL } from "@/lib/parties";
import { useSearchParams } from "react-router";
import { ALL, ScopeChip, StageBar, stageName, useStage } from "@/components/stage-select";
import { TextLink } from "@/components/link";
import { BarList, ChartCard, Legend, Meter, StageColumns, TipRow, VIZ, type BarRow, type Segment, type StageColumn } from "@/components/charts";
import { getMeta, getTickets } from "@/lib/data";
import type { Meta } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  acquisitionForStage,
  FAILURE_PARTIES,
  failureTaxonomy,
  fmtQ,
  taxonomyFamilies,
  ticketParties,
  FAILURE_DEFS,
  taxonomyRows,
  FAILURE_TAXONOMY,
  FAMILY_HINT,
  FAMILY_LABEL,
  TYPE_LABEL,
  familyOfType,
  ticketFamilies,
  ticketTypeWeights,
} from "@/lib/knowledge-application";
import type { DocRecall, FactsScore, StageScore, Ticket } from "@/lib/types";
import { REPLAY_VERDICTS, stepLabel } from "@/lib/format";
import { VerdictGuide } from "@/components/verdict-guide";
import { VERDICT_COLOR } from "@/lib/verdicts";
import { useRunSummary } from "@/pages/research";

function docName(d: string) {
  return d.split("/").pop()!.replace(/\.json$/, "");
}


function share(n: number, total: number) {
  return total ? `${Math.round((100 * n) / total)}%` : "—";
}

/** Figure 1: each stage's tickets as one 100% column: passed at the bottom, failed tickets by blame bucket.
 *  A failed ticket whose checks fall in several buckets is split evenly between them. */
function WhyTicketsFail({ stages, scores, tickets, active }: { stages: number[]; scores: Record<string, StageScore>; tickets: Ticket[]; active: number }) {
  const PASSED = "color-mix(in oklab, var(--muted-foreground) 32%, transparent)";
  const NONE = "color-mix(in oklab, var(--muted-foreground) 64%, transparent)";
  const keys = [...FAILURE_PARTIES, "none"] as const;
  const label = (k: string) => PARTY_LABEL[k] ?? k;
  const color = (k: string) => PARTY_COLOR[k] ?? NONE;
  const stepName = (st: number) => stepLabel(scores[String(st)]?.step, st);
  const perStage = stages.map((st) => {
    const sc = scores[String(st)] ?? {};
    const counts: Record<string, number> = ticketParties(tickets.filter((t) => t.stage === st));
    const failed = keys.reduce((a, k) => a + counts[k], 0);
    const total = sc.total ?? failed + (sc.passed ?? 0);
    return { st, counts, failed: Math.round(failed), passed: total - Math.round(failed), total };
  });
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const columns: StageColumn[] = perStage.map(({ st, counts, failed, passed, total }) => ({
    key: String(st),
    label: stepName(st),
    href: `?stage=${st}`,
    selected: st === active,
    top: `${failed}/${total} failed`,
    segments: [
      { key: "passed", label: "passed", value: passed, color: PASSED },
      ...keys.map((k) => ({ key: k, label: label(k), value: counts[k], color: color(k) })),
    ].map((seg) => ({
      ...seg,
      tip: (
        <>
          <div className="mb-1 font-medium">{stepName(st)} · {seg.label}</div>
          <TipRow color={seg.color} value={`${fmt(seg.value)} of ${total} tickets`} label={`${Math.round((100 * seg.value) / (total || 1))}%`} />
        </>
      ),
    })),
  }));
  const used = keys.filter((k) => perStage.some((p) => p.counts[k] > 0));
  const legend: Segment[] = [
    { key: "passed", label: "passed", value: perStage.reduce((a, p) => a + p.passed, 0), color: PASSED, def: "Tickets the agent got fully right." },
    ...used.map((k) => ({ key: k, label: label(k), value: Math.round(perStage.reduce((a, p) => a + p.counts[k], 0)), color: color(k), def: FAILURE_DEFS[k === "none" ? "no blame recorded" : k] })),
  ];
  const table = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">stage</th>
          <th className="py-2 pr-3 font-medium">tickets</th>
          <th className="py-2 pr-3 font-medium">passed</th>
          {used.map((k) => (
            <th key={k} className="py-2 pr-3 font-medium">{label(k)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {perStage.map(({ st, counts, passed, total }) => (
          <tr key={st} className="border-b border-border/60">
            <td className="py-2 pr-3">{stepName(st)}</td>
            <td className="py-2 pr-3 tabular-nums">{total}</td>
            <td className="py-2 pr-3 tabular-nums">{passed}</td>
            {used.map((k) => (
              <td key={k} className="py-2 pr-3 tabular-nums">{fmt(counts[k])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard
      className="mt-10"
      title="Why tickets fail, by stage"
      scope={{ label: "All stages" }}
      how="Each column is the stage's tickets. Passed = tickets the agent got fully right. Each failed ticket counts once, split evenly between the parties its blame records name (blamed on both the builder and the agent = ½ each), so a column's parts add up to its tickets. Hover a part for its count."
      subtitle="Each column is all of a stage's tickets. Grey is tickets the agent got right; the coloured part is tickets it got wrong, by whose fault it was. A bigger builder part means the knowledge never reached the agent; a bigger agent part means the agent had the knowledge and still got it wrong. Hover a name in the legend for what it means. Click a stage to see its details below."
      table={table}
    >
      <StageColumns columns={columns} />
      <Legend items={legend} />
    </ChartCard>
  );
}

/** Doc recall for one stage: the ratios as cards with plain definitions; the per-ticket table behind "Show table". */
/** RQ2 for a run graded by facts, in place of doc recall: did the agent's files have the facts the tickets need. */
function FactRecallCharts({ f, job, stage, stageName }: { f: FactsScore; job: string; stage: number; stageName: string }) {
  const ticketTable = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">ticket</th>
          <th className="py-2 pr-3 font-medium">passed</th>
          <th className="py-2 pr-3 font-medium">recall</th>
          <th className="py-2 pr-3 font-medium">right</th>
          <th className="py-2 pr-3 font-medium">absent</th>
          <th className="py-2 font-medium">traps held</th>
        </tr>
      </thead>
      <tbody>
        {[...(f.rows ?? [])]
          .sort((a, b) => Number(a.passed) - Number(b.passed) || a.recall - b.recall)
          .map((r) => (
            <tr key={r.id} className="border-b border-border/60 align-top">
              <td className="py-2 pr-3">
                {r.passed ? r.id : <TextLink href={`/runs/${job}/tickets?stage=${stage}&t=${encodeURIComponent(r.id)}`}>{r.id}</TextLink>}
              </td>
              <td className="py-2 pr-3 tabular-nums">{r.passed ? 1 : 0}</td>
              <td className="py-2 pr-3 tabular-nums">{fmtQ(r.recall)}</td>
              <td className="py-2 pr-3 text-xs">{r.right.join(", ")}</td>
              <td className="py-2 pr-3 text-xs">{r.absent.join(", ")}</td>
              <td className="py-1.5 text-xs">{r.traps.join(", ")}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
  const n = f.tickets;
  const cards: [string, number | null, string, string, string][] = [
    ["Needed facts in the agent's files (recall)", f.rule_recall, fmtQ(f.rule_recall), "Of the facts this stage's tickets need (all tickets together), the share the agent's files have. 1.00 means every needed fact is there.", "Needed facts the judge found in the agent's files ÷ the stage's needed facts (the union of its tickets' facts), each fact once."],
    ["Needed facts vs. old or wrong versions held (precision)", f.rule_precision, fmtQ(f.rule_precision), "Of the facts on this stage's list the agent holds (the needed facts and their wrong versions), the share that are the needed ones. Higher means fewer old or wrong versions.", "Needed facts the agent has ÷ every fact on the stage's list it has (needed facts + trap and stale versions of them)."],
    ["Facts present per ticket, averaged (recall per ticket)", f.rule_recall_per_ticket ?? null, fmtQ(f.rule_recall_per_ticket), "The same per ticket, averaged: of the facts each ticket needs, the share the agent has.", `For each of the ${n} tickets: its needed facts the agent has ÷ its needed facts; the card is the mean.`],
    ["Tickets with every needed fact", n ? f.full_recall / n : null, `${f.full_recall}/${n}`, "Tickets whose needed facts are all right in the agent.", `Tickets with recall 1.00 (${f.full_recall}) ÷ tickets (${n}). Of them, ${f.failed_full_recall} still failed: the agent's fault.`],
    ["Tickets holding an old or look-alike fact (trap)", n ? f.trap_tickets / n : null, `${f.trap_tickets}/${n}`, "Tickets whose own rules have an old, draft or look-alike version that the agent also holds. Lower is better: it can mislead the agent.", `Tickets with at least one trap or stale fact for one of their rules labelled right in the agent (${f.trap_tickets}) ÷ tickets (${n}).`],
  ];
  const kinds: [string, string, string][] = [
    ["rule", "facts tickets need", "Right is good."],
    ["trap", "trap facts (old, draft, look-alike pages)", "Held (right) can mislead the agent."],
    ["stale", "earlier versions of a rule", "Held (right) means the agent still has the old version."],
  ];
  const color = { right: VIZ[1], absent: "var(--muted)" } as const;
  const rows: BarRow[] = kinds.filter(([k]) => f.kinds[k]).map(([k, label, def]) => {
    const c = f.kinds[k];
    const total = c.right + c.absent;
    return {
      key: k, label, labelDef: def, value: `${c.right}/${total} right`,
      parts: (["right", "absent"] as const).map((l) => ({ key: l, label: l, value: c[l], color: color[l],
        tip: <TipRow color={color[l]} value={`${c[l]} of ${total}`} label={l} /> })),
    };
  });
  return (
    <ChartCard
      title="Did the agent have the facts?"
      scope={{ label: stageName, stage: true }}
      how={`One judge call (${f.judge_model}) read this stage's agent files and labelled each fact right (in the agent's files) or absent, quoting the agent's own text; a quote not found in the files counts as absent. Each ticket's needed facts come from its rules (the reply-time and priority tables narrowed to the ticket's cell). Hover a card for its formula.`}
      subtitle="Counts a fact when the agent's files give it right, in any wording, so an agent that rewrote the docs still scores. Replaces doc recall: nothing is read from the prompts. Hover a card for what it means; the table has every ticket."
      table={ticketTable}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([label, value, display, def, how]) => (
          <Meter key={label} label={label} value={value} display={display} color={label.includes("(trap)") ? VIZ[3] : VIZ[1]} def={def} how={how} />
        ))}
      </div>
      <div className="mt-6">
        <BarList rows={rows} />
        <div className="mt-3">
          <Legend counts={false} items={(["right", "absent"] as const).map((l) => ({ key: l, label: l, value: 1, color: color[l] }))} />
        </div>
      </div>
    </ChartCard>
  );
}

function DocRecallCharts({ docs, job, stage, stageName }: { docs: DocRecall; job: string; stage: number; stageName: string }) {
  const ticketTable = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">ticket</th>
          <th className="py-2 pr-3 font-medium">passed</th>
          <th className="py-2 pr-3 font-medium">recall</th>
          <th className="py-2 pr-3 font-medium">precision</th>
          <th className="py-2 pr-3 font-medium">reached</th>
          <th className="py-2 pr-3 font-medium">missed</th>
          <th className="py-2 font-medium">traps</th>
        </tr>
      </thead>
      <tbody>
        {[...docs.rows]
          .sort((a, b) => Number(a.passed) - Number(b.passed) || a.recall - b.recall)
          .map((r) => (
            <tr key={r.id} className="border-b border-border/60 align-top">
              <td className="py-2 pr-3">
                {r.passed ? (
                  r.id
                ) : (
                  <TextLink href={`/runs/${job}/tickets?stage=${stage}&t=${encodeURIComponent(r.id)}`}>
                    {r.id}
                  </TextLink>
                )}
              </td>
              <td className="py-2 pr-3 tabular-nums">{r.passed ? 1 : 0}</td>
              <td className="py-2 pr-3 tabular-nums">{fmtQ(r.recall)}</td>
              <td className="py-2 pr-3 tabular-nums">{fmtQ(r.precision)}</td>
              <td className="py-2 pr-3 text-xs">{r.reached.map(docName).join(", ")}</td>
              <td className="py-2 pr-3 text-xs">
                {r.missed.map((d) => docName(d) + (r.absent.includes(d) ? " (no page)" : "")).join(", ")}
              </td>
              <td className="py-1.5 text-xs">{r.traps.map(docName).join(", ")}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
  const cards: [string, number | null, string, string, string][] = [
    ["Needed docs that reached the model (recall)", docs.recall, fmtQ(docs.recall), "Of the docs each ticket needs, the share whose text reached the agent's model while it handled the ticket. 1.00 means every needed doc reached it.", `For each of the ${docs.tickets} tickets: needed docs whose text was in a model prompt ÷ needed docs. Recall is the mean over tickets.`],
    ["Docs that reached the model and were needed (precision)", docs.precision, fmtQ(docs.precision), "Of the docs that reached the model, the share the ticket actually needed. Higher means less unneeded text in the prompt.", "For each ticket where any doc reached the model: needed docs that reached it ÷ all docs that reached it. Precision is the mean over those tickets; — when no doc reached the model at all."],
    ["Needed docs kept in the agent's files", docs.kept ?? null, fmtQ(docs.kept), "Of the needed docs, the share whose text is anywhere in the agent's files. Low means the builder rewrote or left out the docs.", "For each ticket: needed docs whose text (or a copy of it) is in the agent's files ÷ needed docs. The mean over tickets."],
    ["Tickets where every needed doc reached the model", docs.tickets ? docs.full_recall / docs.tickets : null, `${docs.full_recall}/${docs.tickets}`, "Tickets where every doc they need reached the model.", `Tickets with recall 1.00 (${docs.full_recall}) ÷ tickets (${docs.tickets}).`],
    ["Tickets where an old or look-alike page reached the model (trap)", docs.tickets ? docs.trap_tickets / docs.tickets : null, `${docs.trap_tickets}/${docs.tickets}`, "Tickets where an outdated or look-alike page reached the model too. Lower is better: it can mislead the agent.", `Tickets where at least one trap page's text was in a prompt (${docs.trap_tickets}) ÷ tickets (${docs.tickets}).`],
  ];
  return (
    <ChartCard
      title="Did the docs reach the agent?"
      scope={{ label: stageName, stage: true }}
      how="The grader records every prompt the agent's model received while handling each ticket, and checks which docs' own text appears in it. Each ticket's needed docs come from the ticket's answer key. Hover a card for its formula."
      subtitle="Counts a doc only when its own text is in the prompt, so an agent that rewrote the docs in its own words scores low here even when it has the knowledge. Hover a card for what it means; the table has every ticket."
      table={ticketTable}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([label, value, display, def, how]) => (
          <Meter key={label} label={label} value={value} display={display} color={label.includes("(trap)") ? VIZ[3] : VIZ[1]} def={def} how={how} />
        ))}
      </div>
      {docs.absent_docs.length > 0 && (
        <p className="mt-3 font-sans text-xs text-muted-foreground">
          Needed docs with no page in this stage (counted as not reached): {docs.absent_docs.map(docName).join(", ")}
        </p>
      )}
    </ChartCard>
  );
}

/** Level-3 failure types for one stage: one bar per type, grouped by party and family, coloured by party. */
function FailureTypesChart({ tax, stage }: { tax: NonNullable<ReturnType<typeof failureTaxonomy>>; stage: string }) {
  const t = tax.taxonomy;
  const total = t.records;
  const rows = [...taxonomyRows(t)].sort((a, b) => b.count - a.count);
  const partySegs: Segment[] = FAILURE_PARTIES.filter((p) => (t.by_party[p] ?? 0) > 0).map((p) => ({ key: p, label: PARTY_LABEL[p], value: t.by_party[p] ?? 0, color: PARTY_COLOR[p], def: FAILURE_DEFS[p] }));
  const bars: BarRow[] = rows.map((r) => {
    const color = PARTY_COLOR[r.party] ?? "var(--muted-foreground)";
    return {
      key: `${r.party}:${r.family}:${r.type}`,
      label: TYPE_LABEL[r.type] ?? r.type,
      labelDef: FAILURE_DEFS[r.type],
      value: `${r.count} · ${share(r.count, total)}`,
      parts: [{ key: r.type, label: r.type, value: r.count, color }],
      tip: (
        <>
          <div className="mb-1 font-medium">{TYPE_LABEL[r.type] ?? r.type}</div>
          <TipRow color={color} value={`${r.count} · ${share(r.count, total)}`} label={`of ${total} records`} />
          <div className="mt-1 text-muted-foreground">
            {PARTY_LABEL[r.party] ?? r.party} · {r.family}
          </div>
        </>
      ),
    };
  });
  const table = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">party</th>
          <th className="py-2 pr-3 font-medium">family</th>
          <th className="py-2 pr-3 font-medium">type</th>
          <th className="py-2 pr-3 font-medium">count</th>
          <th className="py-2 font-medium">share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.party}:${r.family}:${r.type}`} className="border-b border-border/60">
            <td className="py-2 pr-3">{r.party}</td>
            <td className="py-2 pr-3">{r.family}</td>
            <td className="py-2 pr-3">{r.type}</td>
            <td className="py-2 pr-3 tabular-nums">{r.count}</td>
            <td className="py-2 tabular-nums">{share(r.count, total)}</td>
          </tr>
        ))}
        {taxonomyFamilies(t).map((f) => (
          <tr key={f.key} className="border-b border-border/60 text-muted-foreground">
            <td className="py-2 pr-3" colSpan={2}>family total</td>
            <td className="py-2 pr-3">{f.key}</td>
            <td className="py-2 pr-3 tabular-nums">{f.count}</td>
            <td className="py-2 tabular-nums">{share(f.count, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartCard
      title={`Failures by type (${total} blame records)`}
      scope={{ label: stage, stage: true }}
      how={`Each check a failed ticket got wrong gets one blame record with a party, a family and a type. Each bar: records of that type ÷ all ${total} records in the stage. A ticket that failed several checks has several records.`}
      subtitle={
        "Every check a failed ticket got wrong, biggest first, coloured by who is to blame. Builder types mean the knowledge never reached the agent in a usable form (fix the build); agent types mean the agent had it and still got it wrong (fix the agent). Hover a type or group for what it means." +
        (tax.derived ? " This run predates the detailed types, so agent mistakes on a rule show as \"wrong value (symptom not recorded)\"." : "")
      }
      table={table}
    >
      <Legend items={partySegs} total={total} />
      <div className="mt-3">
        <BarList rows={bars} limit={6} />
      </div>
    </ChartCard>
  );
}

/** Every failed ticket's replay verdict for this stage, one bar per verdict (one series, one colour). */
function ReplayVerdicts({ verdicts, failed, job, stage, stageName, facts = false }: { verdicts?: Record<string, number>; failed: number; job: string; stage: number; stageName: string; facts?: boolean }) {
  const entries = Object.entries(verdicts ?? {}).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  const order = Object.keys(REPLAY_VERDICTS);
  entries.sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const rows: BarRow[] = entries.map(([k, n]) => {
    const v = REPLAY_VERDICTS[k];
    return {
      key: k,
      label: v?.label ?? k,
      value: `${n} · ${share(n, total)}`,
      parts: [{ key: k, label: v?.label ?? k, value: n, color: facts ? VERDICT_COLOR[k] ?? VIZ[1] : VIZ[1] }],
      tip: (
        <>
          <div className="mb-1 font-medium">{v?.label ?? k}</div>
          <TipRow color={VIZ[1]} value={`${n} · ${share(n, total)}`} label={`of ${total} failed tickets`} />
          {v && <div className="mt-1 max-w-72 text-muted-foreground">{v.detail}</div>}
        </>
      ),
    };
  });
  return (
    <ChartCard
      title={`${facts ? "How each failed ticket was classified" : "Replay verdicts"} (${total} of ${failed} failed tickets)`}
      scope={{ label: stageName, stage: true }}
      how={facts ? `No replays: each failed ticket's group comes from the judge's reading of the agent's files (are the facts its failed checks in the agent's files or absent?) and from which decisive customer facts the agent got. Each bar: tickets in that group ÷ the ${total} failed tickets with a group.` : `Each failed ticket is replayed with the rule and the customer's facts in the agent's system prompt; if that passes, with the rule alone and with the facts alone. Which replays pass gives its verdict. Each bar: tickets with that verdict ÷ the ${total} replayed tickets.`}
      subtitle={facts ? (
        <>
          Each failed ticket by what the judge found in the agent&apos;s files and which customer facts the agent got. See the
          tickets on the <TextLink href={`/runs/${job}/tickets?stage=${stage}&result=failed`}>Conversations</TextLink> page
          (filter by verdict).
        </>
      ) : (
        <>
          Each failed ticket is replayed with the rule and the customer&apos;s information given; if that passes, with each one
          alone. The verdict says what was missing. See the tickets on the{" "}
          <TextLink href={`/runs/${job}/tickets?stage=${stage}&result=failed`}>Conversations</TextLink> page (filter by replay
          verdict).
        </>
      )}
    >
      <BarList rows={rows} />
      <VerdictGuide facts={facts} />
    </ChartCard>
  );
}

const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const FAMILY_ORDER = [...FAILURE_TAXONOMY.map((f) => f.family), "none"];
/** The group the page is looking at: ?family= when it has failures, else the biggest one. */
function pickedFamily(want: string | null, keys: string[], total: (k: string) => number) {
  return want && keys.includes(want) ? want : [...keys].sort((a, b) => total(b) - total(a))[0];
}

/** Failed tickets at each stage, by what went wrong (the failure groups). Click a part to see which types it is made of. */
function FailureCategories({ meta, tickets, active }: { meta: Meta; tickets: Ticket[]; active: number }) {
  const [params, setParams] = useSearchParams();
  const stages = meta.stages;
  const perStage = stages.map((st) => {
    const sc = meta.scores[String(st)] ?? {};
    const fam = ticketFamilies(tickets.filter((t) => t.stage === st));
    let failed = Object.values(fam).reduce((a, n) => a + n, 0);
    const total = sc.total ?? 0;
    const passed = sc.passed ?? total - Math.round(failed);
    // Failures the score counts but the tickets carry no blame for (older publications): keep them in the bar.
    const gap = total - passed - failed;
    if (gap > 0.01) { fam.none = (fam.none ?? 0) + gap; failed += gap; }
    return { st, fam, failed, total, passed };
  });
  const totals = (k: string) => perStage.reduce((a, p) => a + (p.fam[k] ?? 0), 0);
  const keys = FAMILY_ORDER.filter((k) => totals(k) > 0);
  const picked = pickedFamily(params.get("family"), keys, totals);
  const pick = (k: string) => {
    const next = currentSearchParams();
    next.set("family", k);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const stageHref = (st: number) => {
    const next = currentSearchParams();
    next.set("stage", String(st));
    return `?${next}`;
  };
  const label = (k: string) => FAMILY_LABEL[k] ?? k;
  const yMax = Math.max(0.2, Math.ceil(5 * Math.max(0, ...perStage.map((p) => (p.total ? p.failed / p.total : 0)))) / 5);
  const columns: StageColumn[] = perStage.map(({ st, fam, failed, total, passed }) => ({
    key: String(st),
    label: stepLabel(meta.scores[String(st)]?.step, st),
    href: stageHref(st),
    selected: st === active,
    denominator: total,
    sub: total ? `${Math.round((100 * passed) / total)}% passed` : undefined,
    top: `${Math.round(failed)}/${total} failed`,
    segments: keys.map((k) => ({
      key: k,
      label: label(k),
      value: fam[k] ?? 0,
      color: FAMILY_COLOR[k],
      tip: (
        <>
          <div className="mb-1 font-medium">{stepLabel(meta.scores[String(st)]?.step, st)} · {label(k)}</div>
          <TipRow color={FAMILY_COLOR[k]} value={`${fmtN(fam[k] ?? 0)} of ${total} tickets`} label={`${Math.round((100 * (fam[k] ?? 0)) / (total || 1))}%`} />
          <div className="mt-1 max-w-72 text-muted-foreground">Click to see its types.</div>
        </>
      ),
    })),
  }));

  return (
    <>
      <ChartCard
        title="What went wrong in the failed tickets, by stage"
        scope={{ label: "All stages" }}
        how="Each bar is a stage; its height is the stage's failed tickets ÷ the stage's tickets. A failed ticket counts once, split evenly between the types its failed checks fall in, so a bar's parts add up to its failed tickets. Each failed check gets one type, and each type belongs to one group, from the grader's blame records."
        subtitle="Each bar is a stage. Its height is the share of that stage's tickets that failed, so a taller bar means more failures; the label above says how many passed. The colours say what went wrong. Click a colour to see the types inside it; click a stage name to see that stage in detail below."
        table={
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">stage</th>
                <th className="py-2 pr-3 font-medium">tickets</th>
                <th className="py-2 pr-3 font-medium">passed</th>
                {keys.map((k) => <th key={k} className="py-2 pr-3 font-medium">{label(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {perStage.map((p) => (
                <tr key={p.st} className="border-b border-border/60">
                  <td className="py-2 pr-3">{stepLabel(meta.scores[String(p.st)]?.step, p.st)}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.total}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.passed}</td>
                  {keys.map((k) => <td key={k} className="py-2 pr-3 tabular-nums">{fmtN(p.fam[k] ?? 0)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        }
      >
        <StageColumns columns={columns} inkFirst={false} yMax={yMax} onPick={pick} picked={picked} />
        <div className="mt-3 flex flex-wrap gap-2">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => pick(k)}
              aria-pressed={k === picked}
              title={FAMILY_HINT[k]}
              className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-xs hover:bg-muted", k === picked && "border-foreground bg-muted font-medium")}
            >
              <span className="size-2.5 rounded-sm" style={{ background: FAMILY_COLOR[k] }} />
              {label(k)}
              <span className="tabular-nums text-muted-foreground">{Math.round(totals(k))}</span>
            </button>
          ))}
        </div>
      </ChartCard>

    </>
  );
}

/** The types inside one failure group, for the stage picked in the dropdown. Counts the same thing as the chart above
 *  (failed tickets, split between the types a ticket failed on), so its bars add up to that stage's part of the chart. */
function InsideFamily({ meta, tickets, stage }: { meta: Meta; tickets: Ticket[]; stage: number }) {
  const [params, setParams] = useSearchParams();
  const stageName = stepLabel(meta.scores[String(stage)]?.step, stage);
  const here = tickets.filter((t) => t.stage === stage);
  const weights = ticketTypeWeights(here);
  const fam = ticketFamilies(here);
  const all = ticketFamilies(tickets);
  const keys = FAMILY_ORDER.filter((k) => (all[k] ?? 0) > 0);
  const picked = pickedFamily(params.get("family"), keys, (k) => all[k] ?? 0);
  const known = FAILURE_TAXONOMY.find((f) => f.family === picked)?.types ?? [];
  const types = Object.keys(weights)
    .filter((ty) => (ty === "none" ? picked === "none" : familyOfType(ty) === picked))
    .sort((a, b) => weights[b] - weights[a] || known.indexOf(a) - known.indexOf(b));
  const total = fam[picked] ?? 0;
  const color = FAMILY_COLOR[picked];
  const rows: BarRow[] = types.map((ty) => ({
    key: ty,
    label: TYPE_LABEL[ty] ?? ty,
    labelDef: FAILURE_DEFS[ty],
    value: `${fmtN(weights[ty])} · ${share(weights[ty], total)}`,
    parts: [{ key: ty, label: TYPE_LABEL[ty] ?? ty, value: weights[ty], color }],
  }));
  const pick = (k: string) => {
    const next = currentSearchParams();
    next.set("family", k);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return (
    <ChartCard
      title={`Inside “${FAMILY_LABEL[picked] ?? picked}”`}
      scope={{ label: stageName, stage: true }}
      how="A failed ticket counts once, split evenly between the types its failed checks fall in, the same as the chart above. So these bars add up to this group's part of the stage's bar."
      subtitle={`${FAMILY_HINT[picked] ?? ""} ${fmtN(total)} failed ${total === 1 ? "ticket" : "tickets"} in ${stageName}.`.trim()}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => pick(k)}
            aria-pressed={k === picked}
            className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-xs hover:bg-muted", k === picked && "border-foreground bg-muted font-medium")}
          >
            <span className="size-2.5 rounded-sm" style={{ background: FAMILY_COLOR[k] }} />
            {FAMILY_LABEL[k] ?? k}
            <span className="tabular-nums text-muted-foreground">{fmtN(fam[k] ?? 0)}</span>
          </button>
        ))}
      </div>
      {rows.length ? <BarList rows={rows} /> : <p className="font-sans text-sm text-muted-foreground">No failed tickets in this group at {stageName}.</p>}
    </ChartCard>
  );
}

export default function LegacyFailureAnalysis() {
  const job = useJob();
  const meta = use(getMeta(job));
  const tickets = use(getTickets(job));
  const summary = useRunSummary();
  const { stage: picked, set } = useStage(meta);
  const stages = meta.stages ?? [];
  const rows = stages.map((s) => acquisitionForStage(s, meta.scores[String(s)]));

  if (!stages.length) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="font-sans text-xl font-semibold tracking-tight">Failure analysis</h1>
        <p className="mt-4 text-sm text-muted-foreground">stages=[] — no verifier numbers.</p>
      </div>
    );
  }

  const active = rows.find((r) => r.stage === picked) ?? rows[0];
  const ka = active.ka;
  const subset = ka?.subset;
  const tax = failureTaxonomy(active.score);
  const docs = active.score.docs;
  // A run graded by facts (scripts/fact_run.py): the judge's reading of the agent replaces kept/reached and doc recall.
  const factScore = active.score.facts;
  const failed = ka?.failed ?? (active.score.total ?? 0) - (active.score.passed ?? 0);
  const stage = stageName(meta, active.stage);
  const hasVerdicts = stages.some((s) => meta.scores[String(s)]?.replay_verdicts);
  const hasFamilies = Object.entries(ticketFamilies(tickets)).some(([k, n]) => k !== "none" && n > 0);

  return (
    <div>
      <div className="mx-auto max-w-5xl px-6 pt-10">
        <h1 className="font-sans text-xl font-semibold tracking-tight">Failure analysis</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Why tickets failed, and whose fault it was: the builder (the knowledge never reached the agent) or the agent (it had
          the knowledge and still got it wrong).
        </p>

        {hasFamilies ? <FailureCategories meta={meta} tickets={tickets} active={active.stage} /> : hasVerdicts ? summary.parts.verdicts(active.stage) : <WhyTicketsFail stages={stages} scores={meta.scores} tickets={tickets} active={active.stage} />}
      </div>

      <StageBar meta={meta} stage={active.stage} onChange={set} className="mt-14" />

      <div className="mx-auto max-w-5xl px-6 pb-12">
        <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-sans text-lg font-semibold tracking-tight">
            Details for {stage} <ScopeChip stage>{stage}</ScopeChip>
          </h2>
          <TextLink href={`/runs/${job}/tickets?stage=${active.stage}&result=failed`}>See the {failed} failed conversations</TextLink>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(
            [
              ["Failed tickets", active.score.total ? failed / active.score.total : null, `${failed}/${active.score.total ?? "—"}`, "Tickets the agent got wrong in this stage.", VIZ[0], `Tickets that failed (${failed}) ÷ all tickets in the stage (${active.score.total ?? "—"}).`],
              ...(factScore
                ? []
                : ([
                    ["Rules copied into the agent's files (kept)", subset?.kept_rate ?? null, subset ? `${subset.kept}/${subset.rules}` : "—", "Of the rules this stage's tickets need, how many the builder copied into the agent's files. Low means the knowledge was never acquired, or was reworded (a reworded rule is not counted).", VIZ[1], subset ? `Rules with a source sentence from the docs in the agent's files, word for word ignoring case, spacing and markdown (${subset.kept}) ÷ rules this stage's tickets test (${subset.rules}).` : undefined],
                    ["Rules that reached the model", subset?.reached_rate ?? null, fmtQ(subset?.reached_rate), "Of the rules this stage's tickets need, the share that was actually in the prompt when the agent handled a ticket. Kept but not reached means the agent never looked it up.", VIZ[1], subset ? `Rules with a source sentence in any prompt the agent's model received this stage, matched the same way (${subset.reached}) ÷ rules this stage's tickets test (${subset.rules}).` : undefined],
                  ] as const)),
            ] as const
          ).map(([label, value, display, def, color, how]) => (
            <Meter key={label} label={label} value={value} display={display} color={color} def={def} how={how} />
          ))}
        </div>

        {factScore && <FactRecallCharts f={factScore} job={job} stage={active.stage} stageName={stage} />}
        {docs && <DocRecallCharts docs={docs} job={job} stage={active.stage} stageName={stage} />}
        {hasFamilies ? <InsideFamily meta={meta} tickets={tickets} stage={active.stage} /> : tax && tax.taxonomy.records > 0 && <FailureTypesChart tax={tax} stage={stage} />}
        {ka && <ReplayVerdicts verdicts={active.score.replay_verdicts} failed={failed} job={job} stage={active.stage} stageName={stage} facts={!!factScore} />}
      </div>
    </div>
  );
}
