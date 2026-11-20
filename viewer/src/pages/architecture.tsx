import { use, useState } from "react";
import { useJob } from "@/lib/route";
import { TextLink } from "@/components/link";
import { getMeta, listJobs, parseRunKey } from "@/lib/data";
import { ChartCard, GroupedBarsLine, VIZ, type LineSeries } from "@/components/charts";
import { architectureForStage, type ArchRow } from "@/lib/runtime-architecture";

const stageLabel = (r: ArchRow) => r.step.replace(/^stage(\d+)$/, "stage $1");

/** Skyway: the architecture each run was given (tasks/skyway-air/architectures/<name>.md), in plain words. */
const ASSIGNED: Record<string, string> = {
  "raw-index": "Searches the original docs with keyword and embedding search.",
  "raw-terminal": "Reads the original docs directly, with tools like grep.",
  "wiki-index": "Searches a wiki the builder wrote from the docs.",
  "wiki-terminal": "Reads a wiki the builder wrote from the docs, with tools like grep.",
  "graph-query": "Looks things up in a knowledge graph built from the docs.",
  "prompt-workflows": "No search: the rules are written into the agent's prompts.",
};

/** What the grader found in the agent at a stage, from its run or its code (knowledge_access), in plain words. */
const SEEN: Record<string, string> = {
  llm_wiki: "a wiki",
  sparse_retrieval: "keyword search",
  dense_retrieval: "embedding search",
  knowledge_graph: "a knowledge graph",
};
const SEEN_ORDER = ["llm_wiki", "sparse_retrieval", "dense_retrieval", "knowledge_graph"];
const OLD_CLASS: Record<string, string> = {
  Retrieval: "a search over the docs",
  "Multi-prompt": "several prompts, no search",
  "Tool loop": "tools, no search",
  "Single call": "one prompt, no search",
};
function seenAt(r: ArchRow): string | null {
  const ka = r.raw?.observed?.knowledge_access;
  if (!Array.isArray(ka)) return r.archClass ? OLD_CLASS[r.archClass] ?? r.archClass : null;
  if (!ka.length) return "none of these: no wiki, search or knowledge graph";
  return [...ka].sort((a, b) => SEEN_ORDER.indexOf(a) - SEEN_ORDER.indexOf(b)).map((c) => SEEN[c] ?? c).join(" + ");
}

/** The same as one line when every stage saw the same; else runs of stages ("stages 0–2: …; stages 3–5: …"). */
function seenLine(rows: ArchRow[]): string | null {
  const parts: { from: number; to: number; seen: string }[] = [];
  for (const r of rows) {
    const s = seenAt(r);
    if (s == null) continue;
    const last = parts[parts.length - 1];
    if (last && last.seen === s && last.to === r.stage - 1) last.to = r.stage;
    else parts.push({ from: r.stage, to: r.stage, seen: s });
  }
  if (!parts.length) return null;
  const seens = new Set(parts.map((p) => p.seen));
  if (seens.size === 1) return parts[0].seen;
  return parts.map((p) => `${p.from === p.to ? `stage ${p.from}` : `stages ${p.from}–${p.to}`}: ${p.seen}`).join("; ");
}

