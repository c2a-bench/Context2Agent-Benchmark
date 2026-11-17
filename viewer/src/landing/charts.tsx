import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { groupDef } from "@/lib/failure-types";
import { archName, CONDITIONS, CONFOUND, GROUPS, type FailureGroup, type Shape } from "./data";

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

type TipState = { x: number; y: number; body: ReactNode } | null;

/** A chart frame that owns one tooltip; hover on desktop, tap on a phone. */
function TipFrame({ tip, w, children }: { tip: TipState; w: number; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      {tip && (
        <div className="tip" style={{ left: Math.max(0, Math.min(tip.x + 14, w - 250)), top: Math.max(0, tip.y + 14) }}>
          {tip.body}
        </div>
      )}
    </div>
  );
}

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

const segDist = (mx: number, my: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / l2));
  return (mx - x1 - t * dx) ** 2 + (my - y1 - t * dy) ** 2;
};

/** `selected`, when set, draws only that model's line (with every architecture behind it, on Skyway). */
export function StageChart({ rows: all, selected, onSelect }: { rows: StageRow[]; selected?: string | null; onSelect?: (model: string | null) => void }) {
  const rows = selected ? all.filter((r) => r.model === selected) : all;
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const [hot, setHot] = useState<string | null>(null);
  const small = w < 640;
  const h = small ? 300 : 440;
  const m = { l: 36, r: small ? 12 : 168, t: 12, b: 40 };
  const n = all[0]?.stages.length ?? 6;
  const x = (i: number) => m.l + (i * (w - m.l - m.r)) / Math.max(1, n - 1);
  const y = (v: number) => m.t + (1 - v) * (h - m.t - m.b);
  const pts = rows.flatMap((r) => r.stages.map((s, i) => ({ r, s, i, px: x(i), py: y(s.crashed ? 0 : s.passed / s.total) })));

  const near = (ev: React.PointerEvent<SVGSVGElement>) => {
    const box = ev.currentTarget.getBoundingClientRect();
    const mx = ev.clientX - box.left, my = ev.clientY - box.top;
    let best: (typeof pts)[number] | null = null, d = 28 * 28;
    for (const p of pts) {
      const dd = (p.px - mx) ** 2 + (p.py - my) ** 2;
      if (dd < d) (d = dd), (best = p);
    }
    let lineRow: StageRow | null = null, lineD = 18 * 18;
    for (const row of rows) {
      let prev: [number, number] | null = null;
      for (let i = 0; i < row.stages.length; i++) {
        const s = row.stages[i];
        if (s.crashed) { prev = null; continue; }
        const px = x(i), py = y(s.passed / s.total);
        if (prev) {
          const dd = segDist(mx, my, prev[0], prev[1], px, py);
          if (dd < lineD) { lineD = dd; lineRow = row; }
        }
        prev = [px, py];
      }
    }
    setHot(best?.r.model ?? lineRow?.model ?? null);
    if (!best) return setTip(null);
    const { r, s, i } = best;
    setTip({
      x: best.px,
      y: best.py,
      body: (
        <>
          <div className="font-medium">{star(r.model)} · stage {i}</div>
          <div className="num">{s.crashed ? `The agent never started, so all ${s.total} tickets failed` : `${s.passed} of ${s.total} tickets passed (${pct(s.passed / s.total)})`}</div>
          {r.band?.[i] && (
            <div className="num muted mt-0.5">
              Architectures: {pct(r.band[i].lo)} ({r.band[i].loName}) to {pct(r.band[i].hi)} ({r.band[i].hiName})
            </div>
          )}
          {r.parts && r.parts.length > 1 && (
            <div className="mt-1.5">
              {r.parts.map((p) => {
                const st = p.stages[i];
                return (
                  <div key={p.name} className="num" style={{ opacity: 0.75 }}>
                    {p.name}: {st && !st.crashed && st.total ? pct(st.passed / st.total) : "—"}
                  </div>
                );
              })}
            </div>
          )}
          {!s.crashed && s.types.length > 0 && (
            <table className="mt-1.5 w-full num">
              <tbody>
                {s.types.map(([plain, term, p, t]) => (
                  <tr key={term}>
                    <td className="pr-2 align-top">{term} <span className="muted">({plain.toLowerCase()})</span></td>
                    <td className="text-right align-top whitespace-nowrap">{p}/{t}{t < 10 && <span className="muted"> · few</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ),
    });
  };

  // End labels, pushed apart so they never overlap.
  const ends = rows
    .map((r) => {
      const last = [...r.stages].reverse().find((s) => !s.crashed);
      return { r, y: y(last ? last.passed / last.total : 0) };
    })
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 15);

  return (
    <div ref={ref}>
      {w > 0 && (
        <TipFrame tip={tip} w={w}>
          <svg width={w} height={h} onPointerMove={near} onPointerDown={near} onPointerLeave={() => { setTip(null); setHot(null); }} role="img" aria-label="Pass rate per stage, one line per model and harness">
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <g key={v}>
                <line x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={m.l - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--muted)">{v * 100}%</text>
              </g>
            ))}
            {Array.from({ length: n }, (_, i) => (
              <text key={i} x={x(i)} y={h - 14} textAnchor="middle" fontSize={12} fill="var(--muted)">
                {small ? `S${i}` : i === 0 ? "Stage 0 · first build" : `Stage ${i}`}
              </text>
            ))}
            {rows.map((r) =>
              r.band ? (
                <path
                  key={`${r.model}-band`}
                  d={`${r.band.map((b, i) => `${i ? "L" : "M"}${x(i)},${y(b.hi)}`).join("")}${[...r.band].reverse().map((b, k) => `L${x(r.band!.length - 1 - k)},${y(b.lo)}`).join("")}Z`}
                  fill={r.color}
                  opacity={0.14}
                />
              ) : null,
            )}
            {rows.map((r) =>
              (hot === r.model || selected === r.model) && r.parts && r.parts.length > 1
                ? r.parts.map((p) => {
                    let d = "", pen = false;
                    p.stages.forEach((s, i) => {
                      if (s.crashed || !s.total) return void (pen = false);
                      d += `${pen ? "L" : "M"}${x(i)},${y(s.passed / s.total)} `;
                      pen = true;
                    });
                    const last = [...p.stages.keys()].reverse().find((i) => !p.stages[i].crashed && p.stages[i].total);
                    return (
                      <g key={`${r.model}-${p.name}`}>
                        <path d={d} fill="none" stroke={r.color} strokeWidth={1.15} opacity={0.4} />
                        {selected === r.model && !small && last != null && (
                          <text x={x(last) + 6} y={y(p.stages[last].passed / p.stages[last].total) + 4} fontSize={11} fill={r.color} opacity={0.75}>{p.name}</text>
                        )}
                      </g>
                    );
                  })
                : null,
            )}
            {rows.map((r) => {
              let d = "";
              let pen = false;
              r.stages.forEach((s, i) => {
                if (s.crashed) return void (pen = false);
                d += `${pen ? "L" : "M"}${x(i)},${y(s.passed / s.total)} `;
                pen = true;
              });
              return <path key={r.model} d={d} fill="none" stroke={r.color} strokeWidth={small ? 1.8 : 2.2} />;
            })}
            {pts.map(({ r, s, i, px, py }) =>
              s.crashed ? (
                <g key={`${r.model}${i}`}>
                  <Mark shape="cross" x={px} y={py} r={7} color={r.color} />
                </g>
              ) : (
                <Mark key={`${r.model}${i}`} shape={r.shape} x={px} y={py} r={small ? 3.6 : 4.6} color={r.color} />
              ),
            )}
            {!small &&
              ends.map(({ r, y: ly }) => (
                <text key={r.model} x={w - m.r + 12} y={ly + 4} fontSize={13} fill={r.color} fontWeight={500} style={onSelect ? { cursor: "pointer" } : undefined} onClick={onSelect ? () => onSelect(selected === r.model ? null : r.model) : undefined}>
                  {star(r.model)}
                </text>
              ))}
          </svg>
        </TipFrame>
      )}
    </div>
  );
}

/** With `onSelect`, each builder is a toggle: pick one to draw only its line in the StageChart beside it. */
export function RankTable({ rows, who = "Builder · harness", compact, selected, onSelect }: { rows: StageRow[]; who?: string; compact?: boolean; selected?: string | null; onSelect?: (model: string | null) => void }) {
  const pick = (m: string) => onSelect?.(selected === m ? null : m);
  const dim = (m: string) => (selected && selected !== m ? { opacity: 0.45 } : undefined);
  const Name = ({ r, className }: { r: StageRow; className: string }) =>
    onSelect ? (
      <button type="button" aria-pressed={selected === r.model} onClick={() => pick(r.model)} className={`${className} cursor-pointer text-left hover:underline`}>
        <MarkIcon shape={r.shape} color={r.color} />{star(r.model)}
      </button>
    ) : (
      <span className={className}><MarkIcon shape={r.shape} color={r.color} />{star(r.model)}</span>
    );
  // Compact (the blog): one line per builder, two columns, so the table is half as tall under its chart.
  if (compact)
    return (
      <ol className="grid gap-x-8 text-[14px] sm:grid-cols-2" aria-label={`${who}, by tickets passed`}>
        {rows.map((r, i) => (
          <li key={r.model} className="flex items-baseline gap-2 border-t py-2" style={{ borderColor: "var(--line)", ...dim(r.model) }}>
            <span className="num muted w-4 shrink-0">{i + 1}</span>
            <Name r={r} className="flex shrink-0 items-center gap-2 font-medium" />
            <span className="label muted truncate">{r.harness}</span>
            <span className="num ml-auto shrink-0 font-medium" title={`${r.passed}/${r.total} tickets`}>{pct(r.rate)}</span>
          </li>
        ))}
      </ol>
    );
  return (
    <table className="w-full text-[15px]">
      <thead>
        <tr className="label muted text-left">
          <th className="pb-2 pr-2 font-medium">#</th>
          <th className="pb-2 font-medium">{who}</th>
          <th className="pb-2 text-right font-medium">Tickets passed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.model} className="border-t" style={{ borderColor: "var(--line)", ...dim(r.model) }}>
            <td className="py-2.5 pr-2 align-top num muted">{i + 1}</td>
            <td className="py-2.5 align-top">
              <Name r={r} className="flex items-center gap-2 font-medium" />
              <div className="label muted pl-[22px]">{r.harness}</div>
            </td>
            <td className="py-2.5 text-right align-top num">
              <div className="font-medium">{pct(r.rate)}</div>
              <div className="label muted">{r.passed}/{r.total}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------- plot 2: where failed checks come from ----------------

/** One builder's failed tickets, split by group as on the run viewer's Failure analysis page: a failed ticket counts once,
 *  split evenly between the parties blamed for it, then between that party's groups. Keys are "Builder|group", "Agent|group". */
export type FailureRow = { model: string; harness: string; failed: number; total: number; rate: number; groups: Map<string, number>; crashedStages: number };

export function FailureBars({ rows, focus, onFocus }: { rows: FailureRow[]; focus: FailureGroup | null; onFocus: (g: FailureGroup | null) => void }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const small = w < 640;
  const n = (r: FailureRow, g: (typeof GROUPS)[number]) => r.groups.get(`${g.party}|${g.group}`) ?? 0;
  const known = new Set(GROUPS.map((g) => `${g.party}|${g.group}`));
  const other = (r: FailureRow) => [...r.groups].reduce((a, [k, v]) => a + (known.has(k) ? 0 : v), 0);
  const side = (r: FailureRow, party: string) => GROUPS.filter((g) => g.party === party).reduce((a, g) => a + n(r, g), 0) + (party === "Agent" ? other(r) : 0);
  const max = Math.max(20, ...rows.flatMap((r) => [side(r, "Builder"), side(r, "Agent")])) * 1.05;
  const one = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
  const show = (e: React.PointerEvent<HTMLElement>, r: FailureRow, g: (typeof GROUPS)[number]) => {
    const box = ref.current!.getBoundingClientRect(), seg = e.currentTarget.getBoundingClientRect();
    const v = n(r, g);
    setTip({
      x: seg.left - box.left + seg.width / 2,
      y: seg.bottom - box.top,
      body: (
        <>
          <div className="font-medium">{star(r.model)}</div>
          <div className="mt-0.5 flex items-center gap-1.5"><span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: g.color }} />{g.party} failure: {g.term}</div>
          <div className="num mt-1">{one(v)} of {r.failed} failed tickets ({pct(v / r.failed)})</div>
          <div className="muted mt-1">{groupDef(g.group)}</div>
        </>
      ),
    });
  };
  const half = (r: FailureRow, party: "Builder" | "Agent") => (
    <div className={party === "Builder" ? "flex flex-1 justify-end" : "flex flex-1"}>
      <div className="flex items-center gap-1.5" style={{ flexDirection: party === "Builder" ? "row-reverse" : "row", width: "100%" }}>
        <div className="flex h-5" style={{ width: `${(100 * side(r, party)) / max}%`, flexDirection: party === "Builder" ? "row-reverse" : "row" }}>
          {GROUPS.filter((g) => g.party === party).map((g) => {
            const v = n(r, g);
            return v > 0 ? (
              <div key={g.group} onPointerEnter={(e) => show(e, r, g)} onPointerDown={(e) => show(e, r, g)} style={{ width: `${(100 * v) / side(r, party)}%`, background: g.color, opacity: focus && focus !== g.group ? 0.18 : 1, cursor: "default" }} />
            ) : null;
          })}
          {party === "Agent" && other(r) > 0 && (
            <div
              onPointerEnter={(e) => {
                const box = ref.current!.getBoundingClientRect(), seg = e.currentTarget.getBoundingClientRect();
                const rest = [...r.groups].filter(([k]) => !known.has(k));
                setTip({
                  x: seg.left - box.left + seg.width / 2,
                  y: seg.bottom - box.top,
                  body: (
                    <>
                      <div className="font-medium">{star(r.model)}</div>
                      {rest.map(([k, v]) => <div key={k} className="num">{k}: {one(v)} of {r.failed}</div>)}
                    </>
                  ),
                });
              }}
              style={{ width: `${(100 * other(r)) / side(r, party)}%`, background: "var(--muted)", cursor: "default" }}
            />
          )}
        </div>
        <span className="label num muted shrink-0">{one(side(r, party))}</span>
      </div>
    </div>
  );
  return (
    <div ref={ref}>
      <TipFrame tip={tip} w={w}>
        <div onPointerLeave={() => setTip(null)}>
          <div className={small ? "flex justify-between label" : "ml-[232px] flex justify-between label"}>
            <span style={{ color: "var(--f-recall)" }}>← Builder failure</span>
            <span className="muted">failed tickets</span>
            <span style={{ color: "var(--f-state)" }}>Agent failure →</span>
          </div>
          <ul className="mt-2">
            {rows.map((r) => (
              <li key={r.model} className={small ? "py-2.5" : "grid grid-cols-[220px_1fr] items-center gap-3 py-2"}>
                <div className={small ? "mb-1.5 flex items-baseline justify-between" : ""}>
                  <div className="font-medium leading-tight">{star(r.model)}</div>
                  <div className="label muted num">
                    {small ? `${r.failed} of ${r.total} failed` : `${r.harness} · ${r.failed} of ${r.total} failed`}
                    {r.crashedStages > 0 && ` · ${r.crashedStages} stage never ran`}
                  </div>
                </div>
                <div className="flex items-center">
                  {half(r, "Builder")}
                  <div className="h-7 w-px shrink-0" style={{ background: "var(--ink)" }} />
                  {half(r, "Agent")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </TipFrame>
      <ul className="mt-5 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <li key={g.group}>
            <button type="button" aria-pressed={focus === g.group} onClick={() => onFocus(focus === g.group ? null : g.group)} className="flex items-center gap-2 text-left text-[13px]" style={{ opacity: focus && focus !== g.group ? 0.45 : 1 }}>
              <span className="size-3 shrink-0 rounded-[2px]" style={{ background: g.color }} />
              <span><span className="muted">{g.party} failure:</span> {g.term}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="label muted mt-3 max-w-[90ch]">
        Bars count failed tickets, as the run pages do: a ticket blamed on both sides counts half to each. Hover or tap a segment for its share.
      </p>
    </div>
  );
}

export type RecallPoint = { model: string; color: string; shape: Shape; stage: number; recall: number; pass: number };

export function RecallScatter({ points, height = 300 }: { points: RecallPoint[]; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const h = height;
  const m = { l: 40, r: 12, t: 10, b: 40 };
  const lo = Math.min(0.4, ...points.map((p) => p.recall)) - 0.02;
  const x = (v: number) => m.l + ((v - lo) / (1.02 - lo)) * (w - m.l - m.r);
  const y = (v: number) => m.t + (1 - v) * (h - m.t - m.b);
  const near = (ev: React.PointerEvent<SVGSVGElement>) => {
    const b = ev.currentTarget.getBoundingClientRect();
    const mx = ev.clientX - b.left, my = ev.clientY - b.top;
    let best: RecallPoint | null = null, d = 24 * 24;
    for (const p of points) {
      const dd = (x(p.recall) - mx) ** 2 + (y(p.pass) - my) ** 2;
      if (dd < d) (d = dd), (best = p);
    }
    setTip(best && { x: x(best.recall), y: y(best.pass), body: <><div className="font-medium">{star(best.model)} · stage {best.stage}</div><div className="num">Rule recall {best.recall.toFixed(2)} · passed {pct(best.pass)}</div></> });
  };
  const ticks = [0.4, 0.6, 0.8, 1].filter((t) => t >= lo);
  return (
    <div ref={ref}>
      {w > 0 && (
        <TipFrame tip={tip} w={w}>
          <svg width={w} height={h} onPointerMove={near} onPointerDown={near} onPointerLeave={() => setTip(null)} role="img" aria-label="Rule recall against stage pass rate">
            <rect x={x(lo)} y={m.t} width={x(0.9) - x(lo)} height={h - m.t - m.b} fill="color-mix(in srgb, var(--ink) 5%, transparent)" />
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <g key={v}>
                <line x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={m.l - 6} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--muted)">{v * 100}%</text>
              </g>
            ))}
            {ticks.map((t) => (
              <text key={t} x={x(t)} y={h - 22} textAnchor="middle" fontSize={12} fill="var(--muted)">{t.toFixed(1)}</text>
            ))}
            <text x={(m.l + w - m.r) / 2} y={h - 4} textAnchor="middle" fontSize={12} fill="var(--muted)">Rule recall: needed facts in the agent's files</text>
            {points.map((p, i) => (
              <Mark key={i} shape={p.shape} x={x(p.recall)} y={y(p.pass)} r={4.2} color={p.color} />
            ))}
          </svg>
        </TipFrame>
      )}
    </div>
  );
}

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

/** Wilson 95% interval for a pass rate of p/n. */
export function wilson(p: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const f = p / n;
  const d = 1 + (z * z) / n;
  const c = (f + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((f * (1 - f)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}
const rate = (r: ArchRun) => r.passed / r.total;
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
/** Pass-rate axis shared by the dot plot and the scatter: whole tens around every interval. */
function passDomain(runs: ArchRun[]): [number, number] {
  const ci = runs.map((r) => wilson(r.passed, r.total));
  return [Math.max(0, Math.floor(Math.min(...ci.map((c) => c[0])) * 10) / 10), Math.min(1, Math.ceil(Math.max(...ci.map((c) => c[1])) * 10) / 10)];
}
function runTip(r: ArchRun) {
  const [lo, hi] = wilson(r.passed, r.total);
  return (
    <>
      <div className="font-medium">{r.name}</div>
      <div className="muted">{r.model} · {r.harness}</div>
      <div className="mt-1 num">Passed {r.passed}/{r.total} = {pct(rate(r))} <span className="muted">(95% interval {pct(lo)} to {pct(hi)})</span></div>
      <div className="num muted">By stage: {r.stages.map((x) => pct(x)).join(" · ")}</div>
      <div className="num muted">${r.usd.toFixed(2)} a ticket · {Math.round(r.time)} s median · {Math.round(r.tok)}k input tokens</div>
    </>
  );
}

/** Pass rate per architecture: a dot per builder with its 95% interval; a tick for the mean once there are 2+ builders. */
export function ArchPass({ runs, order }: { runs: ArchRun[]; order: string[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const small = w < 640;
  const label = small ? 0 : 230;
  const right = 48;
  const [lo, hi] = passDomain(runs);
  const x = (v: number) => label + ((v - lo) / (hi - lo)) * Math.max(10, w - label - right);
  const rowH = small ? 58 : 44;
  const top = small ? 4 : 22;
  const ticks = Array.from({ length: Math.round((hi - lo) * 10) + 1 }, (_, i) => lo + i / 10);
  const h = top + order.length * rowH + 8;
  return (
    <div ref={ref}>
      <TipFrame tip={tip} w={w}>
        {w > 0 && (
          <svg width={w} height={h} onPointerLeave={() => setTip(null)} role="img" aria-label="Pass rate by architecture, with 95% intervals">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={top - 4} y2={h - 6} stroke="var(--line)" />
                {!small && <text x={x(t)} y={12} textAnchor="middle" className="num" fontSize={12} fill="var(--muted)">{pct(t)}</text>}
              </g>
            ))}
            {order.map((arch, i) => {
              const rs = runs.filter((r) => r.arch === arch);
              const y = top + i * rowH + (small ? 38 : rowH / 2);
              const mu = avg(rs.map(rate));
              return (
                <g key={arch}>
                  <text x={small ? 0 : 0} y={small ? y - 22 : y - 3} fontSize={14} fontWeight={500} fill="var(--ink)">{rs[0]?.name}</text>
                  {!small && <text x={0} y={y + 13} fontSize={11} className="mono" fill="var(--muted)">{arch}</text>}
                  {rs.length > 1 && <line x1={x(mu)} x2={x(mu)} y1={y - 11} y2={y + 11} stroke="var(--ink)" strokeWidth={2} />}
                  {rs.map((r, j) => {
                    const [a, b] = wilson(r.passed, r.total);
                    const dy = rs.length > 1 ? (j - (rs.length - 1) / 2) * 5 : 0;
                    return (
                      <g key={r.model} onPointerEnter={() => setTip({ x: x(rate(r)), y: y, body: runTip(r) })} onClick={() => setTip({ x: x(rate(r)), y, body: runTip(r) })} style={{ cursor: "default" }}>
                        <line x1={x(a)} x2={x(b)} y1={y + dy} y2={y + dy} stroke={r.color} strokeWidth={2} strokeLinecap="round" opacity={0.45} />
                        <Mark shape={r.shape} x={x(rate(r))} y={y + dy} r={6} color={r.color} />
                      </g>
                    );
                  })}
                  <text x={w - 2} y={y + 4} textAnchor="end" className="num" fontSize={13} fontWeight={600} fill="var(--ink)">{pct(mu)}</text>
                </g>
              );
            })}
          </svg>
        )}
      </TipFrame>
    </div>
  );
}

/** The price of a pass rate: pass rate against cost per ticket or ticket time, one point per builder and architecture. */
export function ArchTradeoff({ runs, order }: { runs: ArchRun[]; order: string[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const [axis, setAxis] = useState<"usd" | "time">("usd");
  const h = 320;
  const m = { l: 44, r: 16, t: 16, b: 40 };
  const [lo, hi] = passDomain(runs);
  const xs = runs.map((r) => r[axis]);
  const xmax = Math.max(...xs) * 1.15;
  const xmin = axis === "time" ? Math.max(0, Math.min(...xs) * 0.8) : 0;
  const X = (v: number) => m.l + ((v - xmin) / (xmax - xmin)) * (w - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (h - m.t - m.b);
  const yt = Array.from({ length: Math.round((hi - lo) * 10) + 1 }, (_, i) => lo + i / 10);
  const narrow = w < 560;
  const step = axis === "usd" ? (xmax > 1 || narrow ? 0.2 : 0.1) : narrow ? 20 : 10;
  const xt = Array.from({ length: Math.floor((xmax - xmin) / step) + 1 }, (_, i) => Math.ceil(xmin / step) * step + i * step).filter((v) => v <= xmax);
  const fmt = (v: number) => (axis === "usd" ? `$${v.toFixed(2)}` : `${Math.round(v)} s`);
  const frontPts = frontier(order.map((a) => { const rs = runs.filter((r) => r.arch === a); return [avg(rs.map((r) => r[axis])), avg(rs.map(rate))] as [number, number]; }));
  return (
    <div ref={ref}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="label muted">Pass rate vs {axis === "usd" ? "cost per ticket" : "ticket time"}</div>
        <div className="seg" role="group">
          {(["usd", "time"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={axis === k} onClick={() => setAxis(k)}>{k === "usd" ? "Cost per ticket" : "Ticket time"}</button>
          ))}
        </div>
      </div>
      <TipFrame tip={tip} w={w}>
        {w > 0 && (
          <svg width={w} height={h} onPointerLeave={() => setTip(null)} role="img" aria-label="Pass rate against cost per ticket by architecture">
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={w - m.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
                <text x={m.l - 8} y={Y(t) + 4} textAnchor="end" fontSize={12} className="num" fill="var(--muted)">{pct(t)}</text>
              </g>
            ))}
            {xt.map((t) => <text key={t} x={X(t)} y={h - m.b + 18} textAnchor="middle" fontSize={12} className="num" fill="var(--muted)">{fmt(t)}</text>)}
            <text x={m.l + 4} y={m.t + 12} fontSize={11} fill="var(--muted)">↖ better: more passed and {axis === "usd" ? "cheaper" : "faster"}</text>
            <path d={worseRegion(frontPts, X, Y, w - m.r, h - m.b)} fill="var(--ink)" opacity={0.12} />
            <path d={frontPts.map(([cx, cy], i) => `${i ? "L" : "M"}${X(cx)},${Y(cy)}`).join("")} fill="none" stroke="var(--ink)" strokeWidth={1.2} strokeDasharray="4 4" opacity={0.6} />
            {placeLabels(
              order.map((arch) => {
                const rs = runs.filter((r) => r.arch === arch);
                const cx = X(avg(rs.map((r) => r[axis])));
                return { arch, rs, cx, cy: Y(avg(rs.map(rate))), left: cx > w * 0.7 };
              }),
            ).map(({ arch, rs, cx, cy, left, ly }) => (
              <g key={arch}>
                {rs.length > 1 && <circle cx={cx} cy={cy} r={11} fill="none" stroke="var(--ink)" strokeWidth={1} opacity={0.5} />}
                {rs.map((r) => (
                  <g key={r.model} onPointerEnter={() => setTip({ x: X(r[axis]), y: Y(rate(r)), body: runTip(r) })} onClick={() => setTip({ x: X(r[axis]), y: Y(rate(r)), body: runTip(r) })}>
                    <Mark shape={r.shape} x={X(r[axis])} y={Y(rate(r))} r={6} color={r.color} />
                  </g>
                ))}
                {!narrow && Math.abs(ly - (cy + 4)) > 2 && <line x1={cx + (left ? -7 : 7)} y1={cy} x2={cx + (left ? -11 : 11)} y2={ly - 4} stroke="var(--muted)" strokeWidth={0.75} />}
                {narrow ? (
                  <text x={cx} y={cy - 10} textAnchor="middle" fontSize={11} fontWeight={600} className="num" fill="var(--ink)">{order.indexOf(arch) + 1}</text>
                ) : (
                  <text x={cx + (left ? -12 : 12)} y={ly} textAnchor={left ? "end" : "start"} fontSize={12} className="mono" fill="var(--ink)">{arch}</text>
                )}
              </g>
            ))}
          </svg>
        )}
      </TipFrame>
      {narrow && (
        <ol className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px]">
          {order.map((a, i) => <li key={a}><span className="num font-semibold">{i + 1}</span> <span className="mono">{a}</span></li>)}
        </ol>
      )}
      <p className="label muted mt-2">The tint is the feasible region under the frontier: a design there {axis === "usd" ? "costs more" : "takes longer"} and passes fewer tickets than one on the line.</p>
    </div>
  );
}

/** Push labels apart vertically where their boxes would overlap (labels are short ids, about 7 px a character). */
function placeLabels<T extends { arch: string; cx: number; cy: number; left: boolean }>(items: T[]): (T & { ly: number })[] {
  const box = (t: T) => (t.left ? [t.cx - 12 - t.arch.length * 7.2, t.cx - 12] : [t.cx + 12, t.cx + 12 + t.arch.length * 7.2]);
  const placed: (T & { ly: number })[] = [];
  for (const t of [...items].sort((a, b) => a.cy - b.cy)) {
    let ly = t.cy + 4;
    const [a, b] = box(t);
    for (const p of placed) {
      const [c, d] = box(p);
      if (a < d && c < b && Math.abs(ly - p.ly) < 15) ly = p.ly + 15;
    }
    placed.push({ ...t, ly });
  }
  return placed;
}

/** The Pareto frontier of [cost, score] points: cheapest first, each one passing more than every cheaper point. */
export function frontier(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of [...points].sort((a, b) => a[0] - b[0] || b[1] - a[1])) if (!out.length || p[1] > out[out.length - 1][1]) out.push(p);
  return out;
}

/** The region a frontier point already beats: higher cost, lower pass rate. Dominated on a builder chart; the feasible-but-worse set on a tradeoff chart. */
function worseRegion(front: [number, number][], X: (v: number) => number, Y: (v: number) => number, right: number, bottom: number) {
  if (!front.length) return "";
  const d = [`M${X(front[0][0])},${bottom}`, `L${X(front[0][0])},${Y(front[0][1])}`];
  for (let i = 1; i < front.length; i++) d.push(`L${X(front[i][0])},${Y(front[i - 1][1])}`, `L${X(front[i][0])},${Y(front[i][1])}`);
  const last = front[front.length - 1];
  d.push(`L${right},${Y(last[1])}`, `L${right},${bottom}`, "Z");
  return d.join("");
}

export type CostPoint = { model: string; harness: string; color: string; shape: Shape; rate: number; cost: number };

/** Pass rate against what the builder spent on the whole run (log scale: costs span about 100×), with the frontier. */
export function BuilderPareto({ points }: { points: CostPoint[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const narrow = w < 560;
  const h = 300;
  const m = { l: 44, r: narrow ? 16 : 150, t: 16, b: 40 };
  const pos = points.map((p) => p.cost).filter((c) => c > 0);
  const lo = (pos.length ? Math.min(...pos) : 1) / 1.6;
  const hi = (pos.length ? Math.max(...pos) : 1) * 1.4;
  const span = Math.log(hi) - Math.log(lo);
  const X = (v: number) => (v > 0 ? m.l + ((Math.log(v) - Math.log(lo)) / span) * (w - m.l - m.r) : m.l);
  const ylo = Math.max(0, Math.floor(Math.min(...points.map((p) => p.rate)) * 10) / 10 - 0.1), yhi = Math.min(1, Math.ceil(Math.max(...points.map((p) => p.rate)) * 10) / 10);
  const Y = (v: number) => m.t + (1 - (v - ylo) / (yhi - ylo)) * (h - m.t - m.b);
  const xt = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].filter((v) => v >= lo && v <= hi);
  const yt = Array.from({ length: Math.round((yhi - ylo) * 10) + 1 }, (_, i) => ylo + i / 10);
  const frontPts = frontier(points.map((p) => [p.cost, p.rate]));
  const front = new Set(frontPts.map(([c, r]) => `${c}|${r}`));
  const sorted = [...points].sort((a, b) => b.rate - a.rate);
  const labels = placeLabels(points.map((p) => ({ arch: p.model, p, cx: X(p.cost), cy: Y(p.rate), left: false })));
  return (
    <div ref={ref}>
      <div className="label muted mb-3">Pass rate vs builder cost (the builder's LLM spend for the whole run)</div>
      <TipFrame tip={tip} w={w}>
        {w > 0 && (
          <svg width={w} height={h} onPointerLeave={() => setTip(null)} role="img" aria-label="Pass rate against builder cost, one point per builder">
            {yt.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={w - m.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
                <text x={m.l - 8} y={Y(t) + 4} textAnchor="end" fontSize={12} className="num" fill="var(--muted)">{pct(t)}</text>
              </g>
            ))}
            {xt.map((t) => <text key={t} x={X(t)} y={h - m.b + 18} textAnchor="middle" fontSize={12} className="num" fill="var(--muted)">${t < 1 ? t.toFixed(2) : t}</text>)}
            <text x={m.l + 4} y={m.t + 12} fontSize={11} fill="var(--muted)">↖ better: more passed for less</text>
            <path d={worseRegion(frontPts, X, Y, w - m.r, h - m.b)} fill="var(--ink)" opacity={0.12} />
            <path d={frontPts.map(([c, r], i) => `${i ? "L" : "M"}${X(c)},${Y(r)}`).join("")} fill="none" stroke="var(--ink)" strokeWidth={1.2} strokeDasharray="4 4" opacity={0.6} />
            {labels.map(({ p, cx, cy, ly }) => {
              const body = (
                <>
                  <div className="font-medium">{star(p.model)}</div>
                  <div className="muted">{p.harness}</div>
                  <div className="num mt-1">Passed {pct(p.rate)} · builder spent ${p.cost.toFixed(2)}</div>
                  {front.has(`${p.cost}|${p.rate}`) && <div className="muted">On the frontier: no cheaper builder passed more</div>}
                </>
              );
              return (
                <g key={p.model} onPointerEnter={() => setTip({ x: cx, y: cy, body })} onClick={() => setTip({ x: cx, y: cy, body })}>
                  <Mark shape={p.shape} x={cx} y={cy} r={6} color={p.color} />
                  {narrow ? (
                    <text x={cx} y={cy - 10} textAnchor="middle" fontSize={11} fontWeight={600} className="num" fill="var(--ink)">{sorted.indexOf(p) + 1}</text>
                  ) : (
                    <text x={cx + 12} y={ly} fontSize={12} fill="var(--ink)">{p.model}</text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </TipFrame>
      {narrow && (
        <ol className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px]">
          {sorted.map((p, i) => <li key={p.model}><span className="num font-semibold">{i + 1}</span> {p.model}</li>)}
        </ol>
      )}
      <p className="label muted mt-2">The tint is the dominated region: a builder there spent more and passed fewer tickets than one on the line. Costs are as each harness reports them.</p>
    </div>
  );
}

const TYPES: [TicketType, string][] = [
  ["discovery", "new facts"],
  ["regression", "unchanged facts"],
  ["adaptability", "changed facts"],
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
      <div className="label muted mb-3">Pass rate by ticket type</div>
      <table className="w-full border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th />
            {TYPES.map(([t, plain]) => (
              <th key={t} className="pb-1 text-left align-bottom font-normal">
                <div className="text-[13px] font-medium">{t}</div>
                <div className="label muted">{plain}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.arch}>
              <td className="pr-2 text-[13px] leading-tight">{c.name}</td>
              {c.v.map((v, i) => (
                <td key={i} className="num h-9 rounded-[3px] px-2 text-[13px]" title={v ? `${c.name}, ${TYPES[i][0]}: ${pct(v.rate)} of ${v.n} tickets` : ""}
                  style={v ? { background: `color-mix(in oklab, var(--ink) ${shade(v.rate)}%, var(--bg))`, color: shade(v.rate) > 50 ? "var(--bg)" : "var(--ink)" } : undefined}>
                  {v ? pct(v.rate) : "–"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="label muted mt-2">Darker means a higher pass rate ({pct(lo)} to {pct(hi)}).</p>
    </div>
  );
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: number[]) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));

// ---------------- plot 4: doc perturbations ----------------

export type PackBuilder = { model: string; color: string; shape: Shape; pass: (number | null)[] };

export function PacksChart({ builders }: { builders: PackBuilder[] }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const small = w < 640;
  const h = small ? 340 : 440;
  const m = { l: 40, r: 8, t: 40, b: small ? 52 : 40 };
  const n = CONDITIONS.length;
  const band = (w - m.l - m.r) / n;
  const cx = (i: number) => m.l + band * (i + 0.5);
  const y = (v: number) => m.t + (1 - v) * (h - m.t - m.b);
  const cols = CONDITIONS.map((_, i) => {
    const vals = builders.map((b) => b.pass[i]).filter((v): v is number => v != null);
    return { vals, mu: mean(vals), sd: sd(vals) };
  });
  const base = cols[0].mu;
  const bw = Math.min(small ? 46 : 120, band * 0.62);
  return (
    <div ref={ref}>
      {w > 0 && (
        <TipFrame tip={tip} w={w}>
          <svg width={w} height={h} onPointerLeave={() => setTip(null)} role="img" aria-label="Pass rate per doc pack against R-complete">
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <g key={v}>
                <line x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={m.l - 6} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--muted)">{v * 100}%</text>
              </g>
            ))}
            {cols.map((c, i) => {
              const d = Math.round(100 * (c.mu - base));
              const colour = i === 0 || Math.abs(d) < 5 ? "var(--ink)" : d < 0 ? "var(--f-recall)" : "var(--b-gpt61)";
              return (
                <g
                  key={i}
                  onPointerEnter={() =>
                    setTip({
                      x: cx(i),
                      y: y(c.mu),
                      body: (
                        <>
                          <div className="font-medium">{CONDITIONS[i]}</div>
                          <div className="num">Mean {pct(c.mu)} over {c.vals.length} builders · ±{Math.round(100 * c.sd)} pts across builders</div>
                          {i > 0 && <div className="num">{d >= 0 ? "+" : ""}{d} pts against R-complete</div>}
                        </>
                      ),
                    })
                  }
                  onPointerDown={() => setTip(null)}
                >
                  <rect x={cx(i) - band / 2} y={m.t} width={band} height={h - m.t - m.b} fill="transparent" />
                  <rect x={cx(i) - bw / 2} y={y(c.mu)} width={bw} height={y(0) - y(c.mu)} fill={i === 0 ? "var(--ink)" : "color-mix(in srgb, var(--ink) 32%, transparent)"} />
                  <line x1={cx(i)} x2={cx(i)} y1={y(Math.min(1, c.mu + c.sd))} y2={y(Math.max(0, c.mu - c.sd))} stroke="var(--ink)" strokeWidth={1.2} />
                  <line x1={cx(i) - 6} x2={cx(i) + 6} y1={y(Math.min(1, c.mu + c.sd))} y2={y(Math.min(1, c.mu + c.sd))} stroke="var(--ink)" />
                  <line x1={cx(i) - 6} x2={cx(i) + 6} y1={y(Math.max(0, c.mu - c.sd))} y2={y(Math.max(0, c.mu - c.sd))} stroke="var(--ink)" />
                  <text x={cx(i)} y={m.t - 16} textAnchor="middle" fontSize={small ? 13 : 16} fontWeight={500} fill={colour}>
                    {i === 0 ? (small ? "base" : "baseline") : `${d >= 0 ? "+" : ""}${d} pts`}
                  </text>
                  {builders.map((b, k) => {
                    const v = b.pass[i];
                    if (v == null) return null;
                    const jx = cx(i) + ((k / Math.max(1, builders.length - 1)) - 0.5) * Math.min(band * 0.7, small ? 40 : 90);
                    return <Mark key={b.model} shape={b.shape} x={jx} y={y(v)} r={small ? 3.6 : 4.6} color={b.color} />;
                  })}
                  {small ? (
                    <text x={cx(i)} y={h - 30} textAnchor="middle" fontSize={10.5} fill="var(--ink)">
                      <tspan x={cx(i)}>R-</tspan>
                      <tspan x={cx(i)} dy={13}>{CONDITIONS[i].slice(2)}</tspan>
                    </text>
                  ) : (
                    <text x={cx(i)} y={h - 14} textAnchor="middle" fontSize={13} fill="var(--ink)">{CONDITIONS[i]}</text>
                  )}
                </g>
              );
            })}
            <line x1={m.l} x2={w - m.r} y1={y(base)} y2={y(base)} stroke="var(--ink)" strokeDasharray="5 4" />
          </svg>
        </TipFrame>
      )}
    </div>
  );
}
