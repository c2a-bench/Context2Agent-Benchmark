import { parsePath, useParams, useSearchParams } from "react-router";

/** The :job route param (a run key). */
export function useJob() {
  return useParams().job ?? "";
}

/** The URL query as a plain object, like Next's searchParams. */
export function useQuery(): Record<string, string | undefined> {
  const [params] = useSearchParams();
  return Object.fromEntries(params);
}

/** Read the live router query, not window.location.search (which is outside a HashRouter route). */
export function hashSearchParams(hash: string) {
  return new URLSearchParams(parsePath(hash.replace(/^#/, "") || "/").search ?? "");
}

export function currentSearchParams() {
  return hashSearchParams(window.location.hash);
}

export function useSetQuery() {
  const [, setParams] = useSearchParams();
  return (key: string, value: string) => {
    const next = currentSearchParams();
    next.set(key, value);
    setParams(next, { replace: true, preventScrollReset: true });
  };
}
