"use client";

import { AlertCircle, CheckCircle2, Clock, Loader2, RotateCcw, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/transcript";

import type { RangeClipJob } from "./use-range-clips";

interface Props {
  jobs: RangeClipJob[];
  /** Seek the reader to a request's range. */
  onLocate?: (job: RangeClipJob) => void;
  /** Open the clip list. */
  onView?: () => void;
  onRetry?: (job: RangeClipJob) => void;
  onDismiss: (job: RangeClipJob) => void;
  className?: string;
}

/** Clips requested from the transcript: waiting, rendering, added or failed. */
export function RangeClipJobs({ jobs, onLocate, onView, onRetry, onDismiss, className }: Props) {
  const t = useTranslations("transcript.jobs");
  if (jobs.length === 0) return null;

  return (
    <section className={cn("rounded-xl border bg-card p-3", className)} aria-live="polite" data-tour="transcript-jobs">
      <h3 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("heading")}</h3>
      <ul className="space-y-1">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm">
            <StatusIcon status={job.status} />
            <button
              type="button"
              className="min-w-0 flex-1 text-left disabled:cursor-default"
              disabled={!onLocate}
              onClick={() => onLocate?.(job)}
              title={job.status === "failed" && job.error ? job.error : undefined}
            >
              <span className="block truncate font-medium">
                {job.hook_title || t("untitled", { start: formatClock(job.start), end: formatClock(job.end) })}
              </span>
              <span className="block text-xs tabular-nums text-muted-foreground">
                {formatClock(job.start)} – {formatClock(job.end)} · {t(`status.${job.status}`)}
              </span>
            </button>
            {job.status === "completed" && onView && (
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onView}>
                {t("view")}
              </Button>
            )}
            {job.status === "failed" && onRetry && (
              <Button size="icon-sm" variant="ghost" aria-label={t("retry")} title={t("retry")} onClick={() => onRetry(job)}>
                <RotateCcw className="size-4" />
              </Button>
            )}
            {(job.status === "completed" || job.status === "failed") && (
              <Button size="icon-sm" variant="ghost" aria-label={t("dismiss")} title={t("dismiss")} onClick={() => onDismiss(job)}>
                <X className="size-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusIcon({ status }: { status: RangeClipJob["status"] }) {
  if (status === "rendering") return <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />;
  if (status === "queued") return <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  if (status === "completed") return <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  return <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />;
}
