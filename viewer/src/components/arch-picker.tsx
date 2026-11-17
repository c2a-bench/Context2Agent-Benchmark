import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import Link from "@/components/link";
import { passRate } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";
import type { JobSummary } from "@/lib/data";

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(100 * n)}%`);

/** Every stage of several runs pooled, as passRate does for one. */
export function pooledRate(runs: JobSummary[]) {
  const rs = runs.map(passRate).filter((r): r is NonNullable<typeof r> => !!r);
  const passed = rs.reduce((a, r) => a + r.passed, 0), total = rs.reduce((a, r) => a + r.total, 0);
  return total ? { rate: passed / total, passed, total } : null;
}

/** A model's run of an architectures environment is one entry: this asks which architecture's run to open. The list
 *  floats above the page (drawn in document.body, under the button), so a table that scrolls cannot cut it off. */
export function ArchPicker({ runs }: { runs: JobSummary[] }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && (button.current?.contains(e.target as Node) || list.current?.contains(e.target as Node))) return;
      setAt(null);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);
  const toggle = () => {
    if (at) return setAt(null);
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
  };
  return (
    <>
      <button ref={button} type="button" onClick={toggle} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        Choose architecture ({runs.length}) <ChevronDown className={cn("size-3.5", at && "rotate-180")} />
      </button>
      {at &&
        createPortal(
          <div ref={list} style={{ top: at.top, left: at.left }} className="fixed z-50 flex w-60 flex-col rounded-lg border bg-popover p-1 shadow-lg">
            {runs.map((r) => (
              <Link key={r.key} href={`/runs/${r.key}`} className="flex items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted">
                <span className="font-mono">{r.architecture}</span>
                <span className="tabular-nums text-muted-foreground">{pct(passRate(r)?.rate)}</span>
              </Link>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
