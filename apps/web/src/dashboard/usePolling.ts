import { useEffect, useRef } from "react";

/**
 * Runs `fn` immediately and then every `intervalMs`, pausing entirely while
 * the tab is hidden (`visibilitychange`) and refetching on return. Changing
 * `deps` restarts the cycle with an immediate fetch.
 */
export function usePolling(
  fn: () => void | Promise<void>,
  deps: readonly unknown[],
  intervalMs = 5000,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let timer: number | null = null;
    const run = () => void fnRef.current();

    const start = () => {
      if (timer !== null) return;
      run();
      timer = window.setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}
