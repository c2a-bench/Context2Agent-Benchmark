import { useRunSummary } from "@/pages/research";

/** RQ5 · knowledge conditions: how much worse each doc packaging does than the complete pack (support-agent-knowledge). */
export default function Rq5Page() {
  const { kCond, complete, parts } = useRunSummary();
  const applies = complete?.qk != null && kCond.length > 1;
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Knowledge conditions</h1>
      {applies ? (
        parts.rq5
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          RQ5 does not apply to this run: it builds one agent per stage from changing docs, not one per packaging of the same
          docs. The knowledge-condition runs are support-agent-knowledge.
        </p>
      )}
    </div>
  );
}
