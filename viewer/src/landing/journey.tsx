/**
 * The journey of a ticket's facts, as one figure that morphs through five familiar shapes on an isometric desk
 * (the finish of the Anatomy / Hairline figures: paper with thickness, hairline strokes, soft shadows), every sheet facing the reader:
 *   doc page → prompt file → robot head (the prompt becomes its face; the head grows out behind it) → chat window → checklist.
 * The same bars (6 facts from the docs, 1 the customer holds, 8 filler lines) move between the shapes, so a fact can
 * be followed and its loss seen at the stage where it happens. Every state is laid out on one sheet (400 × 320); the
 * morph tweens the layout, the paper's thickness and the robot head's depth together. Scrolling past a step's text *triggers* the morph; it then
 * runs on its own 700 ms clock (scroll never scrubs it). Reduced motion: no tween.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GROUPS, type FailureGroup } from "./data";

type Box = [number, number, number, number];
type Role = "fact" | "filler" | "lost" | "ghost" | "missing-recall" | "missing-customer" | "wrong" | "gone";
/** x, y, w, h on the sheet, and how far the bar floats above it (screen px). */
type Bar = [Box, Role, number?];
/** th: how far the robot's head has grown out of the sheet (0–90); pv, fv, z are unused leftovers kept 0. */
type Plane = { th: number; pv: number; fv: number; z: number };
type State = { card: Box; rx: number; t: number; plane: Plane; bars: Record<string, Bar> };

const IDS = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "A", "B", "C", "D", "E", "F", "G"] as const;
const gone = ([x, y, , h]: Box): Bar => [[x, y, 0, h], "gone"];
const DESK: Plane = { th: 0, pv: 0, fv: 0, z: 0 };

// ---- camera: every sheet faces the reader; depth (paper thickness, the robot's head) recedes up and to the right ----
type M = [number, number, number, number, number, number];
const OBL: [number, number] = [0.55, -0.42];
/** Sheet (u, v) → screen. A lifted item rises a little (and keeps its shadow on the sheet). */
function matrixOf(_p: Plane, lift = 0): M {
  return [1, 0, 0, 1, -lift * 0.35, -lift * 0.55];
}
/** Screen offset of something `t` deep behind the sheet. */
function backOf(_p: Plane, t: number): [number, number] {
  return [OBL[0] * t, OBL[1] * t];
}
const apply = (m: M, [u, v]: [number, number]): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
const mstr = (m: M) => `matrix(${m.map((x) => +x.toFixed(3)).join(" ")})`;
const poly = (pts: [number, number][]) => pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" ");

// ---- the five states ----
/** The doc page, and the two docs stacked behind it (the rest of the knowledge base). */
const DOC: Box = [72, 34, 248, 256];
const DOC_STACK: [number, number][] = [[34, -26], [17, -13]];
const S0: State = (() => {
  const order = ["f0", "A", "f1", "f2", "B", "f3", "C", "f4", "D", "f5", "E", "f6", "F", "f7"];
  const w: Record<string, number> = { f0: 100, A: 196, f1: 170, f2: 214, B: 150, f3: 200, C: 208, f4: 140, D: 180, f5: 216, E: 160, f6: 190, F: 204, f7: 120 };
  const bars: Record<string, Bar> = {};
  order.forEach((id, i) => (bars[id] = [[94, 56 + i * 15.5 - (id === "f0" ? 1.5 : 0), w[id] * 0.92, id === "f0" ? 9 : 6], id.startsWith("f") ? "filler" : "fact"]));
  bars.G = gone([200, 160, 0, 6]);
  return { card: DOC, rx: 4, t: 4, plane: DESK, bars };
})();

const PROMPT = ["f0", "A", "B", "f1", "C", "E", "f2", "F", "f3"];
const PW: Record<string, number> = { f0: 60, A: 110, B: 96, f1: 80, C: 112, E: 90, f2: 70, F: 104, f3: 50 };
const PROMPT_CARD: Box = [80, 26, 240, 266];
const S1: State = (() => {
  const bars: Record<string, Bar> = {};
  PROMPT.forEach((id, i) => (bars[id] = [[id.startsWith("f") ? 102 : 120, 70 + i * 18, PW[id] * 1.25, id === "f0" ? 8 : 6], id.startsWith("f") ? "filler" : "fact"]));
  for (const id of ["f4", "f5", "f6", "f7"]) bars[id] = gone(S0.bars[id][0]);
  bars.D = [[292, 160, 64, 6], "lost", 12];
  bars.G = gone([200, 160, 0, 6]);
  return { card: PROMPT_CARD, rx: 6, t: 5, plane: DESK, bars };
})();

