import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { TipRoot } from "@/components/charts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NotFound } from "@/pages/not-found";
import { TopLoader } from "@/components/top-loader";
import { SectionScroll } from "@/components/section-scroll";
import { canonicalDomain } from "@/lib/dataset-v2";
import { parseRunKey } from "@/lib/data-types";
import "@fontsource-variable/newsreader";
import "./fonts.css";
import "./globals.css";

import { AcquisitionPage, ArchitecturePage, BehaviorPage, Blog, BuildPage, CodePage, Home, JobLayout, OverviewPage, ResearchLayout, Rq1Page, Rq5Page, TaskRuns, TicketsPage } from "@/lib/pages";

/** Old run links: /runs/<job>/<rest> → /runs/<job>/research[/<rest>]. */
function ToResearch({ rest = "" }: { rest?: string }) {
  const { job } = useParams();
  return <Navigate to={`/runs/${job}/research${rest && `/${rest}`}`} replace />;
}

/** Old /cases links: the test case view of the tickets page. */
function ToCases() {
  const { job } = useParams();
  return <Navigate to={`/runs/${job}/tickets?view=case`} replace />;
}

/** The page-wide tooltip layer, cleared on every navigation. */
function PageTips() {
  return <TipRoot key={useLocation().key} />;
}

function CanonicalJobLayout() {
  const { job = "" } = useParams(), location = useLocation();
  const parsed = parseRunKey(job), canonical = `${canonicalDomain(parsed.task)}.${parsed.job}`;
  if (job !== canonical) return <Navigate to={`${location.pathname.replace(/^\/runs\/[^/]+/, `/runs/${canonical}`)}${location.search}${location.hash}`} replace />;
  return <JobLayout />;
}
function CanonicalTaskRuns() {
  const { task = "" } = useParams(), location = useLocation();
  const canonical = canonicalDomain(task);
  return canonical === task ? <TaskRuns /> : <Navigate to={`/t/${canonical}${location.search}${location.hash}`} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/blog" element={<Blog />} />
      <Route path="/blog/:slug" element={<Navigate to="/blog" replace />} />
      <Route path="/t/:task" element={<CanonicalTaskRuns />} />
      <Route path="/runs/:job" element={<CanonicalJobLayout />}>
        <Route index element={<ToResearch />} />
        <Route path="overview" element={<ToResearch />} />
        {["acquisition", "architecture", "behavior", "evolution"].map((p) => (
          <Route key={p} path={p} element={<ToResearch rest={p} />} />
        ))}
        <Route path="research" element={<ResearchLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="rq1" element={<Rq1Page />} />
          <Route path="rq5" element={<Rq5Page />} />
          <Route path="acquisition" element={<AcquisitionPage />} />
          <Route path="architecture" element={<ArchitecturePage />} />
          <Route path="behavior" element={<BehaviorPage />} />
          <Route path="evolution" element={<Navigate to="../rq1" relative="path" replace />} />
        </Route>
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="code" element={<CodePage />} />
        <Route path="build" element={<BuildPage />} />
        <Route path="cases" element={<ToCases />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <SectionScroll />
      <TooltipProvider>
        <Suspense fallback={null}>
          <App />
        </Suspense>
        <PageTips />
        <TopLoader />
      </TooltipProvider>
    </HashRouter>
  </StrictMode>,
);
