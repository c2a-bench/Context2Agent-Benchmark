import { Suspense, use, useState } from "react";
import { ChevronDown, Columns2, LayoutList, ListChecks, Library } from "lucide-react";
import { DiffViewer } from "@/components/monaco";
import { DocLink } from "@/components/doc-sheet";
import { RuleStatusBadge, WordDiff } from "@/components/conversation";
import { ROLE_ICON, ROLE_LABEL, ROLE_ORDER, mb } from "@/components/stage-view";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getText } from "@/lib/data";
import { useJob, useSetQuery } from "@/lib/route";
import type { ChangedFile, CodeStage, Transition } from "@/lib/types";

/** A changed file's two versions: inline (older runs) or fetched from the run's texts/ shards. A data file has no diff. */
function FileDiff({ f, sideBySide }: { f: ChangedFile; sideBySide: boolean }) {
  const job = useJob();
  if (f.data) {
    return <p className="p-6 text-sm text-muted-foreground">Data file {f.status}{f.status === "changed" ? `: ${mb(f.size_old)} → ${mb(f.size_new)}` : ""}. Not shown as text.</p>;
  }
  const original = f.old ?? use(getText(job, f.old_ref));
  const modified = f.new ?? use(getText(job, f.new_ref));
  return <DiffViewer path={f.path} original={original} modified={modified} sideBySide={sideBySide} tags={f.tags} />;
}

const TYPE_CLASS: Record<string, string> = {
  add: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  contradiction: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  scattered: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
};

