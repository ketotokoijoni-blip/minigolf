export type TimerHandle = number;
export interface Clock {
  now(): number;                                        // ms since epoch
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
export const systemClock: Clock = (() => {
  let next = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) { const id = next++; timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms)); return id; },
    clearTimeout(id) { const h = timers.get(id); if (h) { clearTimeout(h); timers.delete(id); } },
  };
})();
