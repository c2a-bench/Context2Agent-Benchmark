import { REPLAY_VERDICTS } from "@/lib/format";
import { VERDICT_COLOR } from "@/lib/verdicts";

const ROWS: { key: string; full: string; rule: string; facts: string; also?: string }[] = [
  { key: "execution", full: "fails", rule: "not run", facts: "not run" },
  { key: "knowledge", full: "passes", rule: "passes", facts: "fails", also: "the rule had not reached the agent in the original run" },
  { key: "application", full: "passes", rule: "passes", facts: "fails", also: "the rule had reached the agent in the original run" },
  { key: "customer", full: "passes", rule: "fails", facts: "passes" },
  { key: "either", full: "passes", rule: "passes", facts: "passes" },
  { key: "both", full: "passes", rule: "fails", facts: "fails" },
];

const FACT_ROWS: { key: string; facts: string; customer: string }[] = [
  { key: "agent never started", facts: "any (the agent's run program is missing or fails on start, on every ticket of the stage)", customer: "any" },
  { key: "prompt over cap", facts: "any (the agent crashed: its prompt went over the ticket's size cap)", customer: "any" },
  { key: "fact absent", facts: "one is absent (not in the files, or another value or an old version)", customer: "any" },
  { key: "missed customer fact", facts: "all right", customer: "one that decides a failed check not obtained" },
  { key: "had the facts", facts: "all right", customer: "all that decide a failed check obtained" },
];

/** How a failed ticket's fact verdict is decided (a run graded by facts: no replays). */
function FactGuide() {
  return (
    <details className="mt-4 rounded-lg border px-4 py-2 font-sans text-xs">
      <summary className="cursor-pointer py-1 text-muted-foreground hover:text-foreground">How the groups are decided</summary>
      <p className="mt-2 max-w-3xl leading-relaxed text-muted-foreground">
        Nothing is replayed. After grading, a <b className="text-foreground">judge model reads the stage&apos;s agent files</b> once and
        labels every fact the tickets need as right (in the agent's files) or absent, quoting the agent&apos;s own text. A model reads each
        conversation for which <b className="text-foreground">customer facts</b> the customer gave. For each failed ticket, the
        facts that decide its failed checks and its decisive customer facts pick the group (the first row that matches):
      </p>
      <table className="mt-3 mb-2 w-full">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">group</th>
            <th className="py-1.5 pr-3 font-medium">facts the failed checks need (agent&apos;s files)</th>
            <th className="py-1.5 font-medium">decisive customer facts</th>
          </tr>
        </thead>
        <tbody>
          {FACT_ROWS.map((r) => (
            <tr key={r.key} className="border-b border-border/60">
              <td className="py-1.5 pr-3">
                <span className="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={{ background: VERDICT_COLOR[r.key] }} />
                {REPLAY_VERDICTS[r.key].label}
              </td>
              <td className="py-1.5 pr-3">{r.facts}</td>
              <td className="py-1.5">{r.customer}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mb-1 text-muted-foreground">Failed tickets lost to our side (time limit, provider error) get no group.</p>
    </details>
  );
}

/** How a failed ticket's replay group is decided: the three replays and what each result means. On a run graded by
 *  facts, how its fact verdict is decided instead. */
export function VerdictGuide({ facts = false }: { facts?: boolean }) {
  if (facts) return <FactGuide />;
  return (
    <details className="mt-4 rounded-lg border px-4 py-2 font-sans text-xs">
      <summary className="cursor-pointer py-1 text-muted-foreground hover:text-foreground">How the groups are decided</summary>
      <p className="mt-2 max-w-3xl leading-relaxed text-muted-foreground">
        Every failed ticket is replayed. First with <b className="text-foreground">the rule and the customer&apos;s facts</b> given to the
        agent (as guidance in its system prompt) and a plain customer (no special behavior). If that passes, twice more: with{" "}
        <b className="text-foreground">the rule alone</b> (the ticket&apos;s original customer) and with{" "}
        <b className="text-foreground">the facts alone</b> (the plain customer). The results pick the group:
      </p>
      <table className="mt-3 mb-2 w-full">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">group</th>
            <th className="py-1.5 pr-3 font-medium">rule + facts</th>
            <th className="py-1.5 pr-3 font-medium">rule alone</th>
            <th className="py-1.5 pr-3 font-medium">facts alone</th>
            <th className="py-1.5 font-medium">and</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key} className="border-b border-border/60">
              <td className="py-1.5 pr-3">
                <span className="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]" style={{ background: VERDICT_COLOR[r.key] }} />
                {REPLAY_VERDICTS[r.key].label}
              </td>
              {[r.full, r.rule, r.facts].map((x, i) => (
                <td key={i} className={x === "passes" ? "py-1.5 pr-3" : "py-1.5 pr-3 text-muted-foreground"}>
                  {x === "passes" ? "✓ passes" : x === "fails" ? "✗ fails" : "–"}
                </td>
              ))}
              <td className="py-1.5 text-muted-foreground">{r.also ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mb-1 text-muted-foreground">
        Tickets whose prompt hit a token cap are replayed without it; if that alone fixes them, the group is &ldquo;{REPLAY_VERDICTS["prompt cap"].label}&rdquo;.
      </p>
    </details>
  );
}
