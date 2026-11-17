"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp, Copy, Crosshair, Loader2, Play, Plus, Search, WandSparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  clipCoverage,
  findPhrase,
  formatClock,
  lengthWarning,
  selectionText,
  selectionTimes,
  snapToSentences,
  wordAt,
  type TranscriptData,
  type WordSelection,
} from "@/lib/transcript";

import { SourcePlayer, type SourcePlayerHandle } from "./source-player";
import { MomentsPanel } from "./moments-panel";
import { RangeClipJobs } from "./range-clip-jobs";
import { TranscriptReader, type TranscriptReaderHandle } from "./transcript-reader";
import { useMoments, type Moment } from "./use-moments";
import { RangeClipRequestError, type RangeClipJob, type RangeClips } from "./use-range-clips";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: TranscriptData }
  | { kind: "notReady" }
  | { kind: "missing" }
  | { kind: "error" };

interface Props {
  taskId: string;
  /** Clip-from-range requests, shared with the clip list. */
  rangeClips: RangeClips;
  onViewClips: () => void;
}

export function TranscriptView({ taskId, rangeClips, onViewClips }: Props) {
  const t = useTranslations("transcript");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [hookTitle, setHookTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [selection, setSelection] = useState<WordSelection | null>(null);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [follow, setFollow] = useState(true);
  const player = useRef<SourcePlayerHandle>(null);
  const reader = useRef<TranscriptReaderHandle>(null);
  const stopAt = useRef<number | null>(null);

  // A silent reload (new clips to shade) keeps the current view on failure.
  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/tasks/${taskId}/transcript`, { cache: "no-store" });
      if (silent && !response.ok) return;
      if (response.status === 409) return setState({ kind: "notReady" });
      if (response.status === 404) return setState({ kind: "missing" });
      if (!response.ok) return setState({ kind: "error" });
      setState({ kind: "ready", data: (await response.json()) as TranscriptData });
    } catch {
      if (!silent) setState({ kind: "error" });
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = state.kind === "ready" ? state.data : null;

  // AI moments: the shown search is highlighted in the reader.
  const momentSearch = useMoments(taskId);
  const [shownRunId, setShownRunId] = useState<string | null>(null);
  const [hoverMoment, setHoverMoment] = useState<WordSelection | null>(null);
  const activeRun = momentSearch.runs.find((run) => run.id === shownRunId) ?? momentSearch.runs[0] ?? null;
  const momentToWords = useCallback(
    (moment: Moment): WordSelection | null => {
      if (!data || data.words.length === 0) return null;
      const first = Math.max(0, wordAt(data.words, moment.start + 0.001));
      const last = Math.max(first, wordAt(data.words, moment.end - 0.01));
      return { first, last };
    },
    [data],
  );
  const momentFlags = useMemo(() => {
    if (!data || activeRun?.status !== "completed" || activeRun.moments.length === 0) return null;
    const flags = new Uint8Array(data.words.length);
    for (const moment of activeRun.moments) {
      const range = momentToWords(moment);
      if (range) flags.fill(1, range.first, range.last + 1);
    }
    return flags;
  }, [data, activeRun, momentToWords]);

  // Shade clips as they are added.
  const completedJobs = rangeClips.jobs.filter((job) => job.status === "completed").length;
  const seenCompleted = useRef<number | null>(null);
  useEffect(() => {
    if (seenCompleted.current !== null && completedJobs > seenCompleted.current) void load(true);
    seenCompleted.current = completedJobs;
  }, [completedJobs, load]);

  const createClip = async (start: number, end: number, title?: string | null) => {
    setCreating(true);
    try {
      await rangeClips.create(start, end, title ?? undefined);
      toast.success(t("create.queued"));
      return true;
    } catch (error) {
      const code = error instanceof RangeClipRequestError ? error.code : "unknown";
      toast.error(t(`create.errors.${code}`));
      return false;
    } finally {
      setCreating(false);
    }
  };

  const pickMoment = (moment: Moment) => {
    const range = momentToWords(moment);
    if (!range) return;
    setSelection(range);
    reader.current?.reveal(range.first);
    player.current?.seek(moment.start, true);
    stopAt.current = moment.end;
  };

  const createMoments = async (list: Moment[]) => {
    let made = 0;
    let failed: string | null = null;
    for (const moment of list) {
      try {
        await rangeClips.create(moment.start, moment.end, moment.title ?? undefined);
        made += 1;
      } catch (error) {
        failed = error instanceof RangeClipRequestError ? error.code : "unknown";
        break;
      }
    }
    if (made > 0) toast.success(t("moments.queued", { count: made }));
    if (failed) toast.error(t(`create.errors.${failed}`));
  };

  const locateJob = (job: RangeClipJob) => {
    if (!data) return;
    const first = Math.max(0, wordAt(data.words, job.start + 0.01));
    reader.current?.reveal(first);
    seek(job.start);
  };

  const coverage = useMemo(() => (data ? clipCoverage(data.words, data.clips) : []), [data]);
  const clipNumbers = useMemo(
    () => new Map((data?.clips ?? []).map((clip, i) => [clip.id, clip.order ?? i + 1])),
    [data],
  );

  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const matches = useMemo(
    () => (data && debouncedQuery.length >= 2 ? findPhrase(data.words, debouncedQuery) : []),
    [data, debouncedQuery],
  );
  const matchFlags = useMemo(() => {
    if (!data || matches.length === 0) return null;
    const flags = new Uint8Array(data.words.length);
    for (const match of matches) flags.fill(1, match.first, match.last + 1);
    return flags;
  }, [data, matches]);
  const activeMatch = matches.length > 0 ? matches[Math.min(matchIndex, matches.length - 1)] : null;

  useEffect(() => setMatchIndex(0), [debouncedQuery]);
  useEffect(() => {
    if (activeMatch) reader.current?.reveal(activeMatch.first);
  }, [activeMatch]);

  const handleTime = useCallback((seconds: number) => {
    reader.current?.setTime(seconds);
    if (stopAt.current !== null && seconds >= stopAt.current) {
      stopAt.current = null;
      player.current?.pause();
    }
  }, []);

  const handlePlayingChange = useCallback((playing: boolean) => {
    if (!playing) stopAt.current = null;
  }, []);

  const seek = useCallback((seconds: number) => {
    stopAt.current = null;
    player.current?.seek(seconds, true);
  }, []);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setMatchIndex((current) => (current + delta + matches.length) % matches.length);
  };

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state.kind !== "ready") {
    const key = state.kind === "notReady" ? "notReady" : state.kind === "missing" ? "missing" : "error";
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
        <AlertCircle className="size-6 text-muted-foreground" />
        <div>
          <p className="font-medium">{t(`states.${key}.title`)}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t(`states.${key}.body`)}</p>
        </div>
        {state.kind === "error" && (
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("states.retry")}
          </Button>
        )}
      </div>
    );
  }

  const { data: transcript } = state;
  const times = selection ? selectionTimes(transcript.words, selection) : null;
  const warning = times ? lengthWarning(times.duration) : null;

  return (
    <div className={cn("grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]", selection && "max-lg:pb-20")}>
      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <SourcePlayer
          ref={player}
          media={transcript.media}
          onTime={handleTime}
          onPlayingChange={handlePlayingChange}
        />

        <section className="rounded-xl border bg-card p-4" aria-live="polite" data-tour="transcript-selection">
          {selection && times ? (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium tabular-nums">
                    {formatClock(times.start)} – {formatClock(times.end)}
                    <span className="ml-2 text-muted-foreground">{t("selection.seconds", { seconds: Math.round(times.duration) })}</span>
                  </p>
                  {warning && (
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        warning === "short" ? "text-muted-foreground" : "text-destructive",
                      )}
                    >
                      {t(`selection.warnings.${warning}`)}
                    </p>
                  )}
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={t("selection.clear")} onClick={() => setSelection(null)}>
                  <X className="size-4" />
                </Button>
              </div>
              <p className="line-clamp-4 text-sm text-muted-foreground">
                {selectionText(transcript.words, selection)}
              </p>
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createClip(times.start, times.end, hookTitle).then((ok) => {
                    if (!ok) return;
                    setHookTitle("");
                    setSelection(null);
                  });
                }}
              >
                <Input
                  value={hookTitle}
                  maxLength={80}
                  onChange={(event) => setHookTitle(event.target.value)}
                  placeholder={t("create.titlePlaceholder")}
                  aria-label={t("create.titleLabel")}
                  className="h-8"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={creating || warning === "tooShort" || warning === "tooLong"}
                  data-tour="transcript-create"
                >
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t("create.button")}
                </Button>
              </form>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    player.current?.seek(times.start, true);
                    stopAt.current = times.end;
                  }}
                >
                  <Play className="size-4" />
                  {t("selection.play")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSelection(snapToSentences(transcript, selection))}>
                  <WandSparkles className="size-4" />
                  {t("selection.snap")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(selectionText(transcript.words, selection))
                      .then(() => toast.success(t("selection.copied")))
                      .catch(() => undefined);
                  }}
                >
                  <Copy className="size-4" />
                  {t("selection.copy")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">{t("selection.emptyTitle")}</p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>{t("selection.hints.click")}</li>
                <li>{t("selection.hints.drag")}</li>
                <li>{t("selection.hints.double")}</li>
                <li>{t("selection.hints.triple")}</li>
              </ul>
            </div>
          )}
        </section>

        <MomentsPanel
          runs={momentSearch.runs}
          activeRun={activeRun}
          onShowRun={setShownRunId}
          find={momentSearch.find}
          remove={momentSearch.remove}
          selectionRange={times ? [times.start, times.end] : null}
          jobs={rangeClips.jobs}
          onHover={(moment) => setHoverMoment(moment ? momentToWords(moment) : null)}
          onPick={pickMoment}
          onCreate={createMoments}
        />

        <RangeClipJobs
          jobs={rangeClips.jobs}
          onLocate={locateJob}
          onView={onViewClips}
          onRetry={(job) => {
            void createClip(job.start, job.end, job.hook_title).then((ok) => {
              if (ok) void rangeClips.dismiss(job.id);
            });
          }}
          onDismiss={(job) => void rangeClips.dismiss(job.id)}
        />

        {transcript.clips.length > 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block size-3 rounded-sm bg-primary/15" aria-hidden />
            {t("legend.clipped", { count: transcript.clips.length })}
          </p>
        )}
      </aside>

      <section
        className="flex h-[70vh] min-h-[24rem] flex-col overflow-hidden rounded-xl border bg-card lg:h-[calc(100vh-8rem)]"
        aria-label={t("reader.label")}
        data-tour="transcript-reader"
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") setQuery("");
              }}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              className="h-8 pl-8"
            />
          </div>
          {debouncedQuery.length >= 2 && (
            <div className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <span>
                {matches.length === 0
                  ? t("search.none")
                  : t("search.count", { current: Math.min(matchIndex, matches.length - 1) + 1, total: matches.length })}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label={t("search.previous")} disabled={!matches.length} onClick={() => step(-1)}>
                <ChevronUp className="size-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={t("search.next")} disabled={!matches.length} onClick={() => step(1)}>
                <ChevronDown className="size-4" />
              </Button>
              {activeMatch && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setSelection(activeMatch)}
                >
                  <Crosshair className="size-3.5" />
                  {t("search.select")}
                </Button>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Switch id="transcript-follow" checked={follow} onCheckedChange={setFollow} />
            <Label htmlFor="transcript-follow" className="text-xs text-muted-foreground">
              {t("reader.follow")}
            </Label>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <TranscriptReader
            ref={reader}
            data={transcript}
            coverage={coverage}
            clipNumbers={clipNumbers}
            selection={selection}
            matchFlags={matchFlags}
            activeMatch={activeMatch}
            momentFlags={momentFlags}
            hoverMoment={hoverMoment}
            follow={follow}
            onSelect={setSelection}
            onSeek={seek}
          />
        </div>
      </section>

      {/* Phones: the selection panel is above the reader, so keep its main actions in reach. */}
      {selection && times && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-xl items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium tabular-nums">
                {formatClock(times.start)} – {formatClock(times.end)}
                <span className="ml-2 text-muted-foreground">{t("selection.seconds", { seconds: Math.round(times.duration) })}</span>
              </p>
              {warning && warning !== "short" && (
                <p className="truncate text-xs text-destructive">{t(`selection.warnings.${warning}`)}</p>
              )}
            </div>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("selection.play")}
              onClick={() => {
                player.current?.seek(times.start, true);
                stopAt.current = times.end;
              }}
            >
              <Play className="size-4" />
            </Button>
            <Button
              size="sm"
              disabled={creating || warning === "tooShort" || warning === "tooLong"}
              onClick={() => {
                void createClip(times.start, times.end, hookTitle).then((ok) => {
                  if (!ok) return;
                  setHookTitle("");
                  setSelection(null);
                });
              }}
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t("create.button")}
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={t("selection.clear")} onClick={() => setSelection(null)}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
