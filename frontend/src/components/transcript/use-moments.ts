"use client";

import { useCallback, useEffect, useState } from "react";

export const MOMENT_PRESETS = ["viral", "quotes", "stories", "advice", "hot_takes"] as const;
export type MomentPreset = (typeof MOMENT_PRESETS)[number];

/** A moment the AI found, snapped to whole sentences (source seconds). */
export interface Moment {
  id: string;
  start: number;
  end: number;
  title: string | null;
  reason: string;
  score: number;
  text: string;
}

export interface MomentRun {
  id: string;
  preset: MomentPreset | null;
  prompt: string | null;
  range: [number, number] | null;
  status: "queued" | "running" | "completed" | "failed";
  moments: Moment[];
  error: string | null;
  created_at: string | null;
}

export type MomentsErrorCode =
  | "empty"
  | "invalid_preset"
  | "invalid_range"
  | "range_too_short"
  | "busy"
  | "daily_limit"
  | "no_transcript"
  | "task_busy"
  | "queue_unavailable"
  | "unknown";

const KNOWN = new Set<string>([
  "empty",
  "invalid_preset",
  "invalid_range",
  "range_too_short",
  "busy",
  "daily_limit",
  "no_transcript",
  "task_busy",
  "queue_unavailable",
]);

export class MomentsRequestError extends Error {
  constructor(public code: MomentsErrorCode) {
    super(code);
  }
}

const POLL_MS = 3000;

export const isActiveRun = (run: MomentRun) => run.status === "queued" || run.status === "running";

/** AI moment searches for a task, polled while one is running. */
export function useMoments(taskId: string) {
  const [runs, setRuns] = useState<MomentRun[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/moments`, { cache: "no-store" });
      if (!response.ok) return;
      setRuns(((await response.json()) as { runs: MomentRun[] }).runs ?? []);
    } catch {
      // Retried on the next poll.
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = runs.some(isActiveRun);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const find = useCallback(
    async (request: { preset: MomentPreset | null; prompt: string; range: [number, number] | null }) => {
      const response = await fetch(`/api/tasks/${taskId}/moments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset: request.preset,
          prompt: request.prompt.trim() || null,
          range_start: request.range?.[0] ?? null,
          range_end: request.range?.[1] ?? null,
        }),
      });
      if (!response.ok) {
        let code: MomentsErrorCode = "unknown";
        try {
          const detail = ((await response.json()) as { detail?: { code?: string } }).detail;
          if (detail?.code && KNOWN.has(detail.code)) code = detail.code as MomentsErrorCode;
        } catch {
          // Keep "unknown".
        }
        throw new MomentsRequestError(code);
      }
      const { run } = (await response.json()) as { run: MomentRun };
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      return run;
    },
    [taskId],
  );

  const remove = useCallback(
    async (runId: string) => {
      setRuns((current) => current.filter((run) => run.id !== runId));
      await fetch(`/api/tasks/${taskId}/moments/${runId}`, { method: "DELETE" }).catch(() => undefined);
    },
    [taskId],
  );

  return { runs, find, remove };
}
