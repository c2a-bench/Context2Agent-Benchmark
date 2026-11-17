import { Link } from "react-router";
import { ThemeToggle } from "@/components/theme-toggle";
import { publicAsset } from "@/lib/assets";

const NAV = [
  ["Environments", "#environments"],
  ["Results", "#results"],
  ["Failures", "#failures"],
  ["Architecture", "#architecture"],
  ["Perturbations", "#packs"],
] as const;

/**
 * The landing nav. On the home page it gets the refs for the travelling title (the slot it docks into, kept invisible,
 * and the divider that fades in); on other pages (the blog) the name shows in place and the section links go home.
 */
export function Nav({ slotRef, dividerRef }: { slotRef?: React.RefObject<HTMLSpanElement | null>; dividerRef?: React.RefObject<HTMLSpanElement | null> }) {
  const home = !!slotRef;
  const to = (hash: string) => `/${hash}`;
  return (
    <header className="lp-nav">
      <div className="lp-wrap flex h-full items-center gap-6">
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
          {/* Observe.AI wordmark (from peregrine-fullstack's assets), one file per theme. */}
          <a href="https://www.observe.ai/" target="_blank" rel="noreferrer" aria-label="Observe.AI" className="flex items-center">
            <img src={publicAsset("observe-ai-logo-light.svg")} alt="Observe.AI" className="h-[15px] w-auto dark:hidden sm:h-[17px]" />
            <img src={publicAsset("observe-ai-logo-dark.svg")} alt="Observe.AI" className="hidden h-[15px] w-auto dark:block sm:h-[17px]" />
          </a>
          <span ref={dividerRef} className="h-5 w-px" style={{ background: "var(--line)", opacity: home ? 0 : 1 }} aria-hidden />
          {home ? (
            /* where the travelling title docks: same text at nav size, kept invisible to reserve and measure the spot */
            <span ref={slotRef} className="lp-title text-[17px] sm:text-[19px]" style={{ visibility: "hidden" }} aria-hidden>Resolve Bench</span>
          ) : (
            <Link to="/" className="lp-title text-[17px] sm:text-[19px]" style={{ color: "var(--ink)", textDecoration: "none" }}>Resolve Bench</Link>
          )}
        </div>
        <nav className="mx-auto hidden gap-7 text-[15px] font-medium lg:flex" aria-label="Sections">
          {NAV.map(([label, href]) => <Link key={href} to={to(href)} className="link" style={{ textDecorationColor: "transparent" }}>{label}</Link>)}
          <Link to="/blog" className="link" style={{ textDecorationColor: "transparent" }}>Blog</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          {/* below lg the section links are hidden, so Blog moves here to stay reachable */}
          <Link to="/blog" className="link px-2 text-[15px] font-medium lg:hidden" style={{ textDecorationColor: "transparent" }}>Blog</Link>
          <ThemeToggle />
          <Link to={to("#results")} className="btn btn--primary max-sm:hidden">See the results</Link>
        </div>
      </div>
    </header>
  );
}
