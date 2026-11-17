import { Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileCode2, FileJson, FileText, FlaskConical, Library } from "lucide-react";
import { CodeViewer } from "@/components/monaco";
import { DocLink } from "@/components/doc-sheet";
import { cn } from "@/lib/utils";
import { getText } from "@/lib/data";
import { useJob, useSetQuery } from "@/lib/route";
import type { CodeFile, CodeStage, Role } from "@/lib/types";

export const mb = (n: number | null | undefined) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** A file's text: inline (older runs) or fetched from the run's texts/ shards when shown. A data file is not text. */
function FileBody({ f }: { f: CodeFile }) {
  const job = useJob();
  if (f.data) {
    return <p className="p-6 text-sm text-muted-foreground">Data file ({mb(f.size)}), not shown as text: an index, vectors or another binary file the agent loads.</p>;
  }
  const text = f.text ?? use(getText(job, f.ref));
  return <CodeViewer path={f.path} text={text} />;
}

export const ROLE_LABEL: Record<Role, string> = {
  code: "Code",
  prompt: "Prompts sent to the model",
  knowledge: "Knowledge it carries",
  doc: "Notes",
  test: "Builder's own tests",
};
export const ROLE_ORDER: Role[] = ["code", "prompt", "knowledge", "doc", "test"];
export const ROLE_ICON: Record<Role, typeof FileCode2> = { code: FileCode2, prompt: FileText, knowledge: Library, doc: FileJson, test: FlaskConical };

type ListRow = { head: Role } | { file: CodeFile };

/** The stage's files, grouped by role. Only the rows in view are drawn (a bot that keeps every doc lists ~10,000
 *  files, which drawn all at once made the page slow to open and to scroll). */
function FileList({ files, selected, onPick }: { files: CodeFile[]; selected: string; onPick: (p: string) => void }) {
  const box = useRef<HTMLElement>(null);
  const rows = useMemo<ListRow[]>(
    () =>
      ROLE_ORDER.flatMap((role) => {
        const fs = files.filter((x) => x.role === role);
        return fs.length ? [{ head: role } as ListRow, ...fs.map((f) => ({ file: f }))] : [];
      }),
    [files],
  );
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => 30, overscan: 15 });
  useEffect(() => {
    const i = rows.findIndex((r) => "file" in r && r.file.path === selected);
    if (i > 0) v.scrollToIndex(i, { align: "center" });
    // only when the list opens: later picks are already in view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  return (
    <aside ref={box} className="min-h-0 overflow-y-auto border-b p-3 max-lg:max-h-[35vh] lg:border-r lg:border-b-0">
      <div className="relative w-full" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((it) => {
          const r = rows[it.index];
          return (
            <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${it.start}px)` }}>
              {"head" in r ? (
                <div className="px-2 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{ROLE_LABEL[r.head]}</div>
              ) : (
                <FileRow x={r.file} active={r.file.path === selected} onPick={onPick} />
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function FileRow({ x, active, onPick }: { x: CodeFile; active: boolean; onPick: (p: string) => void }) {
  const Icon = ROLE_ICON[x.role];
  return (
    <button onClick={() => onPick(x.path)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12.5px] transition-colors hover:bg-muted", active && "bg-muted font-medium")}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{x.path}</span>
      <span className="ml-auto shrink-0 font-sans text-[11px] text-muted-foreground">{x.data ? mb(x.size) : x.lines}</span>
    </button>
  );
}

export function StageView({ s, file }: { s: CodeStage; file?: string }) {
  const setQuery = useSetQuery();
  const [sel, setSel] = useState(file && s.files.some((f) => f.path === file) ? file : "agent.py");
  const pick = (p: string) => { setSel(p); setQuery("f", p); };
  const f = s.files.find((x) => x.path === sel) ?? s.files[0];
  if (!f) return <p className="p-6 text-sm text-muted-foreground">No code files were produced at this stage.</p>;

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-1">
      <FileList files={s.files} selected={f.path} onPick={pick} />
      <div className="flex min-h-0 flex-col gap-3 p-4">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="font-mono text-[13px] font-medium">{f.path}</span>
            <span className="text-xs text-muted-foreground">{f.path === "knowledge.json" ? `${s.knowledge.length} docs bundled into every prompt` : `${f.data ? `data file, ${mb(f.size)}` : `${f.lines} lines`} · ${ROLE_LABEL[f.role]}`}</span>
          </div>
          <div className="min-h-0 flex-1">
            {f.path === "knowledge.json" ? (
              <div className="h-full overflow-y-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr><th className="px-4 py-2 font-medium">Doc</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Updated</th><th className="px-4 py-2 text-right font-medium">Size</th></tr>
                  </thead>
                  <tbody>
                    {s.knowledge.map((k) => (
                      <tr key={k.id} className="border-t">
                        <td className="px-4 py-1.5"><DocLink doc={{ path: k.path, title: k.title }} stage={s.stage} /></td>
                        <td className="px-4 py-1.5 text-muted-foreground">{k.status}</td>
                        <td className="px-4 py-1.5 text-muted-foreground tabular-nums">{k.updated}</td>
                        <td className="px-4 py-1.5 text-right text-muted-foreground tabular-nums">{(k.chars / 1000).toFixed(1)}k</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}><FileBody key={f.path} f={f} /></Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
