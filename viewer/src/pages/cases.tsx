import { use } from "react";
import Link, { TextLink } from "@/components/link";
import { DocLink } from "@/components/doc-sheet";
import { getDocs } from "@/lib/data";
import { INFO_TYPES, REPLAY_VERDICTS } from "@/lib/format";
import type { CaseVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-xl border bg-card px-4 py-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="mt-2 text-[13.5px]">{children}</div>
    </section>
  );
}

function Chip({ className, children, title }: { className?: string; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("mr-1.5 inline-block rounded px-1.5 py-0.5 text-[11px]", className ?? "bg-muted text-muted-foreground")}>{children}</span>;
}

/** A field path of the ticket's pass criteria, shortened: "tickets.SUP-4121.labels" → "labels". */
const field = (k: string) => k.replace(/^tickets\.[^.]+\./, "").replace(/^api_keys\./, "API key ");
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function PassCriteria({ v }: { v: CaseVersion }) {
  const p = v.pass as Record<string, unknown>;
  const rows: [string, React.ReactNode][] = [];
  for (const [k, val] of Object.entries((p.expect as Record<string, unknown>) ?? {})) rows.push([`${field(k)} is`, show(val)]);
  for (const [k, val] of Object.entries((p.contains as Record<string, unknown>) ?? {})) rows.push([`${field(k)} include`, (val as unknown[]).map(show).join(", ")]);
  for (const [k, val] of Object.entries((p.not_contains as Record<string, unknown>) ?? {})) rows.push([`${field(k)} must not include`, (val as unknown[]).map(show).join(", ")]);
  for (const [k, val] of Object.entries((p.must_not as Record<string, unknown>) ?? {})) rows.push([`${field(k)} must not be`, (val as unknown[]).map(show).join(", ")]);
  if (Array.isArray(p.unchanged) && p.unchanged.length) rows.push(["stays unchanged", (p.unchanged as unknown[]).map(show).join(", ")]);
  for (const c of (p.required_calls as unknown[]) ?? []) rows.push(["required call", show(c)]);
  for (const c of (p.forbidden_calls as unknown[]) ?? []) rows.push(["forbidden call", show(c)]);
  return (
    <>
      <div className="text-xs text-muted-foreground">Final state and actions</div>
      <table className="mt-1 w-full">
        <tbody>
          {rows.map(([k, val], i) => (
            <tr key={i} className="border-b border-border/60 align-top">
              <td className="py-1.5 pr-3 text-muted-foreground">{k}</td>
              <td className="py-1.5 font-mono text-[12px]">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-xs text-muted-foreground">What the agent tells the customer (checked in its replies)</div>
      <ul className="mt-1 list-disc pl-4">{v.reply_checks.map((c) => <li key={c}>{c}</li>)}</ul>
    </>
  );
}

/** Word-level diff of two texts (longest common subsequence over words): [kind, word] with kind same / del / add. */
function wordDiff(a: string, b: string): ["same" | "del" | "add", string][] {
  const x = a.split(/\s+/), y = b.split(/\s+/);
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: ["same" | "del" | "add", string][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(["same", x[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["del", x[i++]]);
    else out.push(["add", y[j++]]);
  }
  while (i < n) out.push(["del", x[i++]]);
  while (j < m) out.push(["add", y[j++]]);
  return out;
}

function Diff({ a, b }: { a: string; b: string }) {
  return (
    <span>
      {wordDiff(a, b).map(([k, w], i) => (
        <span key={i} className={k === "del" ? "bg-rose-500/15 text-rose-700 line-through dark:text-rose-300" : k === "add" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : undefined}>
          {w}{" "}
        </span>
      ))}
    </span>
  );
}

/** A version's pass criteria as flat "what is checked → value" pairs, so two versions can be compared. */
function criteria(v: CaseVersion): Map<string, string> {
  const p = v.pass as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const [k, val] of Object.entries((p.expect as Record<string, unknown>) ?? {})) out.set(`${field(k)} is`, show(val));
  for (const key of ["contains", "not_contains", "must_not"] as const) {
    const verb = key === "contains" ? "include" : key === "not_contains" ? "must not include" : "must not be";
    for (const [k, val] of Object.entries((p[key] as Record<string, unknown[]>) ?? {})) out.set(`${field(k)} ${verb}`, (val ?? []).map(show).sort().join(", "));
  }
  if (Array.isArray(p.unchanged)) out.set("stays unchanged", (p.unchanged as unknown[]).map(show).sort().join(", "));
  for (const key of ["required_calls", "forbidden_calls"] as const)
    if (Array.isArray(p[key]) && (p[key] as unknown[]).length) out.set(key === "required_calls" ? "required calls" : "forbidden calls", (p[key] as unknown[]).map(show).sort().join(" · "));
  return out;
}

/** How the ticket changes from one stage to the next: pass criteria, rules, customer facts, behavior. */
function AcrossStages({ versions, current }: { versions: CaseVersion[]; current: string }) {
  if (versions.length < 2) return null;
  return (
    <Section title="Across stages">
      <div className="grid gap-4">
        {versions.map((v, i) => {
          const prev = i ? versions[i - 1] : null;
          const changes: React.ReactNode[] = [];
          if (prev) {
            const a = criteria(prev), b = criteria(v);
            for (const k of new Set([...a.keys(), ...b.keys()])) {
              if (a.get(k) === b.get(k)) continue;
              changes.push(<li key={`c${k}`}><span className="text-muted-foreground">{k}: </span><Diff a={a.get(k) ?? "—"} b={b.get(k) ?? "—"} /></li>);
            }
            const ra = new Map(prev.rules.map((r) => [r.id, r.text])), rb = new Map(v.rules.map((r) => [r.id, r.text]));
            for (const id of new Set([...ra.keys(), ...rb.keys()])) {
              const x = ra.get(id), y = rb.get(id);
              if (x === y) continue;
              changes.push(
                <li key={`r${id}`}>
                  <span className="mr-1 font-mono text-[11px]">{id}</span>
                  {x == null ? <span className="text-emerald-700 dark:text-emerald-300">now needed: {y}</span>
                    : y == null ? <span className="text-muted-foreground line-through">no longer needed</span>
                    : <Diff a={x} b={y} />}
                </li>,
              );
            }
            const fa = new Map(prev.facts.map((f) => [f.text, f.decisive])), fb = new Map(v.facts.map((f) => [f.text, f.decisive]));
            for (const t of fb.keys()) if (!fa.has(t)) changes.push(<li key={`fa${t}`}><span className="text-muted-foreground">customer fact added: </span>{t}</li>);
            for (const t of fa.keys()) if (!fb.has(t)) changes.push(<li key={`fd${t}`}><span className="text-muted-foreground">customer fact removed: </span><span className="line-through">{t}</span></li>);
            for (const [t, d] of fb) if (fa.has(t) && fa.get(t) !== d) changes.push(<li key={`fx${t}`}><span className="text-muted-foreground">now {d ? "decisive" : "not decisive"}: </span>{t}</li>);
            if (prev.tags.behavior !== v.tags.behavior) changes.push(<li key="beh"><span className="text-muted-foreground">customer behavior: </span>{prev.tags.behavior ?? "—"} → {v.tags.behavior ?? "—"}</li>);
          }
          return (
            <div key={v.step} className={cn("rounded-lg border px-3 py-2", v.step === current && "border-foreground/40")}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{v.step}</span>
                {v.tags.type && <Chip title={v.tags.type}>{v.tags.type}</Chip>}
                {v.tags.change_type && v.tags.change_type !== "none" && <Chip>change: {v.tags.change_type}</Chip>}
                {v.result && <span className={v.result.passed ? "text-emerald-600" : "text-rose-600"}>{v.result.passed ? "✓ passed" : "✗ failed"}</span>}
              </div>
              {!prev ? (
                <p className="mt-1 text-xs text-muted-foreground">First appears here.</p>
              ) : changes.length ? (
                <ul className="mt-1.5 grid gap-1 text-[13px]">{changes}</ul>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">No change from {prev.step}: same pass criteria, rules and customer facts.</p>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** One ticket as the grader defines it, at one stage: the ticket, customer facts, rules with their real and trap pages,
 *  pass criteria, tags, and how it changes across stages. `stageHref` and `conversationHref` let the page that shows it
 *  say where those links go. */
export function CaseDetail({ id, versions, step, job, stageOf, stageHref, conversationHref }: { id: string; versions: CaseVersion[]; step: string; job: string; stageOf: (s: string) => number; stageHref: (step: string) => string; conversationHref: string }) {
  const docs = use(getDocs(job));
  const v = versions.find((x) => x.step === step) ?? versions[0];
  const stage = stageOf(v.step);
  const title = (p: string) => docs[String(stage)]?.[p]?.title ?? p.split("/").pop()!.replace(/\.json$/, "");
  const t = v.tags;
  return (
    <div className="mx-auto max-w-3xl px-4 pt-6 pb-32 sm:px-8 sm:pt-8">
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-xl font-semibold">{id}</h1>
        {v.result && (
          <Chip className={v.result.passed ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/15 text-rose-700 dark:text-rose-300"}>
            {v.result.passed ? "passed in this run" : "failed in this run"}
          </Chip>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{v.title} · ticket {v.ticket}</p>

      <Section title="Stages it appears in">
        <div className="flex flex-wrap gap-1.5">
          {versions.map((x) => (
            <Link
              key={x.step}
              href={stageHref(x.step)}
              preventScrollReset
              className={cn("rounded px-2 py-1 text-xs", x.step === v.step ? "bg-foreground text-background" : "border hover:bg-muted")}
            >
              {x.step}
              {x.result && <span className="ml-1.5">{x.result.passed ? "✓" : "✗"}</span>}
              {x.tags.type && <span className="ml-1.5 opacity-70">{x.tags.type}</span>}
            </Link>
          ))}
        </div>
        {v.result && (
          <p className="mt-2 text-xs text-muted-foreground">
            This run, {v.step}: {v.result.passed ? "passed" : "failed"}
            {v.result.verdict && ` · ${REPLAY_VERDICTS[v.result.verdict]?.label ?? v.result.verdict}`} ·{" "}
            <TextLink href={conversationHref}>see the conversation</TextLink>
          </p>
        )}
      </Section>

      <AcrossStages versions={versions} current={v.step} />

      <Section title="Ticket">
        <div className="whitespace-pre-wrap rounded-lg border bg-background px-3 py-2">{v.opening}</div>
        <p className="mt-2 text-muted-foreground">
          Customer <span className="font-mono text-[12px]">{v.customer.id}</span>
          {v.customer.name && ` (${v.customer.name})`}
          {v.customer.tier && ` · tier ${v.customer.tier}`}
          {v.customer.deployments.length > 0 && ` · deployments ${v.customer.deployments.map((d) => `${d.deployment} ${d.region}`).join(", ")}`}
        </p>
        <div className="mt-2 text-xs text-muted-foreground">What this ticket tests</div>
        <p>{v.test}</p>
        {v.matters && <p className="mt-1 text-muted-foreground">{v.matters}</p>}
      </Section>

      <Section title="Customer facts">
        {v.brief && <p className="mb-2 text-muted-foreground">Customer&apos;s private brief: {v.brief}</p>}
        <ul className="grid gap-1.5">
          {v.facts.map((f) => (
            <li key={f.text}>
              <Chip className={f.decisive ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : undefined}>{f.decisive == null ? "not classified" : f.decisive ? "decisive" : "not decisive"}</Chip>
              {f.text}
              {(f.why || (f.decides && f.decides.length > 0)) && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {f.why}
                  {f.decides && f.decides.length > 0 && <> · decides {f.decides.map((d) => <Chip key={d}>{d}</Chip>)}</>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Rules needed to solve it">
        <ul className="grid gap-3">
          {v.rules.map((r) => (
            <li key={r.id}>
              <span className="mr-1.5 font-mono text-[12px] font-semibold">{r.id}</span>
              {r.text}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {r.real.map((p) => (
                  <span key={p}>
                    <Chip className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">real page</Chip>
                    <DocLink doc={{ path: p, title: title(p) }} stage={stage} quote={r.quote || undefined} kind="real" />
                  </span>
                ))}
                {r.traps.map((p) => (
                  <span key={p}>
                    <Chip className="bg-amber-500/15 text-amber-700 dark:text-amber-300">trap page</Chip>
                    <DocLink doc={{ path: p, title: title(p) }} stage={stage} quote={r.trap_quote || undefined} kind="trap" />
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
        {/* A table rule (priority, reply times) is checked as one cell for this ticket; other rules are one fact each. */}
        {v.rule_facts.some((f) => f.id.includes(".")) && (
          <>
            <div className="mt-3 text-xs text-muted-foreground">Table cells this ticket needs (what the judge checks for the table rules)</div>
            <ul className="mt-1 grid gap-1">
              {v.rule_facts.filter((f) => f.id.includes(".")).map((f) => (
                <li key={f.id}><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{f.id}</span>{f.text}</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Pass criteria">
        <PassCriteria v={v} />
      </Section>

      <Section title="Tags">
        {t.group && <Chip title="what the ticket tests">{t.group}</Chip>}
        {t.type && <Chip title="against earlier stages">{t.type}</Chip>}
        {t.behavior && <Chip title="how the customer behaves">{t.behavior}</Chip>}
        {t.info_type != null && <Chip title="where the answer comes from">{t.info_type}. {INFO_TYPES[String(t.info_type)] ?? ""}</Chip>}
        {t.change_type && <Chip title="the doc change it tests">change: {t.change_type}</Chip>}
        {t.twin && <Chip title="same opening, different answer">twin: {t.twin}</Chip>}
        {t.prompt_cap_tokens && <Chip title="the agent's prompt is capped">prompt cap {t.prompt_cap_tokens} tokens</Chip>}
      </Section>
    </div>
  );
}

/** What a ticket checks, by its pass criteria: fields, labels, calls. */
export function checks(v: CaseVersion): string[] {
  const p = v.pass as Record<string, unknown>;
  const out = Object.keys((p.expect as object) ?? {}).map(field);
  for (const k of ["contains", "not_contains", "must_not"]) out.push(...Object.keys((p[k] as object) ?? {}).map(field));
  const calls = JSON.stringify([p.required_calls ?? [], p.forbidden_calls ?? []]);
  if (calls.includes("/handoffs")) out.push("handoff");
  if (calls.includes("/api_keys")) out.push("API key action");
  if (calls.includes("/credits")) out.push("credit");
  if (calls.includes("/comments")) out.push("comment");
  // What must stay unchanged (credits, API keys) is checked too.
  for (const u of (p.unchanged as string[]) ?? []) out.push(u === "credits" ? "credit" : u === "api_keys" ? "API key status" : u);
  return [...new Set(out.map((x) => (x.startsWith("API key ") ? "API key status" : x)))];
}
