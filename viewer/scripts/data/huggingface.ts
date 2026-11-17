import { safePath } from "./inventory";

export type Selection = { schemaVersion: 1; provider: "huggingface"; repository: string; revision: string; path: string; inventorySha256: string };
export function repositoryId(value: string) {
  if (!/^[\w-]+\/[\w.-]+$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) throw new Error("Dataset repository must be owner/dataset-name, not a URL");
  return value;
}
export function parseSelection(value: unknown, repositoryOverride?: string): Selection {
  const s = value as Selection;
  if (s?.schemaVersion !== 1 || s.provider !== "huggingface") throw new Error("Expected a Hugging Face dataset selection");
  if (repositoryOverride && s.repository && repositoryOverride !== s.repository) throw new Error("Repository override disagrees with the approved manifest; regenerate the selection for the new repository");
  const repository = repositoryOverride || s.repository;
  if (!repository || typeof s.revision !== "string" || !/^[a-f0-9]{40}$/.test(s.revision) || typeof s.path !== "string" || typeof s.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.inventorySha256)) {
    throw new Error("Dataset is not configured. Add the public HF repository, full commit SHA, path, and inventory checksum after publishing; no default dataset is used.");
  }
  repositoryId(repository);
  if (s.path) safePath(s.path);
  return { schemaVersion: 1, provider: "huggingface", repository, revision: s.revision, path: s.path, inventorySha256: s.inventorySha256 };
}
export function datasetUrl(selection: Selection, hub = "https://huggingface.co") {
  // An alternative hub is only used by offline tests, never exposed as a production build variable.
  const url = new URL(hub);
  if (url.origin !== "https://huggingface.co" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Unsupported dataset hub");
  const repo = repositoryId(selection.repository).split("/").map(encodeURIComponent).join("/");
  return `${url.origin}/datasets/${repo}/resolve/${selection.revision}${selection.path ? "/" + safePath(selection.path).split("/").map(encodeURIComponent).join("/") : ""}`;
}
