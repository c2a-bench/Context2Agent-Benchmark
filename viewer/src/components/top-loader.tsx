import { useEffect, useState } from "react";
import { useLoading } from "@/lib/loading";

/** A thin bar across the top of the page while anything loads (data, a page's code). It waits 150 ms before showing,
 *  so instant loads do not flash it. No animation: the site has none. */
export function TopLoader() {
  const loading = useLoading();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!loading) return setShown(false);
    const t = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(t);
  }, [loading]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5" role="progressbar" aria-label="Loading">
      <div className="top-loader-bar h-full bg-primary" />
    </div>
  );
}
