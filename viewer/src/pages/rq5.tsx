import { useRunSummary } from "@/pages/research";

/** RQ5 · knowledge conditions: how much worse each doc packaging does than the complete pack (support-agent-knowledge). */
export default function Rq5Page() {
  const { kCond, complete, parts } = useRunSummary();
  const applies = complete?.qk != null && kCond.length > 1;
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-heading text-3xl font-normal tracking-tight">Doc packaging</h1>
      {applies ? (
        <>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            The same {complete?.total ?? ""} tickets, with the same docs packaged five ways: complete, fragmented, incomplete,
            conflicting and noisy. The builder builds a new agent from each.
          </p>
          {parts.rq5}
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          This run builds its agent from docs that change stage by stage, not from different packagings of the same docs.
          Doc packaging is compared in the Support Agent Knowledge runs.
        </p>
      )}
    </div>
  );
}