/** The robot head: the prompt sheet stands up as its face; the head's box, eyes and antenna are drawn around it. */
const HEAD = { card: [120, 40, 180, 200] as Box, depth: 84, neck: [186, 240, 48, 10] as Box, base: [136, 250, 148, 14] as Box };
const S2: State = (() => {
  const bars: Record<string, Bar> = {};
  PROMPT.forEach((id, i) => (bars[id] = [[id.startsWith("f") ? 166 : 176, 120 + i * 12, PW[id] * 0.72, id === "f0" ? 7 : 6], id.startsWith("f") ? "filler" : "fact"]));
  for (const id of ["f4", "f5", "f6", "f7"]) bars[id] = gone(S0.bars[id][0]);
  bars.D = gone(S1.bars.D[0]);
  bars.G = gone([200, 160, 0, 6]);
  return { card: HEAD.card, rx: 8, t: 0, plane: { th: 90, pv: 0, fv: 0, z: 0 }, bars };
})();

const BUBBLES: { box: Box; who: "customer" | "agent"; dashed?: boolean }[] = [
  { box: [156, 66, 128, 34], who: "customer" },
  { box: [210, 106, 134, 34], who: "agent" },
  { box: [156, 150, 128, 30], who: "customer", dashed: true },
  { box: [210, 206, 134, 34], who: "agent" },
];
const LIFT = 7;
const S3: State = (() => {
  const bars: Record<string, Bar> = {};
  PROMPT.forEach((id, i) => (bars[id] = [[54, 72 + i * 13, PW[id] * 0.6, 5], id.startsWith("f") ? "filler" : "fact"]));
  for (const id of ["f6", "f7", "D"]) bars[id] = gone(S2.bars[id][0]);
  bars.f4 = [[168, 76, 100, 6], "filler", LIFT];
  bars.f5 = [[168, 88, 64, 6], "filler", LIFT];
  bars.A = [[222, 116, 96, 6], "fact", LIFT];
  bars.B = [[222, 128, 70, 6], "fact", LIFT];
  bars.G = [[168, 162, 96, 6], "ghost", LIFT];
  bars.C = [[222, 216, 100, 6], "fact", LIFT];
  bars.E = [[222, 228, 74, 6], "fact", LIFT];
  return { card: [40, 36, 320, 248], rx: 8, t: 7, plane: DESK, bars };
})();

const ROWS: { id: string; w: number; ok: boolean; role: Role; term?: string; color?: string }[] = [
  { id: "A", w: 86, ok: true, role: "fact" },
  { id: "B", w: 74, ok: true, role: "fact" },
  { id: "C", w: 80, ok: false, role: "wrong", term: "database check", color: "var(--f-state)" },
  { id: "D", w: 72, ok: false, role: "missing-recall", term: "rule recall", color: "var(--f-recall)" },
  { id: "G", w: 68, ok: false, role: "missing-customer", term: "customer recall", color: "var(--f-customer)" },
];
const rowY = (i: number) => 96 + i * 40;
/** The clipboard: board, the paper on it, the clip. */
const CLIP: Box = [86, 26, 248, 288];
const S4: State = (() => {
  const bars: Record<string, Bar> = {};
  for (const id of IDS) bars[id] = gone(S3.bars[id][0]);
  bars.f0 = [[116, 64, 90, 8], "filler"];
  ROWS.forEach((r, i) => (bars[r.id] = [[140, rowY(i), r.w, 7], r.role]));
  return { card: CLIP, rx: 12, t: 7, plane: DESK, bars };
})();

const STATES = [S0, S1, S2, S3, S4];
const COUNTER = ["6 facts in the business context", "5 of 6 made it into the prompt", "5 of 6 · no docs at test time", "1 customer fact never asked", "2 of 5 checks pass · not resolved"];

