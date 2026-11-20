import { Outlet } from "react-router";
import { Suspense, use, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useJob } from "@/lib/route";
import Link from "@/components/link";
import { getMeta, listJobs, parseRunKey } from "@/lib/data";
import { FOCUS, architectureRuns, passRate } from "@/lib/leaderboard";
import { agentName } from "@/lib/agent-name";
import { BackBar, JobNav } from "@/components/job-nav";
import { DocProvider } from "@/components/doc-sheet";
import { ThemeToggle } from "@/components/theme-toggle";

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
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">architecture</span>
      <select
        value={me.key}
        onChange={(e) => {
          const next = e.target.value;
          setOpening(jobs.find((j) => j.key === next)?.architecture ?? "run");
          navigate(pathname.replace(`/runs/${job}`, `/runs/${next}`) + search);
        }}
        className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
      >
        {runs.map((r) => (
          <option key={r.key} value={r.key}>
            {r.architecture} · {Math.round(100 * (passRate(r)?.rate ?? 0))}%
          </option>
        ))}
      </select>
      {opening && <span className="text-muted-foreground">opening {opening}…</span>}
    </label>
  );
}

export default function JobLayout() {
  const job = useJob();
  const meta = use(getMeta(job));
  const short = (m: string | null) => (m ? m.split("/").pop() : "unknown");
  return (
    <div className="flex h-screen flex-col">
      <header className="relative flex flex-wrap items-center gap-x-8 gap-y-2 border-b pt-3.5 pr-14 pb-3.5 pl-4 sm:pr-16 sm:pl-6">
        <Link href="/" className="text-sm font-semibold">C2A</Link>
        <div className="min-w-0">
          <div className="truncate font-mono text-xs">{meta.job}</div>
          <div className="text-[11px] text-muted-foreground">
            builder {agentName(meta.builder.agent)}/{short(meta.builder.model)} · agent {short(meta.bot)}
          </div>
        </div>
        <Suspense fallback={null}><ArchSwitch job={job} /></Suspense>
        <JobNav job={job} meta={meta} />
        {/* always at the top right, even when the header wraps onto more lines */}
        <ThemeToggle className="absolute top-3.5 right-4 sm:right-6" />
      </header>
      <BackBar job={job} />
      <div className="min-h-0 flex-1">
        <DocProvider job={job}><Outlet /></DocProvider>
      </div>
    </div>
  );
}
