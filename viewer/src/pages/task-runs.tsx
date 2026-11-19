import { use, useState } from "react";
import Link, { TextLink } from "@/components/link";
import { useParams } from "react-router";
import { NotFound } from "@/pages/not-found";
import { listJobs, listTasks } from "@/lib/data";
import { agentName } from "@/lib/agent-name";
import { FOCUS, architectureGroups, offLeaderboard } from "@/lib/leaderboard";
import { ArchPicker, pooledRate } from "@/components/arch-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";

const short = (m: string | null) => (m ? m.split("/").pop() : "—");

/** The runs tables' sortable columns: click a heading to sort by it, click again to flip the order. */
type SortKey = "model" | "passed" | "cost";
type Sort = { key: SortKey; desc: boolean };
const SORT_DEFAULT: Sort = { key: "passed", desc: true };
type SortRow = { model: string; passed: number | null; cost: number | null };
function sortRows<T>(rows: T[], sort: Sort, val: (r: T) => SortRow): T[] {
    const v = (r: T) => val(r)[sort.key];
    return [...rows].sort((a, b) => {
        const x = v(a), y = v(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1; // empty values last, whichever the order
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sort.desc ? -c : c;
    });
}
function SortTh({ label, k, sort, setSort }: { label: string; k: SortKey; sort: Sort; setSort: (s: Sort) => void }) {
    const on = sort.key === k;
    // text columns start A→Z, numbers start highest first
    const first = k !== "model";
    return (
        <th className="px-4 py-2.5 font-medium" aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
            <button type="button" className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground ${on ? "text-foreground" : ""}`} onClick={() => setSort(on ? { key: k, desc: !sort.desc } : { key: k, desc: first })}>
                {label}
                {/* up and down arrows stacked on every sortable column; on the sorted one, its direction lights up */}
                <span aria-hidden className="inline-flex flex-col text-[7px] leading-[7px]">
                    <span className={on && !sort.desc ? "text-foreground" : "opacity-35"}>▲</span>
                    <span className={on && sort.desc ? "text-foreground" : "opacity-35"}>▼</span>
                </span>
            </button>
        </th>
    );
}
const HEADS: [string, SortKey][] = [["Builder model", "model"], ["Tickets passed", "passed"], ["Builder cost", "cost"]];

export default function TaskRuns() {
    const { task = "" } = useParams();
    const [sort, setSort] = useState<Sort>(SORT_DEFAULT);
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
            <ThemeToggle className="fixed top-4 right-6 z-30 border bg-background shadow-sm" />
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
                // The same table as the architecture environments (ArchitectureRuns below), one row per run, best first.
                <div className="mt-6 overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm">
                        <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                            <tr>
                                {HEADS.slice(0, 2).map(([label, k]) => <SortTh key={k} label={label} k={k} sort={sort} setSort={setSort} />)}
                                <th className="px-4 py-2.5 font-medium">Reasoning</th>
                                {HEADS.slice(2).map(([label, k]) => <SortTh key={k} label={label} k={k} sort={sort} setSort={setSort} />)}
                                <th className="px-4 py-2.5 font-medium">Run</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortRows(jobs, sort, (j) => ({ model: short(j.builder.model) ?? "", passed: pooledRate([j])?.rate ?? null, cost: j.cost ?? null })).map((j) => {
                                const off = offLeaderboard(task, j, all);
                                const rate = pooledRate([j]);
                                return (
                                    <tr key={j.id} className="border-t align-top">
                                        <td className="px-4 py-3">
                                            {short(j.builder.model)}<span className="ml-2 text-xs text-muted-foreground">{agentName(j.builder.agent)}</span>
                                            {off && <span className="ml-1 text-amber-700 dark:text-amber-400" title={off}>†</span>}
                                            {!j.finished && <Badge variant="outline" className="ml-2">not finished</Badge>}
                                        </td>
                                        <td className="px-4 py-3 tabular-nums"><span className="text-base font-semibold">{rate ? `${Math.round(100 * rate.rate)}%` : "—"}</span>{rate && <span className="ml-2 text-xs text-muted-foreground">{rate.passed}/{rate.total}</span>}</td>
                                        <td className="px-4 py-3 text-muted-foreground">{j.thinking || "—"}</td>
                                        <td className="px-4 py-3 tabular-nums text-muted-foreground">{j.cost == null ? "—" : `$${j.cost.toFixed(2)}`}</td>
                                        <td className="px-4 py-3"><TextLink href={`/runs/${j.key}`} className="font-medium">Open</TextLink></td>
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
    const [sort, setSort] = useState<Sort>(SORT_DEFAULT);
    const costOf = (runs: typeof groups[number]["runs"]) => { const c = runs.map((r) => r.cost).filter((x): x is number => x != null); return c.length ? c.reduce((a, x) => a + x, 0) : null; };
    return (
        <main className="mx-auto w-full max-w-6xl px-6 py-10">
            <ThemeToggle className="fixed top-4 right-6 z-30 border bg-background shadow-sm" />
            <Link href="/" className="link-text text-sm">← Companies</Link>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">Each row is one builder model's run of the whole environment: one agent per architecture. Choose an architecture to open its run; inside, the header switches between them.</p>
            <div className="mt-6 overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                    <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                            {HEADS.slice(0, 2).map(([label, k]) => <SortTh key={k} label={label} k={k} sort={sort} setSort={setSort} />)}
                            <th className="px-4 py-2.5 font-medium">Reasoning</th>
                            {HEADS.slice(2).map(([label, k]) => <SortTh key={k} label={label} k={k} sort={sort} setSort={setSort} />)}
                            <th className="px-4 py-2.5 font-medium">Run</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortRows(groups, sort, ({ lead, runs }) => ({ model: short(lead.builder.model) ?? "", passed: pooledRate(runs)?.rate ?? null, cost: costOf(runs) })).map(({ lead, runs }) => {
                            const rate = pooledRate(runs);
                            const costs = runs.map((r) => r.cost).filter((c): c is number => c != null);
                            return (
                                <tr key={lead.key} className="border-t align-top">
                                    <td className="px-4 py-3">{short(lead.builder.model)}<span className="ml-2 text-xs text-muted-foreground">{agentName(lead.builder.agent)}</span></td>
                                    <td className="px-4 py-3 tabular-nums"><span className="text-base font-semibold">{pct(rate?.rate)}</span>{rate && <span className="ml-2 text-xs text-muted-foreground">{rate.passed}/{rate.total}</span>}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{lead.thinking || "—"}</td>
                                    <td className="px-4 py-3 tabular-nums text-muted-foreground">{costs.length ? `$${costs.reduce((a, c) => a + c, 0).toFixed(2)}` : "—"}</td>
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