// ---- static geometry ----
const rectPts = (m: M, [x, y, w, h]: Box): [number, number][] => [apply(m, [x, y]), apply(m, [x + w, y]), apply(m, [x + w, y + h]), apply(m, [x, y + h])];
/** A box seen from the front: its top and right faces, `depth` deep. */
function boxOf([x, y, w, h]: Box, depth: number) {
  const [bx, by] = backOf(DESK, depth);
  return {
    top: [[x, y], [x + w, y], [x + w + bx, y + by], [x + bx, y + by]] as [number, number][],
    side: [[x + w, y], [x + w, y + h], [x + w + bx, y + h + by], [x + w + bx, y + by]] as [number, number][],
  };
}
/** The head's box, grown back from the face by `depth`: top, right side, antenna base, four side bolts. */
function headOf(m: M, plane: Plane, [x, y, w, h]: Box, depth: number) {
  const B = backOf(plane, depth);
  const p0 = apply(m, [x, y]);
  const p1 = apply(m, [x + w, y]);
  const p2 = apply(m, [x + w, y + h]);
  const b = (p: [number, number], f = 1) => [p[0] + B[0] * f, p[1] + B[1] * f] as [number, number];
  const onSide = (a: number, c: number) => [p1[0] + (p2[0] - p1[0]) * c + B[0] * a, p1[1] + (p2[1] - p1[1]) * c + B[1] * a] as [number, number];
  return {
    top: [p0, p1, b(p1), b(p0)],
    side: [p1, p2, b(p2), b(p1)],
    antenna: b(apply(m, [x + w / 2, y]), 0.5),
    bolts: [onSide(0.25, 0.25), onSide(0.75, 0.25), onSide(0.25, 0.75), onSide(0.75, 0.75)],
  };
}
const DM0 = matrixOf(DESK);
const head = headOf(DM0, S2.plane, HEAD.card, HEAD.depth);
/** Where a sheet point of state `s` lands on screen (for upright labels and marks). */
const at = (s: number, u: number, v: number, lift = 0) => apply(matrixOf(STATES[s].plane, lift), [u, v]);
// the viewBox fits every state (with its shadow) and the robot's head
const VB = (() => {
  const pts = [...head.top, ...head.side, [head.antenna[0], head.antenna[1] - 34] as [number, number], ...rectPts(DM0, HEAD.base), ...boxOf(HEAD.base, HEAD.depth).side];
  for (const s of STATES) pts.push(...rectPts(DM0, s.card).map(([x, y]) => [x + 14, y + 18] as [number, number]));
  pts.push([DOC[0] + DOC[2] + DOC_STACK[0][0] + 4, DOC[1] + DOC_STACK[0][1] - 4], [CLIP[0], CLIP[1] - 22]);
  for (const s of STATES) pts.push(...rectPts(matrixOf(s.plane), s.card));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs) - 10, Math.min(...ys) - 10];
  return [x0, y0, Math.max(...xs) + 10 - x0, Math.max(...ys) + 14 - y0].map((n) => Math.round(n));
})();

