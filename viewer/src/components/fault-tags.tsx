import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FAULT_CLASS, FAULT_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FaultSide } from "@/lib/types";

export type FaultItem = { side: FaultSide; text: string; what: string };

/** "Fault: Bot Builder" for a ticket. Hover a tag to see that side's reasons. */
export function FaultTags({ items }: { items: FaultItem[] }) {
  const sides = [...new Set(items.map((i) => i.side))];
  if (!sides.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted-foreground">Fault:</span>
      {sides.map((side) => {
        // One line per reason, with the fields it applies to.
        const reasons = new Map<string, Set<string>>();
        for (const i of items.filter((x) => x.side === side)) {
          if (!reasons.has(i.text)) reasons.set(i.text, new Set());
          reasons.get(i.text)!.add(i.what);
        }
        return (
          <Tooltip key={side}>
            <TooltipTrigger render={<span />} className={cn("cursor-help whitespace-nowrap rounded-full px-2 py-px font-medium", FAULT_CLASS[side])}>
              {side === "us" ? "Ours" : FAULT_LABEL[side]}
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-sm flex-col items-start gap-1.5 py-2">
              {[...reasons].map(([text, whats]) => (
                <div key={text}>
                  <div>{text}</div>
                  <div className="opacity-70">On: {[...whats].join(", ")}</div>
                </div>
              ))}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
