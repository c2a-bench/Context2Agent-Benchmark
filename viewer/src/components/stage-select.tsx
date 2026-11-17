import { useSearchParams } from "react-router";
import { stepLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { currentSearchParams } from "@/lib/route";
import type { Meta } from "@/lib/types";

/** Value of ?stage= that means "every stage added up" (pages that support it). */
export const ALL = "all";

export const stageName = (meta: Meta, s: number) => stepLabel(meta.scores[String(s)]?.step, s, true);

/** The stage picked in ?stage=, shared by every stage-aware tab so the choice carries across them.
 *  `all` is the pooled view; it is only returned when the page allows it. */
export function useStage(meta: Meta, allowAll = false, defaultAll = false): { stage: number | typeof ALL; set: (s: number | typeof ALL) => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("stage");
  const first = meta.stages[0] ?? 0;
  const stage: number | typeof ALL =
    allowAll && (raw === ALL || (raw === null && defaultAll))
      ? ALL
      : raw !== null && meta.stages.includes(Number(raw)) ? Number(raw) : first;
  const set = (s: number | typeof ALL) => {
    const next = currentSearchParams();
    next.set("stage", String(s));
    next.delete("t");
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return { stage, set };
}

/** The stage dropdown: a sticky bar at the top of a tab that says which sections follow it. */
export function StageBar({ meta, stage, onChange, allowAll = false, className, note }: { meta: Meta; stage: number | typeof ALL; onChange: (s: number | typeof ALL) => void; allowAll?: boolean; className?: string; /** replaces the default "sections tagged…" line */ note?: React.ReactNode }) {
  return (
    <div className={cn("sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background/95 px-6 py-2.5 backdrop-blur", className)}>
      <label htmlFor="stage-select" className="font-sans text-sm font-semibold">Stage</label>
      <select
        id="stage-select"
        value={String(stage)}
        onChange={(e) => onChange(e.target.value === ALL ? ALL : Number(e.target.value))}
        className="rounded-md border bg-background px-2 py-1 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {allowAll && <option value={ALL}>All stages</option>}
        {meta.stages.map((s) => {
          const sc = meta.scores[String(s)];
          return (
            <option key={s} value={s}>
              {stageName(meta, s)}
              {sc?.total ? ` · ${sc.passed ?? 0}/${sc.total} passed` : ""}
            </option>
          );
        })}
      </select>
      <span className="font-sans text-xs text-muted-foreground">
        {note ?? (
          <>
            Sections tagged <ScopeChip>{stage === ALL ? "All stages" : stageName(meta, stage)}</ScopeChip> follow this; the others always add up every stage.
          </>
        )}
      </span>
    </div>
  );
}

/** Tag on a section header: which stage(s) its numbers are for. */
export function ScopeChip({ children, stage = false }: { children: React.ReactNode; stage?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-sans text-[10.5px] font-medium",
        stage ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
