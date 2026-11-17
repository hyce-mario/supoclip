"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/transcript";

import {
  isActiveRun,
  MOMENT_PRESETS,
  MomentsRequestError,
  type Moment,
  type MomentPreset,
  type MomentRun,
} from "./use-moments";
import type { RangeClipJob } from "./use-range-clips";

/** Searching inside a selection needs at least this much of it (seconds). */
export const MIN_SEARCH_RANGE = 30;

interface Props {
  runs: MomentRun[];
  activeRun: MomentRun | null;
  onShowRun: (runId: string) => void;
  find: (request: { preset: MomentPreset | null; prompt: string; range: [number, number] | null }) => Promise<MomentRun>;
  remove: (runId: string) => Promise<void>;
  /** The current selection, offered as a search range. */
  selectionRange: [number, number] | null;
  jobs: RangeClipJob[];
  onHover: (moment: Moment | null) => void;
  onPick: (moment: Moment) => void;
  onCreate: (moments: Moment[]) => Promise<void>;
}

/** The clip request made from this moment, if any (same range). */
export function jobFor(jobs: RangeClipJob[], moment: Moment) {
  return jobs.find((job) => Math.abs(job.start - moment.start) < 0.05 && Math.abs(job.end - moment.end) < 0.05) ?? null;
}

function runLabel(t: ReturnType<typeof useTranslations>, run: MomentRun) {
  const parts = [run.preset ? t(`presets.${run.preset}`) : null, run.prompt ? `“${run.prompt}”` : null].filter(Boolean);
  return parts.join(" · ");
}

export function MomentsPanel({
  runs,
  activeRun,
  onShowRun,
  find,
  remove,
  selectionRange,
  jobs,
  onHover,
  onPick,
  onCreate,
}: Props) {
  const t = useTranslations("transcript.moments");
  const [preset, setPreset] = useState<MomentPreset | null>("viral");
  const [prompt, setPrompt] = useState("");
  const [inSelection, setInSelection] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const canLimit = Boolean(selectionRange && selectionRange[1] - selectionRange[0] >= MIN_SEARCH_RANGE);
  const searching = runs.some(isActiveRun);

  const submit = async () => {
    setSubmitting(true);
    try {
      const run = await find({ preset, prompt, range: canLimit && inSelection ? selectionRange : null });
      onShowRun(run.id);
      setChecked(new Set());
    } catch (error) {
      const code = error instanceof MomentsRequestError ? error.code : "unknown";
      toast.error(t(`errors.${code}`));
    } finally {
      setSubmitting(false);
    }
  };

  const moments = activeRun?.status === "completed" ? activeRun.moments : [];
  const creatable = moments.filter((moment) => {
    const job = jobFor(jobs, moment);
    return !job || job.status === "failed";
  });
  const selectedMoments = creatable.filter((moment) => checked.has(moment.id));

  const toggle = (id: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const create = async (list: Moment[]) => {
    setCreating(true);
    try {
      await onCreate(list);
      setChecked(new Set());
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="rounded-xl border bg-card p-3" data-tour="transcript-moments">
      <h3 className="flex items-center gap-1.5 px-1 text-sm font-semibold">
        <Sparkles className="size-4 text-primary" aria-hidden />
        {t("heading")}
      </h3>

      <form
        className="mt-2 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("presetsLabel")}>
          {MOMENT_PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={preset === value}
              onClick={() => setPreset(preset === value ? null : value)}
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors",
                preset === value
                  ? "border-foreground bg-foreground text-background"
                  : "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              {t(`presets.${value}`)}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={prompt}
            maxLength={500}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("promptPlaceholder")}
            aria-label={t("promptPlaceholder")}
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={submitting || searching || (!preset && !prompt.trim())}>
            {submitting || searching ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {t("find")}
          </Button>
        </div>
        {canLimit && selectionRange && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={inSelection} onCheckedChange={(value) => setInSelection(value === true)} />
            {t("inSelection", { start: formatClock(selectionRange[0]), end: formatClock(selectionRange[1]) })}
          </label>
        )}
      </form>

      {runs.length > 0 && activeRun && (
        <div className="mt-3 border-t pt-3">
          <div className="flex items-center gap-2">
            {runs.length > 1 ? (
              <select
                className="h-7 min-w-0 flex-1 truncate rounded-md border bg-background px-2 text-xs"
                value={activeRun.id}
                onChange={(event) => onShowRun(event.target.value)}
                aria-label={t("history")}
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {runLabel(t, run)}
                    {run.status === "completed" ? ` (${run.moments.length})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{runLabel(t, activeRun)}</p>
            )}
            {!isActiveRun(activeRun) && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("remove")}
                title={t("remove")}
                onClick={() => void remove(activeRun.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>

          {isActiveRun(activeRun) && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              {t("searching")}
            </p>
          )}
          {activeRun.status === "failed" && (
            <p className="mt-3 flex items-start gap-2 text-xs text-destructive" role="status">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {t("failed")}
            </p>
          )}
          {activeRun.status === "completed" && moments.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">{t("none")}</p>
          )}

          {moments.length > 0 && (
            <>
              <ul className="mt-2 max-h-[26rem] space-y-1 overflow-y-auto pr-1" onMouseLeave={() => onHover(null)}>
                {moments.map((moment) => {
                  const job = jobFor(jobs, moment);
                  const made = job && job.status !== "failed";
                  return (
                    <li
                      key={moment.id}
                      className="group/moment flex gap-2 rounded-lg px-1.5 py-2 hover:bg-violet-500/10"
                      onMouseEnter={() => onHover(moment)}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={!made && checked.has(moment.id)}
                        disabled={Boolean(made)}
                        onCheckedChange={(value) => toggle(moment.id, value === true)}
                        aria-label={t("check", { title: moment.title ?? formatClock(moment.start) })}
                      />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onPick(moment)}>
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium">{moment.title || t("untitled")}</span>
                          {moment.score > 0 && (
                            <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] font-semibold tabular-nums text-violet-700 dark:text-violet-300">
                              {moment.score}
                            </span>
                          )}
                        </span>
                        <span className="block text-xs tabular-nums text-muted-foreground">
                          {formatClock(moment.start)} – {formatClock(moment.end)} ·{" "}
                          {t("seconds", { seconds: Math.round(moment.end - moment.start) })}
                        </span>
                        {moment.reason && (
                          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{moment.reason}</span>
                        )}
                      </button>
                      {made ? (
                        <span
                          className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                          title={t(`made.${job.status}`)}
                        >
                          {job.status === "completed" ? (
                            <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Loader2 className="size-3.5 animate-spin" />
                          )}
                        </span>
                      ) : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="shrink-0"
                          disabled={creating}
                          aria-label={t("createOne")}
                          title={t("createOne")}
                          onClick={() => void create([moment])}
                        >
                          <Plus className="size-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={creatable.length === 0}
                  onClick={() =>
                    setChecked(
                      selectedMoments.length === creatable.length ? new Set() : new Set(creatable.map((m) => m.id)),
                    )
                  }
                >
                  {selectedMoments.length === creatable.length && creatable.length > 0 ? t("selectNone") : t("selectAll")}
                </button>
                <Button
                  size="sm"
                  disabled={creating || selectedMoments.length === 0}
                  onClick={() => void create(selectedMoments)}
                  data-tour="transcript-create-moments"
                >
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t("createSelected", { count: selectedMoments.length })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
