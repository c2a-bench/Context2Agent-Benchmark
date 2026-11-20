import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Picker } from "@/components/picker";
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
/** The stage picker of a page with stages. It sits at the end of the run's tab bar (#run-bar-slot, in job-layout), so
 *  it stays in view without a band of its own; on its own (no slot) it shows in place. */
export function StageBar({ meta, stage, onChange, allowAll = false, className }: { meta: Meta; stage: number | typeof ALL; onChange: (s: number | typeof ALL) => void; allowAll?: boolean; className?: string; note?: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("run-bar-slot")), []);
  const picker = (
    <div className={cn("flex items-center gap-2 py-1.5 font-sans text-xs", !slot && className)}>
      <span className="text-muted-foreground">Stage</span>
      <Picker
        id="stage-select"
        label="Stage"
        value={String(stage)}
        onPick={(v) => onChange(v === ALL ? ALL : Number(v))}
        options={[
          ...(allowAll ? [{ value: ALL, text: "All stages" }] : []),
          ...meta.stages.map((s) => {
            const sc = meta.scores[String(s)];
            return { value: String(s), text: stageName(meta, s), meta: sc?.total ? `${sc.passed ?? 0}/${sc.total} passed` : undefined };
          }),
        ]}
      />
    </div>
  );
  return slot ? createPortal(picker, slot) : picker;
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
