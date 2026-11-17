import { datasetUrl, parseSelection } from "./huggingface";
import { safePath } from "./inventory";
import type { DatasetRef, DatasetRelease } from "../../src/lib/dataset-v2";

export function parseRelease(value: unknown): DatasetRelease {
  const release = value as DatasetRelease;
  if (release?.schemaVersion !== 2 || release.provider !== "huggingface" || !Array.isArray(release.domains) || !release.domains.length || new Set(release.domains).size !== release.domains.length) throw new Error("Expected a version-2 benchmark/runs release");
  for (const domain of release.domains) if (safePath(domain).includes("/")) throw new Error("Invalid domain");
  const ref = (value: DatasetRef): DatasetRef => {
    const { repository, revision, path, inventorySha256 } = parseSelection({ ...value, schemaVersion: 1, provider: "huggingface" });
    return { repository, revision, path, inventorySha256 };
  };
  const benchmark = ref(release.benchmark), runs = ref(release.runs);
  if (benchmark.repository === runs.repository) throw new Error("Benchmark definitions and runs must use distinct repositories");
  return { schemaVersion: 2, provider: "huggingface", domains: release.domains, benchmark, runs };
}
export const releaseUrl = (ref: DatasetRef, hub?: string) => datasetUrl({ schemaVersion: 1, provider: "huggingface", ...ref }, hub);
