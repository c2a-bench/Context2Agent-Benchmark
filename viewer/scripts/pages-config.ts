export { datasetUrl } from "./data/huggingface";

export function pagesBase(value = "/") {
  const base = value.endsWith("/") ? value : `${value}/`;
  if (!/^\/(?:[\w.-]+\/)*$/.test(base) || base.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("VITE_BASE_PATH must be / or a repository path such as /Context2Agent-Benchmark/");
  }
  return base;
}
