// requestAnimationFrame loop (DESIGN §12.2). The tick receives the rAF timestamp (ms, same clock as
// performance.now()). The returned function stops the loop; a stopped loop never calls tick again.
export function startLoop(tick: (nowMs: number) => void): () => void {
  let running = true;
  let handle = 0;
  const frame = (now: number): void => {
    if (!running) return;
    tick(now);
    if (running) handle = requestAnimationFrame(frame);
  };
  handle = requestAnimationFrame(frame);
  return () => {
    running = false;
    cancelAnimationFrame(handle);
  };
}