function Overview({ t, after, before }: { t: Transition; after: CodeStage; before: CodeStage }) {
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h1 className="text-lg font-semibold">What changed from stage {t.from} to stage {t.to}</h1>
          <span className="text-sm text-muted-foreground tabular-nums">tickets passed {before.score.passed}/{before.score.total} → <b className="text-foreground">{after.score.passed}/{after.score.total}</b></span>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">1 · What changed in the docs</div>
            <h2 className="mt-0.5 font-medium">{t.docChanges.length} changes, {t.newDocs.length} new pages</h2>
            <div className="mt-3 flex flex-col gap-2">
              {t.docChanges.map((c) => (
                <div key={c.id} className="rounded-lg border p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", TYPE_CLASS[c.type] ?? "bg-violet-500/12 text-violet-700 dark:text-violet-300")}>{c.type}</span>
                    <span>{c.what}</span>
                  </div>
                  {c.patches.map((p, i) => (
                    <p key={i} className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      In <DocLink doc={{ path: p.doc, title: p.title }} stage={t.to} quote={p.replace.split("\n")[0]} kind="real" />: <WordDiff diff={p.diff} />
                    </p>
                  ))}
                </div>
              ))}
              {t.newDocs.length > 0 && (
                <div className="rounded-lg border p-3 text-[13px]">
                  <span className="rounded bg-blue-500/12 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">new pages</span>
                  <ul className="mt-2 flex flex-col gap-1">
                    {t.newDocs.map((d) => (
                      <li key={d.path} className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                        <DocLink doc={d} stage={t.to} kind={d.trap ? "trap" : undefined} />
                        <span className="text-muted-foreground/70">{d.status} {d.updated}</span>
                        {d.trap && <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">trap page</Badge>}
                        {d.rules.map((r) => <span key={r} className="rounded bg-muted px-1.5 font-mono text-[10.5px] text-muted-foreground">{r}</span>)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
          <section className="rounded-xl border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">2 · Rules that changed</div>
            <h2 className="mt-0.5 font-medium">{t.ruleChanges.length} rules new or changed</h2>
            <div className="mt-3 flex flex-col gap-2">
              {t.ruleChanges.map((r) => (
                <div key={r.id} className="rounded-lg border p-3 text-[13px]">
                  <div className="flex items-center gap-2"><span className="font-mono text-xs font-semibold">{r.id}</span><RuleStatusBadge status={r.status} /></div>
                  <p className="mt-1.5 leading-relaxed text-muted-foreground">{r.diff ? <WordDiff diff={r.diff} /> : r.text}</p>
                  <div className="mt-2 flex flex-col gap-1 text-[12.5px]">
                    {r.sources.map((s) => (
                      <div key={s.path} className="flex items-baseline gap-2"><span className="shrink-0 rounded bg-emerald-500/12 px-1.5 text-[10px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">Real</span><DocLink doc={s} stage={t.to} quote={r.quote} kind="real" /></div>
                    ))}
                    {r.traps.map((s) => (
                      <div key={s.path} className="flex items-baseline gap-2"><span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">Trap</span><DocLink doc={s} stage={t.to} quote={r.trapQuote} kind="trap" /></div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function DeltaView({ t, before, after, file }: { t: Transition; before: CodeStage; after: CodeStage; file?: string }) {
  const setQuery = useSetQuery();
  const [sel, setSel] = useState<string>(file ?? "@overview");
  const wide = () => window.matchMedia("(min-width: 1024px)").matches;
  const [sideBySide, setSideBySide] = useState(wide);
  // The file list opens on a wide screen; on a phone it starts folded and folds again after a pick, so the content gets the screen.
  const [filesOpen, setFilesOpen] = useState(wide);
  const pick = (p: string) => { setSel(p); setQuery("f", p); if (!wide()) setFilesOpen(false); };
  const f = t.files.find((x) => x.path === sel);

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1">
      <aside className="min-h-0 overflow-y-auto border-b p-3 max-lg:max-h-[35vh] lg:border-r lg:border-b-0">
        <button onClick={() => pick("@overview")} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors hover:bg-muted", sel === "@overview" && "bg-muted font-medium")}>
          <ListChecks className="size-4 text-muted-foreground" /> Docs, rules and builder summary
        </button>
        <button
          type="button"
          onClick={() => setFilesOpen(!filesOpen)}
          aria-expanded={filesOpen}
          className="mt-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted"
        >
          Files changed · {t.files.length}
          <ChevronDown className={cn("size-4 transition-transform", filesOpen && "rotate-180")} aria-hidden />
        </button>
        {filesOpen && ROLE_ORDER.map((role) => {
          const files = t.files.filter((x) => x.role === role);
          if (!files.length) return null;
          const Icon = ROLE_ICON[role];
          return (
            <div key={role} className="mb-1">
              <div className="px-2 pt-2 pb-0.5 text-[10.5px] text-muted-foreground/80">{ROLE_LABEL[role]}</div>
              {files.map((x) => (
                <button key={x.path} onClick={() => pick(x.path)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] transition-colors hover:bg-muted", x.path === sel && "bg-muted font-medium")}>
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{x.path}</span>
                  {x.status !== "changed" && <span className="shrink-0 rounded bg-blue-500/12 px-1 font-sans text-[9.5px] font-semibold uppercase text-blue-700 dark:text-blue-300">{x.status}</span>}
                  <span className="ml-auto shrink-0 font-mono text-[11px]"><span className="text-emerald-600">+{x.add}</span> <span className="text-red-600">−{x.rem}</span></span>
                </button>
              ))}
            </div>
          );
        })}
        {filesOpen && t.knowledge.length > 0 && (
          <>
            <div className="px-2 pt-3 pb-0.5 text-[10.5px] text-muted-foreground/80">Knowledge it carries</div>
            <button onClick={() => pick("@knowledge")} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] hover:bg-muted", sel === "@knowledge" && "bg-muted font-medium")}>
              <Library className="size-3.5 text-muted-foreground" /> knowledge.json <span className="ml-auto font-sans text-[11px] text-muted-foreground">{t.knowledge.length} docs</span>
            </button>
          </>
        )}
      </aside>

      <div className="min-h-0">
        {sel === "@overview" && <Overview t={t} before={before} after={after} />}
        {sel === "@knowledge" && (
          <div className="h-full overflow-y-auto p-4">
            <h2 className="font-medium">Docs in the agent’s knowledge that changed</h2>
            <p className="text-sm text-muted-foreground">Click one to read it as it was in stage {t.to}.</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
              {t.knowledge.map((k) => (
                <li key={k.id} className="flex items-center gap-2">
                  <span className={cn("w-16 rounded px-1.5 text-center text-[10px] font-semibold uppercase", k.status === "added" ? "bg-blue-500/12 text-blue-700 dark:text-blue-300" : k.status === "removed" ? "bg-red-500/12 text-red-700" : "bg-violet-500/12 text-violet-700 dark:text-violet-300")}>{k.status}</span>
                  <DocLink doc={{ path: k.path, title: k.title }} stage={t.to} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {f && (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
              <span className="font-mono text-[13px] font-medium">{f.path}</span>
              {f.data ? <span className="text-xs text-muted-foreground">data file</span> : <span className="font-mono text-xs"><span className="text-emerald-600">+{f.add}</span> <span className="text-red-600">−{f.rem}</span></span>}
              {f.tags.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  names changed pages for {[...new Set(f.tags.flatMap((x) => x.rules))].map((r) => <span key={r} className="ml-1 rounded bg-violet-600 px-1.5 font-mono text-[10.5px] font-semibold text-white">{r}</span>)}
                </span>
              )}
              <div className="ml-auto flex gap-1 rounded-lg bg-muted p-0.5">
                <button onClick={() => setSideBySide(true)} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs", sideBySide ? "bg-background shadow-sm" : "text-muted-foreground")}><Columns2 className="size-3.5" /> Split</button>
                <button onClick={() => setSideBySide(false)} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs", !sideBySide ? "bg-background shadow-sm" : "text-muted-foreground")}><LayoutList className="size-3.5" /> Unified</button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}><FileDiff key={f.path} f={f} sideBySide={sideBySide} /></Suspense>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
