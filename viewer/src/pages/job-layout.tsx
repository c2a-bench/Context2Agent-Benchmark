import { Outlet } from "react-router";
import { Suspense, use, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useJob } from "@/lib/route";
import Link from "@/components/link";
import { getMeta, listJobs, listTasks, parseRunKey } from "@/lib/data";
import { FOCUS, architectureGroups, architectureRuns, leaderboardRuns, passRate } from "@/lib/leaderboard";
import type { JobSummary } from "@/lib/data";
import { agentName } from "@/lib/agent-name";
import { BackBar, JobNav } from "@/components/job-nav";
import { DocProvider } from "@/components/doc-sheet";
import { CrumbSep, SiteNav } from "@/landing/nav";
import { ChevronDown } from "lucide-react";

const model = (m: string | null | undefined) => (m ? m.split("/").pop()! : "unknown");
const pct = (j: JobSummary) => Math.round(100 * (passRate(j)?.rate ?? 0));

/** One builder model's run per row of an environment's leaderboard (the run the viewer opens for that model). With an
 *  architecture, the model's run of that architecture when it has one. */
function modelRuns(task: string, jobs: JobSummary[], arch?: string | null): JobSummary[] {
  const current = FOCUS.find((f) => f.id === task)?.current;
  const groups = architectureGroups(jobs, current);
  if (groups.length) return groups.map((g) => g.runs.find((r) => r.architecture === arch) ?? g.lead);
  const seen = new Set<string>();
  return leaderboardRuns(jobs.filter((j) => !jobs.some((x) => x.id === `${j.id}-facts`)), current ?? "")
    .filter((j) => !seen.has(model(j.builder.model)) && !!seen.add(model(j.builder.model)));
}

/** A breadcrumb part that is also a picker: reads as text, opens the browser's own list. */
function CrumbSelect({ label, value, options, onPick }: { label: string; value: string; options: { value: string; text: string }[]; onPick: (v: string) => void }) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        style={{ fieldSizing: "content" } as React.CSSProperties}
        className="here cursor-pointer appearance-none bg-transparent pr-4 font-medium outline-none [&>option]:bg-background [&>option]:text-foreground"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 size-3.5 opacity-60" aria-hidden />
    </span>
  );
}

/** Where this run sits, each part a switch: environment / builder model / architecture (when the run has one). */
function Crumbs({ job }: { job: string }) {
  const { task } = parseRunKey(job);
  const tasks = use(listTasks());
  const jobs = use(listJobs(task));
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => setOpening(null), [job]);
  const me = jobs.find((j) => j.key === job);
  if (!me) return null;
  // Another run of this environment: the same page of it (tabs are the same within an environment).
  const go = (key: string, what: string) => {
    if (key === job) return;
    setOpening(what);
    navigate(pathname.replace(`/runs/${job}`, `/runs/${key}`) + search);
  };
  const models = modelRuns(task, jobs, me.architecture);
  if (!models.some((r) => model(r.builder.model) === model(me.builder.model))) models.push(me);
  const archs = me.architecture ? architectureRuns(jobs, me, FOCUS.find((f) => f.id === task)?.current) : [];
  if (me.architecture && !archs.some((r) => r.key === me.key)) archs.push(me);
  return (
    <>
      <span className="contents max-sm:hidden"><Link href="/#environments">Viewer</Link><CrumbSep /></span>
      <CrumbSelect
        label="Environment"
        value={task}
        options={tasks.map((t) => ({ value: t.id, text: t.name }))}
        onPick={(next) => { setOpening(next); navigate(`/t/${next}`); }}
      />
      <CrumbSep />
      <CrumbSelect
        label="Builder model"
        value={models.find((r) => model(r.builder.model) === model(me.builder.model))!.key}
        options={models.map((r) => ({ value: r.key, text: `${model(r.builder.model)} · ${pct(r)}%` }))}
        onPick={(next) => go(next, model(jobs.find((j) => j.key === next)?.builder.model))}
      />
      {me.architecture && (
        <>
          <CrumbSep />
          <CrumbSelect
            label="Architecture"
            value={me.key}
            options={archs.map((r) => ({ value: r.key, text: `${r.architecture} · ${pct(r)}%` }))}
            onPick={(next) => go(next, jobs.find((j) => j.key === next)?.architecture ?? "run")}
          />
        </>
      )}
      {opening && <span className="text-xs font-normal opacity-60">opening {opening}…</span>}
    </>
  );
}

export default function JobLayout() {
  const job = useJob();
  const meta = use(getMeta(job));
  const short = (m: string | null) => (m ? m.split("/").pop() : "unknown");
  const day = meta.job.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const crumbs = <Suspense fallback={null}><Crumbs job={job} /></Suspense>;
  return (
    <div className="flex h-screen flex-col">
      <SiteNav crumbs={crumbs} />
      {/* phone: the switches on their own line (the nav has no room for them) */}
      <div className="lp shrink-0 border-b px-6 py-2 sm:hidden"><div className="lp-crumbs">{crumbs}</div></div>
      {/* the run's tabs, on the pages' width; pages with stages put their stage picker at the end (#run-bar-slot) */}
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 px-6">
          <JobNav job={job} meta={meta} />
          <div id="run-bar-slot" className="ml-auto shrink-0 empty:hidden max-sm:ml-0 max-sm:w-full max-sm:border-t" title={`run ${meta.job} · ${agentName(meta.builder.agent)} · agent ${short(meta.bot)}${day ? ` · ${day}` : ""}`} />
        </div>
      </header>
      <BackBar job={job} />
      <div className="min-h-0 flex-1">
        <DocProvider job={job}><Outlet /></DocProvider>
      </div>
    </div>
  );
}
