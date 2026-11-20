import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link as RouterLink } from "react-router";
import { cn } from "@/lib/utils";
import { ScopeChip } from "@/components/stage-select";

// Small HTML charts for the research pages. Marks carry colour; text keeps the theme's ink.
// Every chart sits in a ChartCard, whose table view holds every number the chart shows.

export const VIZ = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"] as const;

type Tip = { x: number; y: number; body: ReactNode } | null;

// Outside a ChartCard, tooltips go to one page-wide layer (TipRoot, mounted once in main.tsx).
let setPageTip: ((t: Tip) => void) | null = null;
export function TipRoot() {
  const [tip, setTip] = useState<Tip>(null);
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Below and right of the pointer when it fits; else above and/or left of it, so it is never cut off by the window.
  useLayoutEffect(() => {
    if (!tip || !el.current) return setPos(null);
    const h = el.current.offsetHeight, w = el.current.offsetWidth;
    const top = tip.y + 14 + h <= window.innerHeight - 8 ? tip.y + 14 : Math.max(8, tip.y - 10 - h);
    const left = tip.x + 12 + w <= window.innerWidth - 8 ? tip.x + 12 : Math.max(8, tip.x - 12 - w);
    setPos({ left, top });
  }, [tip]);
  useEffect(() => {
    setPageTip = setTip;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => {
      setPageTip = null;
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-80 min-w-40 rounded-md border bg-popover px-3 py-2 font-sans text-xs font-normal normal-case tracking-normal text-popover-foreground shadow-md"
      ref={el}
      style={{ left: pos?.left ?? tip.x + 12, top: pos?.top ?? tip.y + 14, visibility: pos == null ? "hidden" : "visible" }}
    >
      {tip.body}
    </div>,
    document.body,
  );
}

const TipCtx = createContext<{ show: (el: HTMLElement, body: ReactNode, e?: { clientX: number; clientY: number }) => void; hide: () => void }>({
  show: (el, body, e) => {
    const r = el.getBoundingClientRect();
    setPageTip?.({ x: e ? e.clientX : r.left, y: e ? e.clientY : r.bottom, body });
  },
  hide: () => setPageTip?.(null),
});

/** Hover/focus props for one mark: the tooltip follows the pointer, or sits under the mark on keyboard focus. */
function useTip(body: ReactNode) {
  const { show, hide } = useContext(TipCtx);
  return {
    tabIndex: 0,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => show(e.currentTarget, body, e),
    onPointerLeave: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, body),
    onBlur: hide,
  };
}

/** A tooltip row: value first and strong, the name after it, keyed by a short stroke of the series colour. */
export function TipRow({ color, value, label }: { color?: string; value: ReactNode; label: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {color && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="font-semibold whitespace-nowrap tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

export function ChartCard({
  title,
  subtitle,
  table,
  how,
  scope,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  table?: ReactNode;
  /** Which stage(s) the numbers are for. A stage-scoped card (stage: true) is marked and follows the stage dropdown. */
  scope?: { label: string; stage?: boolean };
  /** How the chart's numbers are calculated; shown on hover next to the title. */
  how?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={cn("mt-20", scope?.stage && "-ml-4 border-l-2 border-foreground/30 pl-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-sans text-[15px] font-semibold tracking-tight">
          {title}
          {scope && <span className="ml-2 align-[1px]"><ScopeChip stage={scope.stage}>{scope.label}</ScopeChip></span>}
        </h2>
        <div className="flex shrink-0 items-baseline gap-3">
        {how && (
          <How how={how} className="font-sans text-[11px] text-muted-foreground">
            how it&apos;s calculated
          </How>
        )}
        {table && (
          <button
            type="button"
            onClick={() => setAsTable(!asTable)}
            className="shrink-0 rounded-md border px-2 py-0.5 font-sans text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {asTable ? "Show chart" : "Show table"}
          </button>
        )}
        </div>
      </div>
      {subtitle && <p className="mt-2 max-w-3xl font-sans text-xs leading-relaxed text-muted-foreground">{subtitle}</p>}
      <div className="relative mt-6">{asTable && table ? table : children}</div>
    </section>
  );
}

/** A value with a dotted underline that shows how it is calculated, with the run's own numbers. */
/** A note at the top of a chart that takes an old one's place on a run graded by facts: the old chart no longer
 *  applies, and why. */
export function NoLongerApplicable({ what, why }: { what: string; why: string }) {
  return (
    <div className="mb-4 rounded-md border border-dashed px-3 py-2 font-sans text-xs text-muted-foreground">
      <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{what}: no longer applicable</span>
      {why}
    </div>
  );
}

export function How({ how, children, className }: { how?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Defined def={how} heading="How it's calculated" className={className}>
      {children}
    </Defined>
  );
}

export type Segment = {
  key: string;
  label: string;
  value: number;
  color: string;
  tip?: ReactNode;
  /** What the category means, in plain words; shown when its legend entry is hovered. */
  def?: string;
};

/** A term with a dotted underline that shows its definition on hover or focus (inside a ChartCard). */
export function Defined({ def, children, className, heading }: { def?: ReactNode; children: ReactNode; className?: string; heading?: ReactNode }) {
  const props = useTip(
    <div className="max-w-80 leading-relaxed">
      <div className="mb-1 font-medium">{heading ?? children}</div>
      <div className="text-muted-foreground">{def}</div>
    </div>,
  );
  if (!def) return <span className={className}>{children}</span>;
  // Inside a row with its own tooltip: the definition wins while the term is hovered.
  const stop = <E extends { stopPropagation: () => void }>(f: (e: E) => void) => (e: E) => {
    e.stopPropagation();
    f(e);
  };
  return (
    <span
      tabIndex={0}
      onPointerMove={stop(props.onPointerMove)}
      onFocus={stop(props.onFocus)}
      onPointerLeave={props.onPointerLeave}
      onBlur={props.onBlur}
      className={cn("cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none", className)}>
      {children}
    </span>
  );
}

/** Legend for two or more series: a swatch shaped like the mark, then the name and its number. */
export function Legend({ items, total, shape = "box", counts = true }: { items: Segment[]; total?: number; shape?: "box" | "line"; counts?: boolean }) {
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 font-sans text-xs">
      {items.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className={shape === "line" ? "h-0.5 w-3.5 rounded-full" : "size-2.5 rounded-[3px]"} style={{ background: s.color }} />
          <Defined def={s.def}>{s.label}</Defined>
          {shape === "box" && counts && (
            <span className="tabular-nums text-muted-foreground">
              {s.value}
              {total ? ` · ${Math.round((100 * s.value) / total)}%` : ""}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function SegmentMark({ s, total, first, last }: { s: Segment; total: number; first: boolean; last: boolean }) {
  const tip = useTip(
    s.tip ?? <TipRow color={s.color} value={`${s.value} · ${Math.round((100 * s.value) / total)}%`} label={s.label} />,
  );
  return (
    <div
      {...tip}
      className={cn("h-full outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring", first && "rounded-l", last && "rounded-r")}
      style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
      aria-label={`${s.label}: ${s.value}`}
    />
  );
}

/** One 100% bar: the parts of a whole, split by a 2px surface gap. Zero parts are left out of the bar, kept in the legend. */
export function PartsBar({ label, segments, legend = true }: { label?: ReactNode; segments: Segment[]; legend?: boolean }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div>
      {label && <div className="mb-1 font-sans text-xs text-muted-foreground">{label}</div>}
      {total ? (
        <div className="flex h-5 gap-[2px]">
          {shown.map((s, i) => (
            <SegmentMark key={s.key} s={s} total={total} first={i === 0} last={i === shown.length - 1} />
          ))}
        </div>
      ) : (
        <div className="flex h-5 items-center rounded bg-muted px-2 font-sans text-[11px] text-muted-foreground">none</div>
      )}
      {legend && <Legend items={segments} total={total} />}
    </div>
  );
}

export type BarRow = { key: string; label: ReactNode; parts: Segment[]; value: ReactNode; tip?: ReactNode; group?: string; groupDef?: string; labelDef?: string };

function BarListRow({ r, max, grouped, showGroup, divider, labelWidth }: { r: BarRow; max: number; grouped: boolean; showGroup: boolean; divider: boolean; labelWidth: string }) {
  const sum = r.parts.reduce((a, p) => a + p.value, 0);
  const shown = r.parts.filter((p) => p.value > 0);
  const tip = useTip(
    r.tip ?? (
      <>
        <div className="mb-1 font-medium">{r.label}</div>
        {r.parts.map((p) => (
          <TipRow key={p.key} color={p.color} value={p.value} label={p.label} />
        ))}
      </>
    ),
  );
  return (
    <div
      {...tip}
      className={cn(
        "group grid items-center gap-3 rounded py-1.5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        grouped && "grid-cols-[minmax(0,14rem)_minmax(0,15rem)_minmax(0,1fr)_auto]",
        divider && "mt-1 rounded-none border-t border-border/60 pt-2",
      )}
      style={grouped ? undefined : { gridTemplateColumns: `minmax(0, ${labelWidth}) minmax(0, 1fr) auto` }}
    >
      {grouped && <div className="truncate font-sans text-xs text-muted-foreground">{showGroup ? <Defined def={r.groupDef}>{r.group}</Defined> : ""}</div>}
      <div className="truncate font-sans text-xs" title={typeof r.label === "string" ? r.label : undefined}>
        <Defined def={r.labelDef}>{r.label}</Defined>
      </div>
      <div className="flex h-3.5 gap-[2px]" style={{ width: max ? `${(100 * sum) / max}%` : 0 }}>
        {shown.map((p, i) => (
          <div
            key={p.key}
            className={cn("h-full", i === shown.length - 1 && "rounded-r")}
            style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
          />
        ))}
      </div>
      <div className="text-right font-sans text-xs tabular-nums text-muted-foreground">{r.value}</div>
    </div>
  );
}

/** Horizontal bars from one baseline, one row per item; a row may stack parts. Value at the bar's tip column. */
export function BarList({ rows, limit }: { rows: BarRow[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const max = Math.max(0, ...rows.map((r) => r.parts.reduce((a, p) => a + p.value, 0)));
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  const grouped = rows.some((r) => r.group);
  // The label column fits the longest label (at most 20rem), so short labels like "stage 0" don't leave a wide gap.
  // Every row uses the same width, so the bars still start in one line.
  const labelWidth = rows.every((r) => typeof r.label === "string")
    ? `min(20rem, ${Math.max(...rows.map((r) => (r.label as string).length)) + 2}ch)`
    : "20rem";
  return (
    <div>
      {shown.map((r, i) => {
        const newGroup = i === 0 || shown[i - 1].group !== r.group;
        return <BarListRow key={r.key} r={r} max={max} grouped={grouped} showGroup={grouped && newGroup} divider={grouped && newGroup && i > 0} labelWidth={labelWidth} />;
      })}
      {limit && rows.length > limit && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-1 font-sans text-[11px] text-muted-foreground hover:text-foreground"
        >
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

/** A single ratio against its whole: fill and track are two steps of one colour. */
export function Meter({ label, value, display, color = VIZ[1], tip, def, how }: { label: string; value: number | null; display: string; color?: string; tip?: ReactNode; def?: ReactNode; how?: ReactNode }) {
  const props = useTip(
    tip ??
      (def || how ? (
        <div className="max-w-80 leading-relaxed">
          <div className="mb-1 font-medium">{label}</div>
          {def && <div className="text-muted-foreground">{def}</div>}
          {how && (
            <div className={cn("text-muted-foreground", def && "mt-2 border-t pt-2")}>
              <span className="font-medium text-foreground">How it&apos;s calculated: </span>
              {how}
            </div>
          )}
        </div>
      ) : (
        <TipRow color={color} value={display} label={label} />
      )),
  );
  return (
    <div {...props} className="rounded-lg border px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="font-sans text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight">{display}</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: `color-mix(in oklab, ${color} 18%, transparent)` }}>
        {value != null && value > 0 && <div className="h-full rounded-full" style={{ width: `${Math.min(100, 100 * value)}%`, background: color }} />}
      </div>
    </div>
  );
}

export type RateRow = { key: string; group?: string; label: ReactNode; passed: number; total: number; tip?: ReactNode; groupLabel?: ReactNode };

const RATE_TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Hairline ticks and the reference line, drawn in every row so they read as one continuous grid. */
function RateGrid({ reference }: { reference?: number }) {
  return (
    <>
      {RATE_TICKS.map((t) => (
        <div key={t} className="absolute inset-y-0 w-px bg-border" style={{ left: `${100 * t}%` }} />
      ))}
      {reference != null && <div className="absolute inset-y-0 z-20 w-px bg-foreground/60" style={{ left: `${100 * reference}%` }} />}
    </>
  );
}

function RateBarRow({ r, color, grouped, showGroup, divider, reference }: { r: RateRow; color: string; grouped: boolean; showGroup: boolean; divider: boolean; reference?: number }) {
  const rate = r.total ? r.passed / r.total : 0;
  const tip = useTip(r.tip ?? <TipRow color={color} value={`${rate.toFixed(2)} (${r.passed}/${r.total})`} label={r.label} />);
  const cell = cn("py-1", divider && "border-t border-border/60");
  return (
    <div {...tip} className="group/row contents outline-none">
      {grouped && <div className={cn(cell, "truncate pr-2 font-sans text-xs text-muted-foreground")}>{showGroup ? (r.groupLabel ?? r.group) : ""}</div>}
      <div className={cn(cell, "truncate pr-3 font-sans text-xs group-hover/row:font-medium")}>{r.label}</div>
      <div className={cn(cell, "relative flex items-center")}>
        <RateGrid reference={reference} />
        <div className="relative z-10 h-3.5 rounded-r group-hover/row:brightness-110" style={{ width: `${100 * rate}%`, minWidth: rate > 0 ? 2 : 0, background: color }} />
      </div>
      <div className={cn(cell, "pl-3 font-sans text-xs tabular-nums text-muted-foreground")}>
        {rate.toFixed(2)} ({r.passed}/{r.total})
      </div>
    </div>
  );
}

/** Pass rates on a fixed 0–1 scale, one bar per row, rows grouped under a label; an optional reference line (e.g. baseline). */
export function RateBars({ rows, color = VIZ[1], reference }: { rows: RateRow[]; color?: string; reference?: { value: number; label: string } }) {
  const grouped = rows.some((r) => r.group);
  const pad = grouped ? [0, 1] : [0];
  return (
    <div className={cn("grid", grouped ? "grid-cols-[minmax(0,11rem)_minmax(0,10rem)_minmax(0,1fr)_7.5rem]" : "grid-cols-[minmax(0,16rem)_minmax(0,1fr)_7.5rem]")}>
      {pad.map((k) => <div key={k} />)}
      <div className="relative h-4">
        {reference && (
          <span className="absolute bottom-0.5 -translate-x-1/2 whitespace-nowrap font-sans text-[10px] text-muted-foreground" style={{ left: `${100 * reference.value}%` }}>
            {reference.label}
          </span>
        )}
      </div>
      <div />
      {rows.map((r, i) => {
        const first = i === 0 || rows[i - 1].group !== r.group;
        return <RateBarRow key={r.key} r={r} color={color} grouped={grouped} showGroup={first} divider={grouped && first && i > 0} reference={reference?.value} />;
      })}
      {pad.map((k) => <div key={k} />)}
      <div className="relative h-5">
        {RATE_TICKS.map((t) => (
          <span key={t} className="absolute top-1 -translate-x-1/2 font-sans text-[10px] tabular-nums text-muted-foreground" style={{ left: `${100 * t}%` }}>
            {t}
          </span>
        ))}
      </div>
      <div />
    </div>
  );
}

/** `denominator`: the stage's own ticket count. When set, a column's height is its parts ÷ denominator on the axis
 *  (a taller bar = a bigger share of the stage), not 100% for every stage. */
export type StageColumn = { key: string; label: string; /** omit for a plain, non-clickable label */ href?: string; selected?: boolean; top: string; /** a second, bolder header line, e.g. the pass rate */ sub?: string; segments: Segment[]; denominator?: number };

const COLUMN_H = 200;

function ColumnSegment({ s, total, ink, count, height, onPick, picked }: { s: Segment; total: number; ink: boolean; count?: boolean; height: number; onPick?: (key: string) => void; picked?: boolean }) {
  const pctOf = total ? (100 * s.value) / total : 0;
  const tip = useTip(s.tip ?? <TipRow color={s.color} value={`${Number.isInteger(s.value) ? s.value : s.value.toFixed(1)} · ${Math.round(pctOf)}%`} label={s.label} />);
  const fits = (height * s.value) / (total || 1) >= 18;
  return (
    <div
      {...tip}
      onClick={onPick ? () => onPick(s.key) : undefined}
      className={cn("flex items-center justify-center outline-none first:rounded-b-none last:rounded-t hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring", onPick && "cursor-pointer", picked && "ring-2 ring-foreground ring-inset")}
      style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
    >
      {fits && <span className={cn("font-sans text-[10.5px] font-medium tabular-nums", ink ? "text-foreground" : "text-white")}>{count ? (Number.isInteger(s.value) ? s.value : s.value.toFixed(1)) : Math.round(pctOf)}</span>}
    </div>
  );
}

/** 100% stacked columns, one per stage, first segment at the bottom; a column is a link (picks the stage). */
export function StageColumns({ columns, inkFirst = true, yMax = 1, onPick, picked }: { columns: StageColumn[]; inkFirst?: boolean; yMax?: number; /** Click a segment (by its key) to pick it; `picked` is the one picked. */ onPick?: (key: string) => void; picked?: string }) {
  // Top of the axis as a share of each stage's tickets (columns with a denominator); 100% for plain 100% columns.
  const ticks = [0, 25, 50, 75, 100];
  const head = columns.some((c) => c.sub) ? 36 : 20;
  const label = (t: number) => { const v = t * yMax; return `${Number.isInteger(v) ? v : v.toFixed(1)}%`; };
  return (
    <div className="flex gap-2">
      <div className="relative w-8 shrink-0" style={{ height: COLUMN_H, marginTop: head }}>
        {ticks.map((t) => (
          <span key={t} className="absolute right-1 -translate-y-1/2 font-sans text-[10px] tabular-nums text-muted-foreground" style={{ top: `${100 - t}%` }}>
            {label(t)}
          </span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0" style={{ top: head, height: COLUMN_H }}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px bg-border" style={{ top: `${100 - t}%` }} />
          ))}
        </div>
        <div className="relative flex justify-around gap-1 sm:gap-3">
          {columns.map((c) => {
            const total = c.segments.reduce((a, s) => a + s.value, 0);
            const shown = c.segments.filter((s) => s.value > 0);
            const stack = c.denominator ? Math.max(2, (COLUMN_H * (total / c.denominator)) / yMax) : COLUMN_H;
            return (
              <div key={c.key} className="flex w-full min-w-0 max-w-20 flex-col items-center">
                <div className="flex flex-col justify-end whitespace-nowrap text-center font-sans text-[10.5px] tabular-nums text-muted-foreground" style={{ height: head }}>
                  {/* a phone shows only the first word ("61%"): the full lines would run into the next column */}
                  {c.sub && (
                    <span className="text-[11px] font-medium text-foreground">
                      {c.sub.split(" ")[0]}<span className="max-sm:hidden"> {c.sub.split(" ").slice(1).join(" ")}</span>
                    </span>
                  )}
                  <span className="max-sm:hidden">{c.top}</span>
                </div>
                <div className="flex w-full items-end" style={{ height: COLUMN_H }}>
                  <div className="flex w-full flex-col-reverse gap-[2px]" style={{ height: stack }}>
                    {shown.map((s, i) => (
                      <ColumnSegment key={s.key} s={s} total={total} count={!!c.denominator} height={stack} onPick={onPick} picked={picked === s.key} ink={inkFirst && i === 0 && s.key === c.segments[0].key} />
                    ))}
                  </div>
                </div>
                {c.href ? (
                  <RouterLink
                    to={c.href}
                    preventScrollReset
                    className={cn(
                      "mt-1.5 rounded px-2 py-0.5 font-sans text-xs",
                      c.selected ? "bg-foreground text-background" : "link-text",
                    )}
                  >
                    {c.label}
                  </RouterLink>
                ) : (
                  <span className="mt-1.5 px-2 py-0.5 font-sans text-xs">{c.label}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export type LinePoint = { value: number | null; note?: string };
export type LineSeries = { key: string; label: string; color: string; points: LinePoint[] };

/** Lines across ordered steps on one y-axis (0–1 by default). Hovering anywhere snaps a crosshair to the nearest step and lists
 *  every series there (lines often end together, so identity comes from the legend and tooltip, not end labels).
 *  Missing points (null) break the line: a series can start at a later step. */
export function LineChart({
  xLabels,
  series,
  height = 260,
  yMax = 1,
  ticks = [0, 0.25, 0.5, 0.75, 1],
  format = (v: number) => v.toFixed(2),
}: {
  xLabels: string[];
  series: LineSeries[];
  height?: number;
  /** Top of the y-axis; 1 for rates. */
  yMax?: number;
  ticks?: number[];
  format?: (v: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const L = 36, R = 28, T = 10, B = 26;
  const pw = Math.max(10, w - L - R), ph = height - T - B;
  const X = (i: number) => L + (xLabels.length > 1 ? (pw * i) / (xLabels.length - 1) : pw / 2);
  const Y = (v: number) => T + ph * (1 - v / yMax);
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = 0;
    xLabels.forEach((_, i) => {
      if (Math.abs(X(i) - x) < Math.abs(X(best) - x)) best = i;
    });
    setHover(best);
  };
  return (
    <div ref={box} className="relative">
      <svg width={w} height={height} className="block overflow-visible" onPointerMove={move} onPointerLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + pw} y1={Y(t)} y2={Y(t)} className="stroke-border" strokeWidth={1} />
            <text x={L - 6} y={Y(t) + 3.5} textAnchor="end" className="fill-muted-foreground font-sans text-[10px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {xLabels.map((x, i) => (
          <text key={x} x={X(i)} y={height - 8} textAnchor="middle" className={cn("font-sans text-[11px]", hover === i ? "fill-foreground" : "fill-muted-foreground")}>
            {x}
          </text>
        ))}
        {hover != null && <line x1={X(hover)} x2={X(hover)} y1={T} y2={T + ph} className="stroke-foreground/40" strokeWidth={1} />}
        {series.map((s) => {
          const pts = s.points.map((p, i) => (p.value == null ? null : [X(i), Y(p.value)] as const));
          // Break the path at missing points.
          let d = "", pen = false;
          for (const p of pts) {
            if (!p) { pen = false; continue; }
            d += `${pen ? "L" : "M"}${p[0]},${p[1]}`;
            pen = true;
          }
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} fill={s.color} className="stroke-background" strokeWidth={2} />)}
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 min-w-44 rounded-md border bg-popover px-3 py-2 font-sans text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(X(hover) + 12, w - 230), top: 8 }}
        >
          <div className="mb-1 font-medium">{xLabels[hover]}</div>
          {series.map((s) => {
            const p = s.points[hover];
            return <TipRow key={s.key} color={s.color} value={p?.value == null ? "—" : format(p.value)} label={`${s.label}${p?.note ? ` (${p.note})` : ""}`} />;
          })}
        </div>
      )}
    </div>
  );
}

export type DeltaRow = { key: string; label: string; value: number; tip?: ReactNode };

function DeltaDot({ r, x, color }: { r: DeltaRow; x: (v: number) => number; color: string }) {
  const tip = useTip(r.tip ?? <TipRow color={color} value={`${r.value > 0 ? "+" : ""}${r.value.toFixed(2)}`} label={r.label} />);
  const z = x(0), at = x(r.value);
  return (
    <div {...tip} className="contents outline-none">
      <div className="py-2 pr-3 text-right font-sans text-xs">{r.label}</div>
      <div className="relative py-2">
        <div className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${z}%` }} />
        <div className="relative h-4">
          <div className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ left: `${Math.min(z, at)}%`, width: `${Math.abs(at - z)}%`, background: color }} />
          <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background" style={{ left: `${at}%`, background: color }} />
        </div>
      </div>
      <div className="py-2 pl-3 font-sans text-xs tabular-nums text-muted-foreground">{`${r.value > 0 ? "+" : ""}${r.value.toFixed(2)}`}</div>
    </div>
  );
}

/** Dot plot around zero (lollipops from 0): right of zero = worse than the reference, left = better. */
export function DeltaDots({ rows, color = VIZ[0], left = "better", right = "worse" }: { rows: DeltaRow[]; color?: string; left?: string; right?: string }) {
  const span = Math.max(0.2, ...rows.map((r) => Math.abs(r.value)));
  const lim = Math.ceil(span * 10) / 10;
  const x = (v: number) => (100 * (v + lim)) / (2 * lim);
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim];
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_4rem]">
      {rows.map((r) => (
        <DeltaDot key={r.key} r={r} x={x} color={color} />
      ))}
      <div />
      <div className="relative h-8">
        {ticks.map((t) => (
          <span key={t} className="absolute top-1 -translate-x-1/2 font-sans text-[10px] tabular-nums text-muted-foreground" style={{ left: `${x(t)}%` }}>
            {t > 0 ? "+" : ""}{t.toFixed(2)}
          </span>
        ))}
        <span className="absolute bottom-0 left-0 font-sans text-[10px] text-muted-foreground">← {left}</span>
        <span className="absolute right-0 bottom-0 font-sans text-[10px] text-muted-foreground">{right} →</span>
      </div>
      <div />
    </div>
  );
}

/** Grouped columns per step (rates on 0–1) with one line on the same axis, e.g. the overall pass rate. Hovering a
 *  step lists every bar and the line there. Missing values draw nothing. */
export function GroupedBarsLine({
  xLabels,
  bars,
  line,
  height = 280,
  yMax = 1,
  ticks = [0, 0.25, 0.5, 0.75, 1],
  format = (v: number) => v.toFixed(2),
  callout,
  axisFormat,
  showValues = false,
}: {
  xLabels: string[];
  bars: LineSeries[];
  line?: LineSeries;
  height?: number;
  /** Top of the y-axis; 1 for rates. */
  yMax?: number;
  ticks?: number[];
  format?: (v: number) => string;
  /** A label pinned to one point of the line, e.g. the first build. */
  callout?: { index: number; label: string };
  /** How the y-axis ticks read, e.g. as percentages. */
  axisFormat?: (v: number) => string;
  /** Print each bar's value above it (through `format`). */
  showValues?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const L = 36, R = 12, T = 10, B = 26;
  const pw = Math.max(10, w - L - R), ph = height - T - B;
  const band = pw / Math.max(1, xLabels.length);
  const gap = 2;
  const bw = Math.min(24, (band * 0.7 - gap * (bars.length - 1)) / Math.max(1, bars.length));
  const groupW = bars.length * bw + (bars.length - 1) * gap;
  const cx = (i: number) => L + band * i + band / 2;
  const Y = (v: number) => T + ph * (1 - v / yMax);
  const linePts = line?.points.map((p, i) => (p.value == null ? null : ([cx(i), Y(p.value)] as const))) ?? [];
  let d = "", pen = false;
  for (const p of linePts) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p[0]},${p[1]}`;
    pen = true;
  }
  return (
    <div ref={box} className="relative">
      <svg
        width={w}
        height={height}
        className="block overflow-visible"
        role="img"
        onPointerMove={(e) => {
          const x = e.clientX - e.currentTarget.getBoundingClientRect().left - L;
          setHover(Math.max(0, Math.min(xLabels.length - 1, Math.floor(x / band))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + pw} y1={Y(t)} y2={Y(t)} className="stroke-border" strokeWidth={1} />
            <text x={L - 6} y={Y(t) + 3.5} textAnchor="end" className="fill-muted-foreground font-sans text-[10px] tabular-nums">
              {axisFormat ? axisFormat(t) : t}
            </text>
          </g>
        ))}
        {hover != null && <rect x={L + band * hover} y={T} width={band} height={ph} className="fill-muted/60" />}
        {xLabels.map((x, i) => (
          <g key={x}>
            {bars.map((s, k) => {
              const v = s.points[i]?.value;
              if (v == null) return null;
              const x0 = cx(i) - groupW / 2 + k * (bw + gap);
              const h = Math.max(2, (ph * v) / yMax); // a 0% bar still shows, as a stub, so it does not read as "no tickets"
              const r = Math.min(4, bw / 2, h);
              // Rounded data end (top), square at the baseline.
              const y = T + ph - h;
              return (
                <g key={s.key}>
                  <path
                    d={`M${x0},${T + ph}V${y + r}Q${x0},${y} ${x0 + r},${y}H${x0 + bw - r}Q${x0 + bw},${y} ${x0 + bw},${y + r}V${T + ph}Z`}
                    fill={s.color}
                  />
                </g>
              );
            })}
            <text x={cx(i)} y={height - 8} textAnchor="middle" className={cn("font-sans text-[11px]", hover === i ? "fill-foreground" : "fill-muted-foreground")}>
              {x}
            </text>
          </g>
        ))}
        {line && (
          <g>
            <path d={d} fill="none" stroke={line.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {linePts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r={hover === i || callout?.index === i ? 5 : 4} fill={line.color} className="stroke-background" strokeWidth={2} />)}
            {callout && linePts[callout.index] && (
              <text x={linePts[callout.index]![0] + 10} y={linePts[callout.index]![1] - 8} className="fill-foreground font-sans text-[11px] font-medium">
                {callout.label}
              </text>
            )}
          </g>
        )}
        {showValues &&
          xLabels.map((x, i) =>
            bars.map((s, k) => {
              const v = s.points[i]?.value;
              if (v == null) return null;
              const x0 = cx(i) - groupW / 2 + k * (bw + gap);
              const y = T + ph - Math.max(2, (ph * v) / yMax);
              return (
                <text key={`${x}:${s.key}`} x={x0 + bw / 2} y={y - 4} textAnchor="middle" strokeWidth={3} style={{ paintOrder: "stroke" }} className="fill-foreground stroke-background font-sans text-[9.5px] tabular-nums">
                  {format(v)}
                </text>
              );
            }),
          )}
      </svg>
      {hover != null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 min-w-48 rounded-md border bg-popover px-3 py-2 font-sans text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(cx(hover) + band / 2 + 8, w - 240), top: 8 }}
        >
          <div className="mb-1 font-medium">{xLabels[hover]}</div>
          {[...(line ? [line] : []), ...bars].map((s) => {
            const p = s.points[hover];
            return <TipRow key={s.key} color={s.color} value={p?.value == null ? "—" : format(p.value)} label={`${s.label}${p?.note ? ` (${p.note})` : ""}`} />;
          })}
        </div>
      )}
    </div>
  );
}
