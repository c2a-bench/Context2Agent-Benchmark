/** Scale and calculation of each doc recall number (tests/doc_recall.py), shown under the doc recall tables. */
const ROWS: { name: string; scale: string; how: string }[] = [
  {
    name: "recall",
    scale: "0–1",
    how: "Per ticket: needed docs reached ÷ needed docs. The step's value is the mean over tickets. 1 = every doc the ticket needs was in the model's prompts.",
  },
  {
    name: "precision",
    scale: "0–1, higher = more focused",
    how: "Per ticket: needed docs reached ÷ every company doc page reached (split pages count as their original page). Mean over tickets. Low = the agent sends many docs the ticket does not need, e.g. the whole knowledge base in every prompt.",
  },
  {
    name: "kept",
    scale: "0–1",
    how: "Per ticket: needed docs whose text is anywhere in the agent's own files ÷ needed docs. Mean over tickets. A doc that was never kept cannot reach the model.",
  },
  {
    name: "all needed docs reached",
    scale: "tickets / tickets",
    how: "Tickets with recall 1.",
  },
  {
    name: "failed, doc missing",
    scale: "tickets / failed tickets",
    how: "Failed tickets with at least one needed doc not reached: the knowledge never got to the model. The rest of the failed tickets had every doc and still got it wrong.",
  },
  {
    name: "passed, doc missing",
    scale: "tickets / passed tickets",
    how: "Passed tickets with a needed doc not reached: the agent used its own rewrite of the docs, or general knowledge.",
  },
  {
    name: "trap page reached",
    scale: "tickets, lower is better",
    how: "Tickets where a decoy page of the ticket's rules (old version, draft, look-alike) reached the model, other than a needed page.",
  },
];

export function DocRecallLegend() {
  return (
    <details className="mt-3 rounded-lg border px-3 py-2 font-sans text-xs">
      <summary className="cursor-pointer font-medium">How it&apos;s calculated</summary>
      <p className="mt-2 text-muted-foreground">
        <span className="font-medium text-foreground">Needed docs</span> are the ticket&apos;s expected_doc_ids (else the
        source pages of its rules). A doc <span className="font-medium text-foreground">reached</span> the model on a
        ticket when its own text is in the prompts the agent sent for that ticket: at least 2 of its 12-word snippets (one
        taken every 25 words, so about 300 characters of the doc), or one rule sentence that lives on that page. Tickets
        where the agent made no model call are left out.
      </p>
      <table className="mt-2 w-full">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">number</th>
            <th className="py-1.5 pr-3 font-medium">scale</th>
            <th className="py-1.5 font-medium">calculation</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.name} className="border-b border-border/60 align-top">
              <td className="py-1.5 pr-3 font-mono">{r.name}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{r.scale}</td>
              <td className="py-1.5">{r.how}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-muted-foreground">
        Limit: this matches the docs&apos; own text. Knowledge the agent rewrote in its own words (a distilled system
        prompt) does not count as reached, so an agent can pass with low recall. Compare with &quot;passed, doc
        missing&quot;.
      </p>
    </details>
  );
}
