import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type PickerOption = { value: string; text: string; meta?: string };

/** A one-of-many choice (stage, filter): a small outlined button showing the choice, opening a menu with the others.
 *  The same menu as the breadcrumb switches, in place of the browser's own select. */
export function Picker({ id, label, value, options, onPick, className, menuLabel = true }: {
  id?: string; label: string; value: string; options: PickerOption[]; onPick: (v: string) => void; className?: string; menuLabel?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={id}
        aria-label={`${label}: ${current?.text ?? value}`}
        className={cn(
          "inline-flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border bg-background px-2 py-1 text-left font-sans text-xs outline-none transition-colors",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          {current?.text ?? value}
          {current?.meta && <span className="ml-1.5 text-muted-foreground">{current.meta}</span>}
        </span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {menuLabel && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onPick(String(v))}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} data-value={o.value}>
                <span className="flex-1">{o.text}</span>
                {o.meta && <span className="text-xs text-muted-foreground tabular-nums">{o.meta}</span>}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
