import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// index.html sets the class before first paint: the saved choice, else the OS theme.
const KEY = "theme";

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  const flip = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {}
  };
  const Icon = dark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={flip}
      title={dark ? "Light mode" : "Dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted hover:text-foreground", className)}
    >
      <Icon className="size-4" />
    </button>
  );
}