type Tag = { group: FailureGroup; gloss: string };
const STEPS: { name: string; body: string; tags: Tag[] }[] = [
  { name: "Business context", body: "The company maintains its SOPs, policies, approvals, and business updates across multiple systems, including knowledge management platforms, internal wikis, UCaaS solutions, and other applications. The six facts this ticket needs are spread across them.", tags: [] },
  {
    name: "Builder",
    body: "The agent builder, such as Codex, Claude Code or Gemini CLI, reads the docs and writes the support agent's prompt and code. In this example, one fact doesn't make it in.",
    tags: [
      { group: "Missing knowledge (rule recall)", gloss: "a needed fact never reaches the agent" },
      { group: "Build spec failure", gloss: "the prompt exceeds the size cap, or the agent fails to start" },
    ],
  },
  {
    name: "Support agent",
    body: "The agent runs on a fixed model inside the support system; it can't see the docs, only what the builder wrote.",
    tags: [{ group: "Agent crash", gloss: "a model call fails mid-ticket" }],
  },
  {
    name: "Customer",
    body: "A simulated customer writes in and sends up to five messages. Each customer acts out one of 14 behaviors, and some facts only the customer knows, so the agent has to ask for them.",
    tags: [{ group: "Missing customer info (customer recall)", gloss: "the agent never asks for a fact only the customer has" }],
  },
  {
    name: "Resolution check",
    body: "Resolution only counts when the customer's issue is resolved in the appropriate system, with an outcome that aligns with company policies and knowledge. This one passes 2 of 5.",
    tags: [{ group: "Wrong end state (database check)", gloss: "the agent had the fact but wrote the wrong value" }],
  },
];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Tweens the sheet (tilt, layout, thickness) and every bar to state `k`, writing attributes directly. */
function useMorph(k: number, svg: React.RefObject<SVGSVGElement | null>, still: boolean) {
  const now = useRef<Record<string, number[]> | null>(null);
  const fade = useRef<Map<Element, number>>(new Map());
  useLayoutEffect(() => {
    const root = svg.current;
    if (!root) return;
    const s = STATES[k];
    const target: Record<string, number[]> = { card: [...s.card, s.rx, s.t, s.plane.th, s.plane.pv, s.plane.fv, s.plane.z] };
    for (const id of IDS) target[id] = [...s.bars[id][0], s.bars[id][2] ?? 0];
    const from = now.current ?? target;
    const els = Object.fromEntries([...root.querySelectorAll<SVGElement>("[data-bar]")].map((e) => [e.dataset.bar!, e]));
    // Fades run on this clock too (the site's CSS turns transitions off): old parts leave in the first quarter, new
    // ones arrive once the bars have landed; a bar changes colour halfway.
    const decos = [...root.querySelectorAll<SVGGElement>("[data-states]")];
    const fadeFrom = new Map([...decos, ...IDS.map((id) => els[id])].map((e) => [e, fade.current.get(e) ?? 0] as const));
    const smooth = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
    const write = (t: number) => {
      for (const d of decos) {
        const o0 = fadeFrom.get(d)!;
        const o = d.dataset.states!.split(" ").includes(String(k)) ? o0 + (1 - o0) * smooth((t - 0.6) / 0.4) : o0 * (1 - smooth(t / 0.25));
        fade.current.set(d, o);
        d.style.opacity = String(o);
      }
      for (const id of IDS) {
        const el = els[id];
        const [, role] = s.bars[id];
        const o0 = fadeFrom.get(el)!;
        const o = role === "gone" ? o0 * (1 - smooth(t / 0.5)) : o0 + (1 - o0) * smooth(o0 > 0.5 ? 1 : (t - 0.3) / 0.5);
        fade.current.set(el, o);
        el.style.opacity = String(o);
        if (role !== "gone" && (t >= 0.5 || o0 < 0.5)) el.setAttribute("data-role", role);
      }
      if (t >= 0.5) root.setAttribute("data-k", String(k));
      const v: Record<string, number[]> = {};
      for (const id in target) v[id] = target[id].map((b, i) => lerp(from[id][i], b, t));
      now.current = v;
      const [x, y, w, h, rx, thick] = v.card;
      const plane = { th: v.card[6], pv: v.card[7], fv: v.card[8], z: v.card[9] };
      const m = matrixOf(plane);
      const back = backOf(plane, thick);
      for (const [key, mm] of [["card", m], ["card-back", [...m.slice(0, 4), m[4] + back[0], m[5] + back[1]] as M], ["card-shadow", [...m.slice(0, 4), m[4] + 6, m[5] + 12] as M]] as const) {
        const el = els[key];
        el.setAttribute("x", String(x));
        el.setAttribute("y", String(y));
        el.setAttribute("width", String(w));
        el.setAttribute("height", String(h));
        el.setAttribute("rx", String(rx));
        el.setAttribute("transform", mstr(mm));
      }
      const f = Math.min(1, Math.max(0, plane.th / 90));
      const hd = headOf(m, plane, [x, y, w, h], HEAD.depth * f);
      const g = root.querySelector<SVGGElement>("[data-head]")!;
      g.style.opacity = String(f * f * f); // the head fades in late and leaves early, so it never overlaps the next shape
      g.querySelector("[data-head-top]")!.setAttribute("points", poly(hd.top));
      g.querySelector("[data-head-side]")!.setAttribute("points", poly(hd.side));
      const [ax, ay] = hd.antenna;
      g.querySelector("[data-head-stalk]")!.setAttribute("d", `M${ax} ${ay}V${ay - 26 * f}`);
      g.querySelector("[data-head-ball]")!.setAttribute("transform", `translate(${ax} ${ay - 30 * f})`);
      g.querySelectorAll("[data-head-bolt]").forEach((el, i) => el.setAttribute("transform", `translate(${hd.bolts[i][0]} ${hd.bolts[i][1]})`));
      for (const key of ["base", "neck"] as const) {
        const bx = boxOf(HEAD[key], HEAD.depth * f * (key === "neck" ? 0.6 : 1));
        g.querySelector(`[data-${key}-top]`)!.setAttribute("points", poly(bx.top));
        g.querySelector(`[data-${key}-side]`)!.setAttribute("points", poly(bx.side));
      }
      root.querySelector("[data-head-face]")!.setAttribute("transform", mstr(m));
      (root.querySelector("[data-head-face]") as SVGGElement).style.opacity = String(f * f * f);
      for (const id of IDS) {
        const el = els[id];
        const [bx, by, bw, bh, lift] = v[id];
        el.setAttribute("x", String(bx));
        el.setAttribute("y", String(by));
        el.setAttribute("width", String(Math.max(0, bw)));
        el.setAttribute("height", String(bh));
        el.setAttribute("transform", mstr(matrixOf(plane, lift)));
      }
    };
    if (still) return write(1);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 700);
      write(ease(p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [k, svg, still]);
}

/** A deco drawn on a state's sheet. */
const OnSheet = ({ s, lift = 0, children }: { s: number; lift?: number; children: React.ReactNode }) => <g transform={mstr(matrixOf(STATES[s].plane, lift))}>{children}</g>;

/** Upright text at a sheet point: words stay level and readable while the drawing is isometric. */
function Label({ s, u, v, lift = 0, text, color, dx = 0, dy = 0, anchor = "start" }: { s: number; u: number; v: number; lift?: number; text: string; color?: string; dx?: number; dy?: number; anchor?: "start" | "middle" | "end" }) {
  const [x, y] = at(s, u, v, lift);
  return <text x={x + dx} y={y + dy} textAnchor={anchor} className="j-text mono" style={color ? { fill: color } : undefined}>{text}</text>;
}

function Figure({ k, still }: { k: number; still: boolean }) {
  const svg = useRef<SVGSVGElement>(null);
  useMorph(k, svg, still);
  const on = (...ks: number[]) => ({ className: "j-deco", "data-states": ks.join(" ") });
  return (
    <div className="lp-jfig">
      <div className="lp-jcount mono num" aria-live="polite">{COUNTER[k]}</div>
      <svg ref={svg} viewBox={VB.join(" ")} role="img" aria-label={`${STEPS[k].name}: ${COUNTER[k]}`}>
        <defs>
          <filter id="j-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8" /></filter>
          <filter id="j-blur-s" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3" /></filter>
        </defs>
        {/* the robot's base, neck and head: they grow back out of the sheet (opacity and depth follow the tween) */}
        <g data-head style={{ opacity: 0 }}>
          <rect x={HEAD.base[0] + 8} y={HEAD.base[1] + 8} width={HEAD.base[2]} height={HEAD.base[3]} rx="3" className="j-halo" filter="url(#j-blur-s)" />
          {(["base", "neck"] as const).map((key) => (
            <g key={key}>
              <polygon {...{ [`data-${key}-side`]: true }} className="j-side-dark j-edge" />
              <polygon {...{ [`data-${key}-top`]: true }} className="j-paper-top j-edge" />
              <rect x={HEAD[key][0]} y={HEAD[key][1]} width={HEAD[key][2]} height={HEAD[key][3]} rx="2" className="j-side j-edge" />
            </g>
          ))}
          <polygon data-head-side className="j-side-dark j-edge" />
          <polygon data-head-top className="j-paper-top j-edge" />
          <path data-head-stalk className="j-edge" />
          <circle data-head-ball r="4.5" className="j-ink" />
          {[0, 1, 2, 3].map((i) => <circle key={i} data-head-bolt r="1.3" className="j-dot" />)}
        </g>
        {/* docs stacked behind the page */}
        <g {...on(0)}>
          {DOC_STACK.map(([dx, dy], i) => (
            <g key={i} transform={`translate(${dx} ${dy})`}>
              <rect x={DOC[0] + 2.2} y={DOC[1] - 1.7} width={DOC[2]} height={DOC[3]} rx="4" className="j-side-dark j-edge" />
              <rect x={DOC[0]} y={DOC[1]} width={DOC[2]} height={DOC[3]} rx="4" className="j-paper j-edge" />
              {[0, 1, 2, 3, 4, 5].map((r) => <rect key={r} x={DOC[0] + 22} y={DOC[1] + 22 + r * 15.5} width={[100, 176, 148, 186, 130, 166][r]} height="6" rx="2" className="j-faint" />)}
            </g>
          ))}
        </g>
        {/* the sheet, with its thickness */}
        <rect data-bar="card-shadow" className="j-halo" filter="url(#j-blur)" />
        <rect data-bar="card-back" className="j-side-dark j-edge" />
        <rect data-bar="card" className="j-paper j-edge" />
        {/* robot face: a visor and a support headset, carried with the sheet */}
        <g data-head-face style={{ opacity: 0 }}>
          <rect x="140" y="60" width="140" height="34" rx="17" className="j-visor j-edge" />
          <rect x="164" y="74" width="92" height="6" rx="3" className="j-visor-line" />
          <path d="M112 98 C112 -6, 308 -6, 308 98" className="j-band-o" />
          <path d="M112 98 C112 -6, 308 -6, 308 98" className="j-band-i" />
          <path d="M114 138 Q114 200 150 204" className="j-band-o" />
          <path d="M114 138 Q114 200 150 204" className="j-band-i" />
          <rect x="146" y="198" width="18" height="12" rx="6" className="j-ink" />
          {[100, 296].map((x) => (
            <g key={x}>
              <rect x={x} y="88" width="24" height="52" rx="9" className="j-side-dark j-edge" />
              <rect x={x + (x < 200 ? 14 : 0)} y="96" width="10" height="36" rx="4" className="j-paper j-edge" />
            </g>
          ))}
        </g>
        {/* doc page: folded corner */}
        <g {...on(0)}>
          <OnSheet s={0}><path d={`M${DOC[0] + DOC[2] - 20} ${DOC[1]} L${DOC[0] + DOC[2]} ${DOC[1] + 20} L${DOC[0] + DOC[2] - 20} ${DOC[1] + 20} Z`} className="j-side j-edge" /></OnSheet>
        </g>
        {/* prompt file: header, size cap, the fact that floated off */}
        <g {...on(1)}>
          <OnSheet s={1}>
            <line x1="80" y1="50" x2="320" y2="50" className="j-edge" />
            <line x1="80" y1="268" x2="320" y2="268" className="j-edge" strokeDasharray="4 4" style={{ stroke: "var(--f-spec)" }} />
            <rect x="294" y="162" width="64" height="8" rx="3" className="j-halo" filter="url(#j-blur-s)" />
          </OnSheet>
          <Label s={1} u={90} v={44} text="</>" />
          <Label s={1} u={320} v={268} text="size cap" color="var(--f-spec)" dx={4} dy={4} />
          <Label s={1} u={326} v={166} lift={12} text="rule recall" color="var(--f-recall)" dy={13} />
        </g>
        {/* chat window: title bar, prompt panel, floating bubbles */}
        <g {...on(3)}>
          <OnSheet s={3}>
            <line x1="40" y1="56" x2="360" y2="56" className="j-edge" />
            {[54, 64, 74].map((cx) => <circle key={cx} cx={cx} cy="46" r="3" className="j-side-dark j-edge" />)}
            <line x1="140" y1="56" x2="140" y2="284" className="j-edge" />
            {BUBBLES.map((b, i) => <rect key={i} x={b.box[0] + 3} y={b.box[1] + 3} width={b.box[2]} height={b.box[3]} rx="10" className="j-halo" filter="url(#j-blur-s)" />)}
          </OnSheet>
          <OnSheet s={3} lift={LIFT}>
            {BUBBLES.map((b, i) => (
              <rect key={i} x={b.box[0]} y={b.box[1]} width={b.box[2]} height={b.box[3]} rx="10" className={`j-edge ${b.who === "agent" ? "j-bubble-agent" : "j-paper"}`} strokeDasharray={b.dashed ? "4 4" : undefined} />
            ))}
          </OnSheet>
          <Label s={3} u={156} v={180} lift={LIFT} text="customer recall" color="var(--f-customer)" dx={4} dy={13} />
        </g>
        {/* checklist */}
        <g {...on(4)}>
          <OnSheet s={4}>
            <rect x={CLIP[0] + 12} y={CLIP[1] + 20} width={CLIP[2] - 24} height={CLIP[3] - 32} rx="3" className="j-paper j-edge" />
            {ROWS.slice(0, -1).map((r, i) => <line key={r.id} x1={CLIP[0] + 24} x2={CLIP[0] + CLIP[2] - 24} y1={rowY(i) + 23} y2={rowY(i) + 23} className="j-groove" />)}
            <rect x={CLIP[0] + CLIP[2] / 2 - 38} y={CLIP[1] - 8} width="76" height="30" rx="7" className="j-side-dark j-edge" />
            <rect x={CLIP[0] + CLIP[2] / 2 - 16} y={CLIP[1] - 18} width="32" height="18" rx="9" className="j-paper j-edge" />
            <circle cx={CLIP[0] + CLIP[2] / 2} cy={CLIP[1] - 9} r="4" className="j-side-dark j-edge" />
            {ROWS.map((r, i) => <rect key={r.id} x="114" y={rowY(i) - 3.5} width="14" height="14" rx="3" className="j-paper j-edge" />)}
          </OnSheet>
          {ROWS.map((r, i) => {
            const [cx, cy] = at(4, 121, rowY(i) + 3.5);
            return (
              <g key={r.id}>
                <path d={r.ok ? `M${cx - 5} ${cy} l3.5 3.5 l7 -7.5` : `M${cx - 4} ${cy - 4} l8 8 M${cx + 4} ${cy - 4} l-8 8`} className="j-mark" style={{ stroke: r.ok ? "var(--ink)" : r.color }} />
                {r.term && <Label s={4} u={140 + r.w} v={rowY(i) + 3.5} text={r.term} color={r.color} dx={10} dy={4} />}
              </g>
            );
          })}
        </g>
        {IDS.map((id) => <rect key={id} data-bar={id} rx="2" className="j-bar" />)}
      </svg>
    </div>
  );
}

function useStill() {
  const [r, setR] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}

export function Journey({ onFailure }: { onFailure: (g: FailureGroup) => void }) {
  const [k, setK] = useState(0);
  const still = useStill();
  const steps = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    // A step is active while it crosses the middle band of the viewport; on a phone the pinned figure covers the top
    // half, so the band sits lower, where the step's text first shows below the figure.
    const phone = matchMedia("(max-width: 1023px)").matches;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setK(Number((e.target as HTMLElement).dataset.k))),
      { rootMargin: phone ? "-62% 0px -33% 0px" : "-45% 0px -50% 0px" },
    );
    steps.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <div className="lp-journey">
      <div className="lp-jstick"><Figure k={k} still={still} /></div>
      <ol className="lp-jsteps">
        {STEPS.map((s, i) => (
          <li key={s.name} ref={(el) => void (steps.current[i] = el)} data-k={i} data-on={i === k || undefined} className="lp-jstep">
            <div className="caps muted num">{String(i + 1).padStart(2, "0")} / 05</div>
            <h3 className="mt-1.5 text-[24px]">{s.name}</h3>
            <p className="muted mt-2 text-[16px] leading-[1.55]">{s.body}</p>
            {s.tags.length > 0 && (
              <ul className="mt-4 space-y-2">
                {s.tags.map((t) => {
                  const g = GROUPS.find((x) => x.group === t.group)!;
                  return (
                    <li key={t.group} className="text-[14px] leading-[1.45]">
                      <button type="button" className="lp-fail" style={{ ["--c" as string]: g.color }} onClick={() => onFailure(t.group)} title="See it in the failure chart">
                        <span className="size-2 rounded-full" style={{ background: g.color }} />
                        {g.term}
                      </button>
                      <span className="muted ml-2">{t.gloss}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
