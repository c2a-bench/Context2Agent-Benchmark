import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import type { Doc } from "@/lib/types";
import { getDoc } from "@/lib/data";
import { LinkIcon } from "@/components/link";

type Kind = "real" | "trap" | undefined;
type Req = { path: string; stage: number; quote?: string; kind?: Kind };
const Ctx = createContext<(r: Req) => void>(() => {});
export const useDoc = () => useContext(Ctx);

const START = "⟦", END = "⟧";

// Wrap the quoted line in START/END markers so the remark plugin can turn it into <mark>.
function markQuote(text: string, quote?: string, kind: Kind = "real"): [string, boolean] {
  if (!quote) return [text, false];
  const open = `${START}${kind}${END}`, close = `${START}/${END}`;
  const i = text.toLowerCase().indexOf(quote.toLowerCase());
  if (i >= 0) return [text.slice(0, i) + open + text.slice(i, i + quote.length) + close + text.slice(i + quote.length), true];
  // Tolerate markdown bold and spacing: match the first words, mark to end of line.
  const words = quote.replace(/\*\*/g, "").split(/\s+/).filter(Boolean).slice(0, 6).join(" ").toLowerCase();
  const plain = text.replace(/\*\*/g, "");
  const j = plain.toLowerCase().indexOf(words);
  if (j < 0 || !words) return [text, false];
  const end = plain.indexOf("\n", j);
  return [plain.slice(0, j) + open + plain.slice(j, end < 0 ? undefined : end) + close + (end < 0 ? "" : plain.slice(end)), true];
}

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };
function remarkMark() {
  const re = new RegExp(`(${START}(?:real|trap)${END}|${START}/${END})`);
  const walk = (parent: Node) => {
    if (!parent.children) return;
    const out: Node[] = [];
    let mark: Node | null = null;
    for (const child of parent.children) {
      if (child.type === "text" && child.value && re.test(child.value)) {
        for (const part of child.value.split(re)) {
          if (part.startsWith(START) && part !== `${START}/${END}`) {
            const kind = part.slice(1, -1);
            mark = { type: "emphasis", data: { hName: "mark", hProperties: { className: kind === "trap" ? "trap" : "real" } }, children: [] };
            out.push(mark);
          } else if (part === `${START}/${END}`) mark = null;
          else if (part) (mark ? mark.children! : out).push({ type: "text", value: part });
        }
        continue;
      }
      walk(child);
      (mark ? mark.children! : out).push(child);
    }
    parent.children = out;
  };
  return (tree: Node) => walk(tree);
}

export function DocProvider({ job, children }: { job: string; children: React.ReactNode }) {
  const [req, setReq] = useState<Req | null>(null);
  const [doc, setDoc] = useState<Doc | null | "missing">(null);
  const body = useRef<HTMLDivElement>(null);
  const open = useCallback((r: Req) => {
    setDoc(null);
    setReq(r);
  }, []);

  useEffect(() => {
    if (!req) return;
    getDoc(job, req.stage, req.path)
      .then((d) => d ?? ("missing" as const), () => "missing" as const)
      .then(setDoc);
  }, [req, job]);

  const [text, found] = doc && doc !== "missing" ? markQuote(doc.text, req?.quote, req?.kind) : ["", false];
  useEffect(() => {
    const m = body.current?.querySelector("mark");
    if (m) setTimeout(() => m.scrollIntoView({ block: "center", behavior: "instant" }), 0);
  }, [text]);

  return (
    <Ctx.Provider value={open}>
      {children}
      <Sheet open={!!req} onOpenChange={(o) => !o && setReq(null)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
          <SheetHeader className="border-b px-6 py-4">
            <div className="flex flex-wrap gap-1.5">
              {req?.kind === "real" && <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">Real page</Badge>}
              {req?.kind === "trap" && <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">Trap page</Badge>}
              {req && <Badge variant="secondary">as of stage {req.stage}</Badge>}
            </div>
            <SheetTitle className="pr-8 text-lg">{doc && doc !== "missing" ? doc.title : doc === "missing" ? "Page not found" : "Loading…"}</SheetTitle>
            <SheetDescription>
              {doc && doc !== "missing" && (
                <>
                  {doc.status} · {doc.updated}
                  {doc.author && ` · ${doc.author}`}
                  {doc.born ? ` · added in stage ${doc.born}` : ""}
                  {doc.edited ? ` · edited in stage ${doc.edited}` : ""}
                  <span className="mt-1 block font-mono text-[11px]">{req?.path}</span>
                </>
              )}
            </SheetDescription>
          </SheetHeader>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {req?.quote && doc && doc !== "missing" && (
              <div className="mb-4 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {found ? "Highlighted" : "Could not find"} the line the rule {req.kind === "trap" ? "says is wrong" : "comes from"}: “{req.quote}”
              </div>
            )}
            {doc && doc !== "missing" && (
              <div className="doc-md">
                {doc.source === "slack" ? (
                  <ReactMarkdown remarkPlugins={[remarkMark]}>{text.split("\n").filter(Boolean).join("\n\n")}</ReactMarkdown>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMark]}>{text}</ReactMarkdown>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

export function DocLink({ doc, stage, quote, kind, children }: { doc: { path: string; title: string }; stage: number; quote?: string; kind?: Kind; children?: React.ReactNode }) {
  const open = useDoc();
  return (
    <button type="button" onClick={() => open({ path: doc.path, stage, quote, kind })} className="link-text text-left">
      {children ?? doc.title}
      <LinkIcon kind="doc" />
    </button>
  );
}
