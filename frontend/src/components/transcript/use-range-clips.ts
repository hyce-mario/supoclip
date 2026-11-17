"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** A clip requested from a transcript range (`range_clip_jobs`). */
export interface RangeClipJob {
  id: string;
  start: number;
  end: number;
  hook_title: string | null;
  status: "queued" | "rendering" | "completed" | "failed";
  clip_id: string | null;
  error: string | null;
  created_at: string | null;
}

export type RangeClipErrorCode =
  | "too_short"
  | "too_long"
  | "out_of_bounds"
  | "invalid_range"
  | "too_many"
  | "task_busy"
  | "queue_unavailable"
  | "unknown";

export class RangeClipRequestError extends Error {
  constructor(public code: RangeClipErrorCode) {
    super(code);
  }
}

const POLL_MS = 4000;
const KNOWN_CODES = new Set<RangeClipErrorCode>([
  "too_short",
  "too_long",
  "out_of_bounds",
  "invalid_range",
  "too_many",
  "task_busy",
  "queue_unavailable",
]);

export const isActiveJob = (job: RangeClipJob) => job.status === "queued" || job.status === "rendering";

async function errorCode(response: Response): Promise<RangeClipErrorCode> {
  try {
    const body = (await response.json()) as { detail?: { code?: string } };
    const code = body.detail?.code as RangeClipErrorCode | undefined;
    return code && KNOWN_CODES.has(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Clip-from-range requests for a task. Polls while any is waiting or rendering
 * and calls `onCompleted` once for each request that finishes.
 */
export function useRangeClips(taskId: string | null, onCompleted?: (job: RangeClipJob) => void) {
  const [jobs, setJobs] = useState<RangeClipJob[]>([]);
  const known = useRef(new Map<string, RangeClipJob["status"]>());
  const completed = useRef(onCompleted);
  useEffect(() => {
    completed.current = onCompleted;
  }, [onCompleted]);

  const apply = useCallback((next: RangeClipJob[]) => {
    for (const job of next) {
      const before = known.current.get(job.id);
      if (job.status === "completed" && before && before !== "completed") completed.current?.(job);
      known.current.set(job.id, job.status);
    }
    setJobs(next);
  }, []);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}/clips/from-range`, { cache: "no-store" });
      if (!response.ok) return;
      apply(((await response.json()) as { jobs: RangeClipJob[] }).jobs ?? []);
    } catch {
      // Polling retries on the next tick.
    }
  }, [taskId, apply]);

  useEffect(() => {
    known.current = new Map();
    setJobs([]);
    void load();
  }, [load]);

  const active = jobs.some(isActiveJob);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const create = useCallback(
    async (start: number, end: number, hookTitle?: string) => {
      if (!taskId) throw new RangeClipRequestError("unknown");
      const response = await fetch(`/api/tasks/${taskId}/clips/from-range`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end, hook_title: hookTitle?.trim() || null }),
      });
      if (!response.ok) throw new RangeClipRequestError(await errorCode(response));
      const { job } = (await response.json()) as { job: RangeClipJob };
      known.current.set(job.id, job.status);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      return job;
    },
    [taskId],
  );

  const dismiss = useCallback(
    async (jobId: string) => {
      if (!taskId) return;
      setJobs((current) => current.filter((job) => job.id !== jobId));
      await fetch(`/api/tasks/${taskId}/clips/from-range/${jobId}`, { method: "DELETE" }).catch(() => undefined);
    },
    [taskId],
  );

  return { jobs, create, dismiss, reload: load };
}

export type RangeClips = ReturnType<typeof useRangeClips>;
