import { useLayoutEffect, useRef, useState } from "react";
import { CONFOUND, type Shape } from "./data";

// ---------------- shared ----------------

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Mark({ shape, x, y, r = 5, color }: { shape: Shape; x: number; y: number; r?: number; color: string }) {
  const s = { fill: color, stroke: "var(--bg)", strokeWidth: 1.2 } as const;
  switch (shape) {
    case "square":
      return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} {...s} />;
    case "triangle":
      return <path d={`M${x},${y - r * 1.15} L${x + r * 1.1},${y + r * 0.85} L${x - r * 1.1},${y + r * 0.85} Z`} {...s} />;
    case "diamond":
      return <path d={`M${x},${y - r * 1.25} L${x + r * 1.15},${y} L${x},${y + r * 1.25} L${x - r * 1.15},${y} Z`} {...s} />;
    case "plus":
      return <path d={`M${x - r},${y} H${x + r} M${x},${y - r} V${y + r}`} stroke={color} strokeWidth={r * 0.75} fill="none" />;
    case "cross":
      return <path d={`M${x - r * 0.8},${y - r * 0.8} L${x + r * 0.8},${y + r * 0.8} M${x + r * 0.8},${y - r * 0.8} L${x - r * 0.8},${y + r * 0.8}`} stroke={color} strokeWidth={r * 0.7} fill="none" />;
    default:
      return <circle cx={x} cy={y} r={r} {...s} />;
  }
}

function MarkIcon({ shape, color, size = 14 }: { shape: Shape; color: string; size?: number }) {
  return (
    <svg width={size} height={size} className="shrink-0" aria-hidden>
      <Mark shape={shape} x={size / 2} y={size / 2} r={size * 0.34} color={color} />
    </svg>
  );
}

const pct = (x: number) => `${Math.round(100 * x)}%`;
const star = (m: string) => (m === CONFOUND ? `${m} *` : m);


export function BuilderLegend({ items }: { items: { model: string; color: string; shape: Shape }[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
      {items.map((b) => (
        <li key={b.model} className="flex items-center gap-1.5 text-[13px]">
          <MarkIcon shape={b.shape} color={b.color} />
          {star(b.model)}
        </li>
      ))}
    </ul>
  );
}

// ---------------- plot 1: pass rate per stage ----------------

export type StagePoint = { passed: number; total: number; crashed: boolean; types: [string, string, number, number][] };
/** One architecture behind a pooled line. Drawn, in a lighter shade, while that line is hovered. */
export type StagePart = { name: string; stages: { passed: number; total: number; crashed: boolean }[] };
/** `band`, when set, is the lowest-to-highest architecture at each stage (Skyway). `parts` are those architectures. */
export type StageRow = { model: string; harness: string; color: string; shape: Shape; rate: number; passed: number; total: number; stages: StagePoint[]; band?: { lo: number; hi: number; loName: string; hiName: string }[]; parts?: StagePart[] };

// ---------------- plot 2: where failed checks come from ----------------

/** One builder's failed tickets, split by group as on the run viewer's Failure analysis page: a failed ticket counts once,
 *  split evenly between the parties blamed for it, then between that party's groups. Keys are "Builder|group", "Agent|group". */
export type FailureRow = { model: string; harness: string; failed: number; total: number; rate: number; groups: Map<string, number>; crashedStages: number };

export type RecallPoint = { model: string; color: string; shape: Shape; stage: number; recall: number; pass: number };

// ---------------- plot 3: architecture ----------------

export type TicketType = "discovery" | "regression" | "adaptability";
/** One builder's run of one prescribed architecture, summed over its stages. */
export type ArchRun = {
  arch: string;
  name: string;
  model: string;
  harness: string;
  color: string;
  shape: Shape;
  passed: number;
  total: number;
  stages: number[];
  usd: number;
  time: number;
  tok: number;
  types: Partial<Record<TicketType, [number, number]>>;
};

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

const TYPES: [TicketType, string][] = [
  ["discovery", "New rule"],
  ["regression", "Rule that didn't change"],
  ["adaptability", "Rule that changed"],
];

/** Pass rate per ticket type and architecture (rows in the shared order), averaged over builders. */
export function ArchTypes({ runs, order }: { runs: ArchRun[]; order: string[] }) {
  const cells = order.map((arch) => {
    const rs = runs.filter((r) => r.arch === arch);
    return { arch, name: rs[0]?.name ?? arch, v: TYPES.map(([t]) => { const c = rs.flatMap((r) => (r.types[t] ? [r.types[t]!] : [])); return c.length ? { rate: avg(c.map(([p, n]) => p / n)), n: c.reduce((a, [, n]) => a + n, 0) } : null; }) };
  });
  const all = cells.flatMap((c) => c.v.flatMap((v) => (v ? [v.rate] : [])));
  const [lo, hi] = [Math.min(...all), Math.max(...all)];
  const shade = (v: number) => 12 + (78 * (v - lo)) / Math.max(0.01, hi - lo);
  return (
    <div>
      <div className="label muted mb-3">Tickets passed, by what the ticket tests</div>
      <table className="w-full border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th />
            {TYPES.map(([t, plain]) => (
              <th key={t} className="pb-1 text-left align-bottom text-[13px] font-medium">{plain}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.arch}>
              <td className="pr-2 text-[13px] leading-tight">{c.name}</td>
              {c.v.map((v, i) => (
                <td key={i} className="num h-9 rounded-[3px] px-2 text-[13px]" title={v ? `${c.name}, ${TYPES[i][1]}: ${pct(v.rate)} of ${v.n} tickets` : ""}
                  style={v ? { background: `color-mix(in oklab, var(--heat) ${shade(v.rate)}%, var(--bg))`, color: shade(v.rate) > 55 ? "#fff" : "var(--ink)" } : undefined}>
                  {v ? pct(v.rate) : "–"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="label muted mt-2">A stronger blue means more tickets passed.</p>
    </div>
  );
}

// ---------------- plot 4: doc perturbations ----------------

export type PackBuilder = { model: string; color: string; shape: Shape; pass: (number | null)[] };

