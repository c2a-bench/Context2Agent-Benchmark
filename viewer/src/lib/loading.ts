import { useSyncExternalStore } from "react";

// How many loads are in flight (data files, page code): the top bar shows while any is. Anything that waits on the
// network wraps its promise in track().
let inFlight = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function track<T>(p: Promise<T>): Promise<T> {
  inFlight++;
  emit();
  const done = () => {
    inFlight = Math.max(0, inFlight - 1);
    emit();
  };
  p.then(done, done);
  return p;
}

export function useLoading(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => inFlight > 0,
  );
}
