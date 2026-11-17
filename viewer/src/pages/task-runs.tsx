import { use } from "react";
import Link, { TextLink } from "@/components/link";
import { useParams } from "react-router";
import { NotFound } from "@/pages/not-found";
import { listJobs, listTasks } from "@/lib/data";
import { agentName } from "@/lib/agent-name";
import { FOCUS, architectureGroups, offLeaderboard } from "@/lib/leaderboard";
import { ArchPicker, pooledRate } from "@/components/arch-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { behaviorForStage, combineBehaviorStages } from "@/lib/behavior-coverage";

const short = (m: string | null) => (m ? m.split("/").pop() : "—");
const when = (iso: string | null, id: string) =>
    iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : id;

export default function TaskRuns() {
    const { task = "" } = useParams();
    const info = use(listTasks()).find((t) => t.id === task);
    if (!info) return <NotFound />;
    const all = use(listJobs(task));
    // A run with a -facts copy (the same run, graded by facts) is shown once, as that copy: the plain copy stays
    // uploaded and opens by its link.
    const jobs = all.filter((j) => !all.some((x) => x.id === `${j.id}-facts`));
    const groups = architectureGroups(all, FOCUS.find((f) => f.id === task)?.current);
    if (groups.length) return <ArchitectureRuns name={info.name} groups={groups} />;
    return (
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
            <ThemeToggle className="fixed top-4 right-6" />
            <Link href="/" className="link-text text-sm">← Companies</Link>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{info.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Runs in tasks/{task}/jobs, newest first. Click a run to replay its tickets and the agent’s code.</p>
            {jobs.some((j) => offLeaderboard(task, j, all)) && (
                <p className="mt-1 text-sm text-muted-foreground">
                    <span className="text-amber-700 dark:text-amber-400">†</span> Not on the leaderboard (hover it for why): an older version of the tickets, or a newer run of the same model.
                </p>
            )}

            {jobs.length === 0 ? (
                <p className="mt-6 text-sm text-muted-foreground">No runs yet.</p>
            ) : (
                <div className="mt-6 overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2.5 font-medium">Run</th>
                                <th className="px-4 py-2.5 font-medium">Score</th>
                                <th className="px-4 py-2.5 font-medium">Builder</th>
                                <th className="px-4 py-2.5 font-medium">Agent model</th>
                                <th className="px-4 py-2.5 font-medium" title="Not recorded by the run: the agent model unless CUSTOMER_MODEL was set">Customer model*</th>
                                <th className="px-4 py-2.5 font-medium">Cost</th>
                                <th className="px-4 py-2.5 font-medium" title="Pass rate of each customer type over every stage's behavior tickets, averaged with every type counting the same (old runs: uniform mean over scenario cells)">Avg. across customer types</th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((j) => {
                                const off = offLeaderboard(task, j, all);
                                const cov = combineBehaviorStages(j.scores.map((s) => behaviorForStage(s.stage, s)))?.coverage;
                                return (
                                <tr key={j.id} className="border-t align-top">
                                    <td className="px-4 py-3">
                                        <TextLink href={`/runs/${j.key}`} className="font-medium">{when(j.started, j.id)}</TextLink>
                                        {off && <span className="ml-1 text-amber-700 dark:text-amber-400" title={off}>†</span>}
                                        {j.architecture && <div className="mt-0.5 text-xs">architecture <span className="font-mono font-medium">{j.architecture}</span></div>}
                                        <div className="font-mono text-[11px] text-muted-foreground">{j.id}</div>
                                        {!j.finished && <Badge variant="outline" className="mt-1">not finished</Badge>}
                                    </td>
                                    <td className="px-4 py-3 text-base font-semibold tabular-nums">{j.score == null ? "—" : `${Math.round(j.score * 100)}%`}</td>
                                    <td className="px-4 py-3">{agentName(j.builder.agent)}<div className="text-muted-foreground">{short(j.builder.model)}</div></td>
                                    <td className="px-4 py-3">{short(j.bot)}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{short(j.bot)}*</td>
                                    <td className="px-4 py-3 tabular-nums">{j.cost == null ? "—" : `$${j.cost.toFixed(2)}`}</td>
                                    <td className="px-4 py-3">
                                        {cov ? (
                                            <TextLink
                                              href={`/runs/${j.key}/research/behavior`}
                                              className="font-mono text-sm font-semibold tabular-nums"
                                              title={cov.mode === "per_ticket" ? `Average over ${cov.n_behaviors ?? Object.keys(cov.by_category ?? {}).length} behaviors` : `${cov.n_scenarios} scenario cells`}
                                            >
                                              {cov.q_coverage.toFixed(2)}
                                            </TextLink>
                                        ) : (
                                            <span className="text-muted-foreground">—</span>
                                        )}
                                    </td>
                                </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

        </main>
    );
}

/** An environment with one architecture per run (skyway-arch): one row per builder model, which ran every
 *  architecture; the row asks which architecture's run to open. */
function ArchitectureRuns({ name, groups }: { name: string; groups: ReturnType<typeof architectureGroups> }) {
    const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(100 * n)}%`);
    return (
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
            <ThemeToggle className="fixed top-4 right-6" />
            <Link href="/" className="link-text text-sm">← Companies</Link>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Each row is one builder model's run of the whole environment: one agent per architecture. Choose an architecture to open its run; inside, the header switches between them.</p>
            <div className="mt-6 overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2.5 font-medium">Builder model</th>
                            <th className="px-4 py-2.5 font-medium">Tickets passed</th>
                            <th className="px-4 py-2.5 font-medium">Thinking</th>
                            <th className="px-4 py-2.5 font-medium">Builder cost</th>
                            <th className="px-4 py-2.5 font-medium">Started</th>
                            <th className="px-4 py-2.5 font-medium">Run</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map(({ lead, runs }) => {
                            const rate = pooledRate(runs);
                            const costs = runs.map((r) => r.cost).filter((c): c is number => c != null);
                            return (
                                <tr key={lead.key} className="border-t align-top">
                                    <td className="px-4 py-3">{short(lead.builder.model)}<span className="ml-2 text-xs text-muted-foreground">{agentName(lead.builder.agent)}</span></td>
                                    <td className="px-4 py-3 tabular-nums"><span className="text-base font-semibold">{pct(rate?.rate)}</span>{rate && <span className="ml-2 text-xs text-muted-foreground">{rate.passed}/{rate.total}</span>}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{lead.thinking || "—"}</td>
                                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{costs.length ? `$${costs.reduce((a, c) => a + c, 0).toFixed(2)}` : "—"}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{when(lead.started, lead.id)}</td>
                                    <td className="px-4 py-3"><ArchPicker runs={runs} /></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </main>
    );
}
