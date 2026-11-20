import { useCallback, useEffect, useRef, useState } from "react";
import { useAppResume } from "./useAppResume";

/**
 * Generic polling hook with configurable interval.
 * Pauses when the tab is hidden.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
  errorRetryIntervalMs?: number,
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const prevDataRef = useRef<string>("");

  const doFetch = useCallback(async (force = false) => {
    if (inFlightRef.current && !force) return;
    inFlightRef.current = true;
    try {
      const result = await fetcherRef.current();
      if (mountedRef.current) {
        // Skip re-render if data is structurally identical
        const serialized = JSON.stringify(result);
        if (serialized !== prevDataRef.current) {
          prevDataRef.current = serialized;
          setData(result);
        }
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    return doFetch(true);
  }, [doFetch]);

  const resumeFetch = useCallback(() => {
    void doFetch(false);
  }, [doFetch]);

  useAppResume(resumeFetch);

  // Initial fetch on mount / when re-enabled (do NOT re-fetch immediately when only intervalMs changes)
  useEffect(() => {
    mountedRef.current = true;
    void doFetch(false);
    return () => {
      mountedRef.current = false;
    };
  }, [doFetch, enabled]);

  const effectiveIntervalMs =
    error !== null && errorRetryIntervalMs && errorRetryIntervalMs > 0
      ? Math.min(intervalMs, errorRetryIntervalMs)
      : intervalMs;

  // Recurring timer that adapts intervalMs (and speeds up while disconnected) without firing a redundant burst
  useEffect(() => {
    if (!enabled) return;

    const id = setInterval(() => {
      if (!document.hidden) void doFetch(false);
    }, effectiveIntervalMs);

    return () => {
      clearInterval(id);
    };
  }, [doFetch, effectiveIntervalMs, enabled]);

  return { data, error, loading, refresh };
}