/** The builder's own name for its design: two lines, with a toggle to read all of it when it is longer. */
function BuilderSays({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 110;
  return (
    <div className="mt-1 font-sans text-sm text-muted-foreground">
      <p className={open ? "" : "line-clamp-2"}>The builder calls it: &ldquo;{text}&rdquo;</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-current">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

export default function ArchitecturePage() {
  const job = useJob();
  const meta = use(getMeta(job));
  // A run with a fixed architecture (Skyway) shows that architecture; the grader's class is shown as what it saw.
  const assigned = use(listJobs(parseRunKey(job).task)).find((j) => j.key === job)?.architecture ?? null;
  const rows = meta.stages.map((s) => architectureForStage(s, meta.scores[String(s)]));
  const hasData = rows.some((r) => r.qTotal || Object.keys(r.stated).length || Object.keys(r.observed).length);

  if (!hasData) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="font-heading text-3xl font-normal tracking-tight">Agent design</h1>
        {assigned && (
          <p className="mt-6 text-sm">
            Architecture, fixed for this run: <span className="font-mono font-semibold">{assigned}</span>.{" "}
            <span className="text-muted-foreground">{ASSIGNED[assigned] ?? ""}</span>
          </p>
        )}
        <p className="mt-8 text-sm text-muted-foreground">No architecture logs for this run.</p>
      </div>
    );
  }

  const lastDesign = [...rows].reverse().map((r) => r.architectureChoice).find((d) => d && d !== "—") ?? null;
  const seen = seenLine(rows);

  // Latency per stage, from results.json (every ticket): one model call, one bot run (one reply), one ticket.
  const lat = rows.map((r) => meta.scores[String(r.stage)]?.latency ?? null);
  const hasLatency = lat.some((l) => l?.run);
  const wall = lat.some((l) => l?.run_kind === "wall");
  const sec = (v: number) => (v < 10 ? `${v.toFixed(1)} s` : `${Math.round(v)} s`);
  // Latency: p90 of one agent reply (a bot run), the time 9 in 10 replies stay under.
  const p90s = lat.map((l) => l?.run?.p90).filter((v): v is number => v != null);
  const p90Typical = p90s.length ? [...p90s].sort((x, y) => x - y)[Math.floor((p90s.length - 1) / 2)] : null;
  const replyLabel = wall ? "Agent reply" : "Agent reply (model time)";
  // Replies per ticket in this run: all replies ÷ all tickets, over the stages with timings.
  const nRuns = lat.reduce((a, l) => a + (l?.run?.n ?? 0), 0), nTickets = lat.reduce((a, l) => a + (l?.ticket?.n ?? 0), 0);
  const perTicket = nTickets ? Math.round((10 * nRuns) / nTickets) / 10 : null;
  const latSeries: LineSeries[] = [
    { key: "p90", label: "p90", color: VIZ[0], points: lat.map((l) => ({ value: l?.run?.p90 ?? null, note: l?.run ? `${l.run.n} replies` : undefined })) },
  ];
  const latMax = Math.max(1, ...p90s);
  const latStep = latMax > 40 ? 10 : 5;
  const latTop = Math.ceil(latMax / latStep) * latStep;
  const latTicks = Array.from({ length: latTop / latStep + 1 }, (_, i) => i * latStep);
  const latTable = (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">step</th>
          <th className="py-2 pr-3 font-medium">reply p90</th>
          <th className="py-2 font-medium">replies</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.stage} className="border-b border-border/60">
            <td className="py-2 pr-3">{stageLabel(r)}</td>
            <td className="py-2 pr-3 tabular-nums">{lat[i]?.run ? sec(lat[i]!.run!.p90) : "—"}</td>
            <td className="py-2 tabular-nums text-muted-foreground">{lat[i]?.run?.n ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-heading text-3xl font-normal tracking-tight">Agent design</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">How the agent the builder made gets its knowledge, and how fast it replies.</p>
      <div className={`mt-6 grid gap-4 ${assigned || seen ? "sm:grid-cols-2" : ""}`}>
        {(assigned || seen) && (
          <section className="rounded-xl border px-5 py-4">
            <div className="font-sans text-xs text-muted-foreground">{assigned ? "Design, the same at every stage" : "Design, chosen by the builder"}</div>
            {assigned ? (
              <>
                <div className="mt-1 font-mono text-lg font-semibold">{assigned}</div>
                <p className="mt-1 font-sans text-sm text-muted-foreground">{ASSIGNED[assigned] ?? "Given to the builder in its instructions at every stage."}</p>
              </>
            ) : lastDesign && (
              <BuilderSays text={lastDesign} />
            )}
            {seen && (
              <p className="mt-2 font-sans text-sm">
                <span className="text-muted-foreground">What we found in the agent: </span>{seen}
              </p>
            )}
          </section>
        )}
        <section className="flex flex-col justify-between gap-3 rounded-xl border px-5 py-4">
          <div>
            <div className="font-sans text-sm font-medium">The agent&apos;s code and build logs</div>
            <div className="mt-1 font-sans text-sm text-muted-foreground">Every file the builder wrote, stage by stage, and its own log of each build.</div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <TextLink href={`/runs/${job}/code`}>See the agent&apos;s code</TextLink>
            <TextLink href={`/runs/${job}/build`}>See the build logs</TextLink>
          </div>
        </section>
      </div>


      {hasLatency && (
        <ChartCard
          className="mt-14"
          title={`How long the agent takes to reply · p90 ${p90Typical == null ? "—" : sec(p90Typical)}`}
          how={`A reply is the agent handling one customer message${perTicket ? ` (about ${perTicket} per ticket in this run)` : ""}. For each stage, every reply's time is sorted (${wall ? "start to end of the agent's run" : "the model time of one agent process; this run predates timing whole replies"}, over all tickets, passed or failed) and the p90 is the value 90% of the way up the list. The number in the title is the middle of the stage p90s.`}
          subtitle="How long the agent takes to reply to a customer message. Each bar shows the time within which 90% of replies were sent."
          table={latTable}
        >
          <GroupedBarsLine xLabels={rows.map(stageLabel)} bars={latSeries} yMax={latTop} ticks={latTicks} format={sec} height={240} />
          <div className="mt-3 font-sans text-xs text-muted-foreground">{replyLabel}, p90 per stage, in seconds</div>
        </ChartCard>
      )}
    </div>
  );
}
