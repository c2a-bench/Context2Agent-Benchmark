import { lazy } from "react";
import { track } from "@/lib/loading";

// Each page is its own download, fetched the first time it is opened (the top bar shows meanwhile). preloadPage()
// fetches one ahead, e.g. when the pointer is over its tab, so opening it does not wait.
const loaders = {
  home: () => import("@/pages/home"),
  blog: () => import("@/pages/blog-post"),
  taskRuns: () => import("@/pages/task-runs"),
  jobLayout: () => import("@/pages/job-layout"),
  researchLayout: () => import("@/pages/research-layout"),
  overview: () => import("@/pages/research"),
  acquisition: () => import("@/pages/acquisition"),
  rq1: () => import("@/pages/rq1"),
  rq5: () => import("@/pages/rq5"),
  architecture: () => import("@/pages/architecture"),
  behavior: () => import("@/pages/behavior"),
  tickets: () => import("@/pages/tickets"),
  code: () => import("@/pages/code"),
  build: () => import("@/pages/build"),
};
export type PageName = keyof typeof loaders;

export const Home = lazy(() => track(loaders.home()));
export const Blog = lazy(() => track(loaders.blog()));
export const TaskRuns = lazy(() => track(loaders.taskRuns()));
export const JobLayout = lazy(() => track(loaders.jobLayout()));
export const ResearchLayout = lazy(() => track(loaders.researchLayout()));
export const OverviewPage = lazy(() => track(loaders.overview()));
export const AcquisitionPage = lazy(() => track(loaders.acquisition()));
export const Rq1Page = lazy(() => track(loaders.rq1()));
export const Rq5Page = lazy(() => track(loaders.rq5()));
export const ArchitecturePage = lazy(() => track(loaders.architecture()));
export const BehaviorPage = lazy(() => track(loaders.behavior()));
export const TicketsPage = lazy(() => track(loaders.tickets()));
export const CodePage = lazy(() => track(loaders.code()));
export const BuildPage = lazy(() => track(loaders.build()));

/** Start downloading a page's code before it is opened (the browser keeps it; opening it then is instant). */
export function preloadPage(name: PageName) {
  void loaders[name]().catch(() => undefined);
}
