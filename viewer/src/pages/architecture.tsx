import { use } from "react";
import { useJob } from "@/lib/route";
import { TextLink } from "@/components/link";
import { getMeta, listJobs, parseRunKey } from "@/lib/data";
import { ChartCard, GroupedBarsLine, How, Legend, LineChart, VIZ, type LineSeries } from "@/components/charts";
import { architectureForStage, type ArchRow } from "@/lib/runtime-architecture";

const stageLabel = (r: ArchRow) => r.step.replace(/^stage(\d+)$/, "stage $1");

/** skyway-arch: the architecture each run was given (tasks/skyway-arch/architectures/<name>.md), in plain words. */
const ASSIGNED: Record<string, string> = {
  "raw-index": "The raw docs, searched with an index (keyword and embedding search).",
  "raw-terminal": "The raw docs, read with terminal tools (grep, opening files).",
  "wiki-index": "A wiki the builder wrote from the docs, searched with an index.",
  "wiki-terminal": "A wiki the builder wrote from the docs, read with terminal tools.",
  "graph-query": "A knowledge graph built from the docs, queried while handling tickets.",
  "prompt-workflows": "No search: the knowledge is written into the agent's prompts and workflows.",
};

export default function ArchitecturePage() {
  const job = useJob();
  const meta = use(getMeta(job));
  // A run with a fixed architecture (skyway-arch) shows that architecture; the grader's class is shown as what it saw.
  const assigned = use(listJobs(parseRunKey(job).task)).find((j) => j.key === job)?.architecture ?? null;
  const rows = meta.stages.map((s) => architectureForStage(s, meta.scores[String(s)]));
  const hasData = rows.some((r) => r.qTotal || Object.keys(r.stated).length || Object.keys(r.observed).length);

  if (!hasData) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight">Agent design</h1>
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

  // F2: one line per architecture class; a class only has points at the stages whose bot had it.
  const classes = [...new Set(rows.map((r) => r.archClass ?? "unknown"))];
  const rate = (r: ArchRow) => (r.qTotal ? { value: (r.qPassed ?? 0) / r.qTotal, note: `${r.qPassed}/${r.qTotal}` } : { value: null });
  const classSeries: LineSeries[] = classes.map((c, i) => ({
    key: c,
    label: c,
    color: VIZ[[1, 0, 2, 4, 3][i % 5]],
    points: rows.map((r) => ((r.archClass ?? "unknown") === c ? rate(r) : { value: null })),
  }));
  const designs = [...new Set(rows.map((r) => r.architectureChoice).filter((d) => d && d !== "—"))];

  // Latency per stage, from results.json (every ticket): one model call, one bot run (one reply), one ticket.
  const lat = rows.map((r) => meta.scores[String(r.stage)]?.latency ?? null);
  const hasLatency = lat.some((l) => l?.run);
  const wall = lat.some((l) => l?.run_kind === "wall");
  const sec = (v: number) => (v < 10 ? `${v.toFixed(1)} s` : `${Math.round(v)} s`);
  // Latency: p90 of one agent reply (a bot run), the time 9 in 10 replies stay under.
  const p90s = lat.map((l) => l?.run?.p90).filter((v): v is number => v != null);
  const p90Typical = p90s.length ? [...p90s].sort((x, y) => x - y)[Math.floor((p90s.length - 1) / 2)] : null;
  const replyLabel = wall ? "Agent reply" : "Agent reply (model time)";
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
      <h1 className="text-xl font-semibold tracking-tight">Agent design</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">How the agent the builder made gets its knowledge, and how fast it replies.</p>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-4">
        <div>
          <div className="font-sans text-sm font-medium">The agent&apos;s code, and how it was built</div>
          <div className="font-sans text-xs text-muted-foreground">Every file the builder wrote, stage by stage, what changed between stages, and the builder&apos;s own log of each build.</div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <TextLink href={`/runs/${job}/code`}>See the agent&apos;s code</TextLink>
          <TextLink href={`/runs/${job}/build`}>See the build logs</TextLink>
        </div>
      </div>

      {assigned && (
        <section className="mt-6 rounded-lg border px-4 py-3">
          <div className="font-sans text-xs text-muted-foreground">Architecture · fixed for this run</div>
          <div className="mt-1 font-mono text-lg font-semibold">{assigned}</div>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            {ASSIGNED[assigned] ?? "Given to the builder in its instructions at every stage."} The builder was told to build
            this design at every stage. What the grader saw the agent read:{" "}
            <span className="text-foreground">{classes.join("; ")}</span>. The grader sorts into wiki, keyword search and
            embedding search only, so it has no label for a graph, prompt-only knowledge or grep.
          </p>
        </section>
      )}

      {assigned && classes.length === 1 ? null : classes.length === 1 ? (
        <section className="mt-6 rounded-lg border px-4 py-3">
          <div className="font-sans text-xs text-muted-foreground">Architecture class · every stage</div>
          <div className="mt-1 text-lg font-semibold">
            <How how="Set from what the grader saw the agent's model read while it handled tickets: rules already in its prompt, pages it opened from a wiki, or results from a search over the docs (retrieval). Not from the builder's own description.">
              {classes[0]}
            </How>
          </div>
          <p className="mt-1 font-sans text-xs text-muted-foreground">
            How the agent gets its knowledge, as the grader saw it run (not the builder&apos;s claim): from notes in its prompt,
            a wiki it reads, or a search over the docs.
            {designs.length > 0 && <> The builder described it as {designs.map((d) => `“${d}”`).join("; ")}.</>} Comparing
            architectures needs runs that built different ones.
          </p>
        </section>
      ) : (
      <ChartCard
        className="mt-10"
        title="Pass rate at each stage, by architecture"
        scope={{ label: "All stages" }}
        how="Each point: tickets passed ÷ tickets at that stage, drawn on the line of the architecture class the grader saw at that stage."
        subtitle={
          <>
            Share of tickets right at each stage, one line per architecture (how the agent gets its knowledge, as the grader saw
            it run).{designs.length > 0 && <> Builder&apos;s own description: {designs.map((d) => `“${d}”`).join("; ")}.</>}
          </>
        }
      >
        <LineChart xLabels={rows.map(stageLabel)} series={classSeries} />
        <Legend items={classSeries.map((x) => ({ key: x.key, label: x.label, value: 0, color: x.color }))} shape="line" />
      </ChartCard>
      )}

      {hasLatency && (
        <ChartCard
          className="mt-14"
          title={`How long the agent takes to reply · p90 ${p90Typical == null ? "—" : sec(p90Typical)}`}
          how={`For each stage, every reply's time is sorted (${wall ? "start to end of the agent's run" : "the model time of one agent process"}, over all tickets, passed or failed) and the p90 is the value 90% of the way up the list. The title shows the middle of the stage p90s.`}
          subtitle={`One reply = the agent handling one customer message (about 5 per ticket). The p90 is the time 9 in 10 replies finish within.${wall ? "" : " This run times a reply by its model calls only; newer runs time the whole reply."} The title shows the middle stage.`}
          table={latTable}
        >
          <GroupedBarsLine xLabels={rows.map(stageLabel)} bars={latSeries} yMax={latTop} ticks={latTicks} format={sec} height={240} />
          <div className="mt-3 font-sans text-xs text-muted-foreground">{replyLabel}, p90 per stage, in seconds</div>
        </ChartCard>
      )}
    </div>
  );
}
