/**
 * Pre-flight worker health check used by POST /api/recon/:entry_id
 * before inserting a job. Avoids the "Position 1 forever" stuck state
 * when no worker is running.
 *
 * Requires `WORKER_HEALTH_URL` server-side env var pointing at the
 * worker's `/health` endpoint (e.g. https://ai-hosting-service.onrender.com/health).
 * If the env var is unset, the check is skipped — useful for dev where
 * the worker may run on the same machine without HTTP exposure.
 */

export interface WorkerHealthCheck {
  reachable: boolean;
  /** Latency in ms when reachable; undefined otherwise. */
  latencyMs?: number;
  /** Cause when unreachable: "no_env" | "timeout" | "http_<status>" | "fetch_error" */
  reason?: string;
}

const HEALTH_TIMEOUT_MS = 3500;

export async function checkWorkerHealth(): Promise<WorkerHealthCheck> {
  const url = process.env.WORKER_HEALTH_URL;
  if (!url) {
    // No URL configured — skip the check (treat as reachable).
    // Production should always have this set; dev/local can opt out.
    return { reachable: true, reason: "no_env" };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return { reachable: false, reason: `http_${res.status}`, latencyMs };
    }
    return { reachable: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const isAbort = err instanceof DOMException && err.name === "TimeoutError";
    return {
      reachable: false,
      reason: isAbort ? "timeout" : "fetch_error",
      latencyMs,
    };
  }
}
