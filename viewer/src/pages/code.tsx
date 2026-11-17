import { use } from "react";
import { useJob, useQuery } from "@/lib/route";
import Link from "@/components/link";
import { ArrowRight } from "lucide-react";
import { getCode } from "@/lib/data";
import { StageView } from "@/components/stage-view";
import { DeltaView } from "@/components/delta-view";
import { cn } from "@/lib/utils";

export default function CodePage() {
  const job = useJob();
  const q = useQuery();
  const code = use(getCode(job));
  const v = typeof q.v === "string" ? q.v : "d2";
  const isDelta = v.startsWith("d");
  const n = Number(v.slice(1));
  const stage = code.stages.find((s) => s.stage === n) ?? code.stages[0];
  const transition = code.transitions.find((t) => t.to === n);
  const file = typeof q.f === "string" ? q.f : undefined;

  if (!code.stages.length) {
    return <p className="px-6 py-12 text-sm text-muted-foreground">This run has no agent code to show (no stage kept its agent).</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-stretch gap-1.5 overflow-x-auto border-b px-6 py-3">
        {code.stages.map((s, i) => {
          const t = code.transitions.find((x) => x.to === s.stage);
          const pct = s.score.total ? (100 * (s.score.passed ?? 0)) / s.score.total : 0;
          return (
            <div key={s.stage} className="flex items-stretch gap-1">
              {i > 0 && t && (
                <>
                  <ArrowRight className="size-4 self-center text-muted-foreground/60" />
                  <Link href={`?v=d${s.stage}`} className={cn("rounded-lg border border-dashed px-3 py-1.5 text-xs transition-colors hover:bg-muted", isDelta && n === s.stage && "border-solid border-foreground bg-muted")}>
                    <div className="font-medium">What changed {t.from} → {t.to}</div>
                    <div className="text-muted-foreground">{t.docChanges.length + t.newDocs.length} docs · {t.ruleChanges.length} rules · {t.files.length} files</div>
                  </Link>
                  <ArrowRight className="size-4 self-center text-muted-foreground/60" />
                </>
              )}
              <Link href={`?v=s${s.stage}`} className={cn("min-w-36 rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-muted", !isDelta && n === s.stage && "border-foreground bg-muted")}>
                <div className="font-medium">Stage {s.stage} agent</div>
                <div className="text-muted-foreground tabular-nums">{s.files.length} files · {s.score.passed}/{s.score.total} passed</div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-muted"><div className="h-full bg-foreground/70" style={{ width: `${pct}%` }} /></div>
              </Link>
            </div>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {isDelta && transition ? (
          <DeltaView key={v} t={transition} before={code.stages.find((s) => s.stage === transition.from)!} after={stage} file={file} />
        ) : (
          <StageView key={v} s={stage} file={file} />
        )}
      </div>
    </div>
  );
}
