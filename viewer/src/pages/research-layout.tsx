import { Outlet } from "react-router";

/** The analysis tabs live in the job header (components/job-nav.tsx); this only scrolls their page. */
export default function ResearchLayout() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Outlet />
    </div>
  );
}
