import { Outlet } from "react-router";
import { Suspense, use, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useJob } from "@/lib/route";
import Link from "@/components/link";
import { getMeta, listJobs, listTasks, parseRunKey } from "@/lib/data";
import { FOCUS, architectureRuns, passRate } from "@/lib/leaderboard";
import { agentName } from "@/lib/agent-name";
import { BackBar, JobNav } from "@/components/job-nav";
import { DocProvider } from "@/components/doc-sheet";
import { CrumbSep, SiteNav } from "@/landing/nav";
import { ChevronDown } from "lucide-react";

/** For a run with a fixed architecture (Skyway): which one it is, and a switch to this model's other ones. */
function ArchSwitch({ job }: { job: string }) {
  const { task } = parseRunKey(job);
  const jobs = use(listJobs(task));
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const me = jobs.find((j) => j.key === job);
  // The page stays on this run until the picked one has loaded (its data is built the first time it is opened, up to
  // ~20 s for the big runs), so say that it is opening.
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => setOpening(null), [job]);
  if (!me?.architecture) return null;
  const runs = architectureRuns(jobs, me, FOCUS.find((f) => f.id === parseRunKey(me.key).task)?.current);
  if (!runs.some((r) => r.key === me.key)) runs.push(me);
  return (
    <>
      <CrumbSep />
      <span className="relative inline-flex items-center">
      <select
        aria-label="Architecture"
        value={me.key}
        onChange={(e) => {
          const next = e.target.value;
          setOpening(jobs.find((j) => j.key === next)?.architecture ?? "run");
          navigate(pathname.replace(`/runs/${job}`, `/runs/${next}`) + search);
        }}
        className="here cursor-pointer appearance-none bg-transparent pr-5 font-medium outline-none [&>option]:bg-background [&>option]:text-foreground"
      >
        {runs.map((r) => (
          <option key={r.key} value={r.key}>
            {r.architecture} · {Math.round(100 * (passRate(r)?.rate ?? 0))}%
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 size-3.5 opacity-60" aria-hidden />
      </span>
      {opening && <span className="text-xs font-normal opacity-60">opening {opening}…</span>}
    </>
  );
}

/** Where this run sits: Viewer / environment / builder model (/ architecture, with a switch to the other ones). */
function Crumbs({ job, builder }: { job: string; builder: string }) {
  const { task } = parseRunKey(job);
  const name = use(listTasks()).find((t) => t.id === task)?.name ?? task;
  return (
    <>
      {/* on a phone only the builder and architecture show; the logo and C2A lead home */}
      <span className="contents max-sm:hidden">
        <Link href="/#environments">Viewer</Link>
        <CrumbSep />
        <Link href={`/t/${task}`}>{name}</Link>
        <CrumbSep />
      </span>
      <span className="here">{builder}</span>
      <Suspense fallback={null}><ArchSwitch job={job} /></Suspense>
    </>
  );
}

export default function JobLayout() {
  const job = useJob();
  const meta = use(getMeta(job));
  const short = (m: string | null) => (m ? m.split("/").pop() : "unknown");
  const day = meta.job.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return (
    <div className="flex h-screen flex-col">
      <SiteNav crumbs={<Suspense fallback={null}><Crumbs job={job} builder={short(meta.builder.model) ?? "builder"} /></Suspense>} />
      {/* phone: the builder and architecture switch on their own line (the nav has no room for them) */}
      <div className="lp shrink-0 border-b px-6 py-2 sm:hidden">
        <div className="lp-crumbs"><Suspense fallback={null}><Crumbs job={job} builder={short(meta.builder.model) ?? "builder"} /></Suspense></div>
      </div>
      {/* the run's tabs, on the same width as the pages; the run's details sit at the end, small */}
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6">
          <JobNav job={job} meta={meta} />
          <div className="ml-auto hidden shrink-0 text-right text-[11px] leading-tight text-muted-foreground lg:block" title={`run ${meta.job}`}>
            {agentName(meta.builder.agent)} · agent {short(meta.bot)}{day && <><br />run of {day}</>}
          </div>
        </div>
      </header>
      <BackBar job={job} />
      <div className="min-h-0 flex-1">
        <DocProvider job={job}><Outlet /></DocProvider>
      </div>
    </div>
  );
}
