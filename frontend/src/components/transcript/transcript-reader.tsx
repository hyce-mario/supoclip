"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import {
  formatClock,
  orderedSelection,
  paragraphSelection,
  sentenceSelection,
  wordAt,
  type TranscriptData,
  type WordSelection,
} from "@/lib/transcript";

export interface TranscriptReaderHandle {
  /** Move the playback highlight (called every frame while playing). */
  setTime: (seconds: number) => void;
  /** Scroll a word into the middle of the reader. */
  reveal: (word: number) => void;
}

interface Props {
  data: TranscriptData;
  /** Clip id covering each word, or null. */
  coverage: (string | null)[];
  clipNumbers: Map<string, number>;
  selection: WordSelection | null;
  /** 1 for words inside a search match. */
  matchFlags: Uint8Array | null;
  activeMatch: WordSelection | null;
  /** 1 for words inside an AI moment of the shown search. */
  momentFlags: Uint8Array | null;
  /** The moment hovered in the side panel. */
  hoverMoment: WordSelection | null;
  /** Keep the playing word in view. */
  follow: boolean;
  onSelect: (selection: WordSelection | null) => void;
  onSeek: (seconds: number) => void;
}

const WORD_ATTR = "data-w";

/** The word index for a DOM node inside the reader, or null. */
function wordIndexOf(node: Node | null): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const word = element?.closest(`[${WORD_ATTR}]`);
  if (!word) return null;
  const index = Number(word.getAttribute(WORD_ATTR));
  return Number.isInteger(index) ? index : null;
}

/**
 * Where a word sits inside the reader's scroll area. offsetTop is not usable:
 * paragraphs with content-visibility become the words' offset parent.
 */
function topOf(node: HTMLElement, box: HTMLElement) {
  return node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

interface ParagraphProps {
  data: TranscriptData;
  index: number;
  coverage: (string | null)[];
  clipNumbers: Map<string, number>;
  /** Selection clipped to this paragraph's words, or null. */
  selFirst: number;
  selLast: number;
  matchFlags: Uint8Array | null;
  activeFirst: number;
  activeLast: number;
  momentFlags: Uint8Array | null;
  hoverFirst: number;
  hoverLast: number;
  showSpeaker: boolean;
  onSeek: (seconds: number) => void;
}

const Paragraph = memo(function Paragraph({
  data,
  index,
  coverage,
  clipNumbers,
  selFirst,
  selLast,
  matchFlags,
  activeFirst,
  activeLast,
  momentFlags,
  hoverFirst,
  hoverLast,
  showSpeaker,
  onSeek,
}: ParagraphProps) {
  const t = useTranslations("transcript");
  const [firstSentence, lastSentence] = data.paragraphs[index];
  const first = data.sentences[firstSentence][0];
  const last = data.sentences[lastSentence][1];
  const start = data.words[first][1];
  const speaker = data.speakers[data.words[first][3]];

  const spans = [];
  for (let w = first; w <= last; w += 1) {
    const clip = coverage[w];
    if (clip && coverage[w - 1] !== clip) {
      spans.push(
        <span
          key={`clip-${w}`}
          className="mr-1 inline-flex select-none items-center rounded bg-primary/15 px-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-primary"
          title={t("reader.clipped")}
        >
          {t("reader.clipBadge", { number: clipNumbers.get(clip) ?? 0 })}
        </span>,
      );
    }
    const selected = w >= selFirst && w <= selLast;
    const matched = matchFlags?.[w] === 1;
    const activeHit = w >= activeFirst && w <= activeLast;
    const moment = momentFlags?.[w] === 1;
    const hovered = w >= hoverFirst && w <= hoverLast;
    spans.push(
      <span
        key={w}
        data-w={w}
        className={cn(
          "cursor-text rounded-[3px] transition-colors data-[active=true]:text-primary data-[active=true]:underline data-[active=true]:decoration-2 data-[active=true]:underline-offset-4",
          clip && "bg-primary/[0.07]",
          moment && "bg-violet-300/30 dark:bg-violet-500/20",
          hovered && "bg-violet-400/50 dark:bg-violet-500/45",
          matched && "bg-amber-300/50 dark:bg-amber-500/35",
          activeHit && "bg-amber-400/80 dark:bg-amber-500/60",
          selected && "bg-sky-300/60 dark:bg-sky-500/45",
        )}
      >
        {data.words[w][0]}{" "}
      </span>,
    );
  }

  return (
    <section className="group/para grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 py-2.5 [contain-intrinsic-size:auto_9rem] [content-visibility:auto]">
      <button
        type="button"
        onClick={() => onSeek(start)}
        className="mt-1 select-none self-start text-left font-mono text-xs tabular-nums text-muted-foreground hover:text-foreground"
        title={t("reader.playFrom", { time: formatClock(start) })}
      >
        {formatClock(start)}
      </button>
      <div>
        {showSpeaker && (
          <div className="mb-0.5 select-none text-xs font-semibold text-muted-foreground">
            {t("reader.speaker", { name: speaker || "?" })}
          </div>
        )}
        <p className="text-[15px] leading-7 text-foreground/90">{spans}</p>
      </div>
    </section>
  );
});

export const TranscriptReader = forwardRef<TranscriptReaderHandle, Props>(function TranscriptReader(
  { data, coverage, clipNumbers, selection, matchFlags, activeMatch, momentFlags, hoverMoment, follow, onSelect, onSeek },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const activeWord = useRef<number>(-1);
  const lastUserScroll = useRef(0);
  const anchor = useRef<number | null>(null);
  // A single click seeks only once it is clear it isn't the start of a double-click.
  const pendingClick = useRef<number | null>(null);
  const cancelPendingClick = () => {
    if (pendingClick.current !== null) window.clearTimeout(pendingClick.current);
    pendingClick.current = null;
  };
  useEffect(() => cancelPendingClick, []);

  const element = (word: number) => container.current?.querySelector<HTMLElement>(`[${WORD_ATTR}="${word}"]`) ?? null;

  const correction = useRef<number | null>(null);
  useEffect(() => () => {
    if (correction.current !== null) window.clearTimeout(correction.current);
  }, []);

  const reveal = useCallback((word: number) => {
    const box = container.current;
    const node = element(word);
    if (!node || !box) return;
    const target = () => Math.max(0, topOf(node, box) - box.clientHeight / 2);
    const far = Math.abs(target() - box.scrollTop) > box.clientHeight * 3;
    // Long jumps go straight there: paragraphs rendered on the way change height.
    box.scrollTo({ top: target(), behavior: far ? "auto" : "smooth" });
    if (correction.current !== null) window.clearTimeout(correction.current);
    correction.current = window.setTimeout(() => {
      correction.current = null;
      if (Math.abs(target() - box.scrollTop) > 24) box.scrollTo({ top: target(), behavior: "auto" });
    }, far ? 80 : 450);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      setTime(seconds) {
        const word = wordAt(data.words, seconds);
        if (word === activeWord.current) return;
        if (activeWord.current >= 0) element(activeWord.current)?.removeAttribute("data-active");
        activeWord.current = word;
        const node = word >= 0 ? element(word) : null;
        if (!node) return;
        node.setAttribute("data-active", "true");
        const box = container.current;
        // Follow playback unless the user scrolled in the last few seconds.
        if (follow && box && Date.now() - lastUserScroll.current > 4000) {
          const top = topOf(node, box) - box.scrollTop;
          if (top < box.clientHeight * 0.15 || top > box.clientHeight * 0.8) reveal(word);
        }
      },
      reveal,
    }),
    [data.words, follow, reveal],
  );

  const handleMouseUp = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const clicked = wordIndexOf(event.target as Node);
    const native = window.getSelection();
    cancelPendingClick();
    if (event.detail === 2 && clicked !== null) {
      native?.removeAllRanges();
      anchor.current = clicked;
      onSelect(sentenceSelection(data, clicked));
      return;
    }
    if (event.detail >= 3 && clicked !== null) {
      native?.removeAllRanges();
      anchor.current = clicked;
      onSelect(paragraphSelection(data, clicked));
      return;
    }
    if (native && !native.isCollapsed) {
      const a = wordIndexOf(native.anchorNode);
      const b = wordIndexOf(native.focusNode);
      native.removeAllRanges();
      if (a !== null && b !== null) {
        anchor.current = a;
        onSelect(orderedSelection(a, b));
      }
      return;
    }
    if (clicked === null) return;
    if (event.shiftKey && anchor.current !== null) {
      onSelect(orderedSelection(anchor.current, clicked));
      return;
    }
    // A plain click on a word plays from there.
    anchor.current = clicked;
    onSelect(null);
    const start = data.words[clicked][1];
    pendingClick.current = window.setTimeout(() => {
      pendingClick.current = null;
      onSeek(start);
    }, 250);
  };

  // Touch: a long-press selection (and every handle drag after it) ends with touchend.
  const touchTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (touchTimer.current !== null) window.clearTimeout(touchTimer.current);
  }, []);
  const handleTouchEnd = () => {
    if (touchTimer.current !== null) window.clearTimeout(touchTimer.current);
    touchTimer.current = window.setTimeout(() => {
      touchTimer.current = null;
      const native = window.getSelection();
      if (!native || native.isCollapsed || !container.current?.contains(native.anchorNode)) return;
      const a = wordIndexOf(native.anchorNode);
      const b = wordIndexOf(native.focusNode);
      if (a === null || b === null) return;
      anchor.current = a;
      onSelect(orderedSelection(a, b));
    }, 350);
  };

  const showSpeakers = data.speakers.length > 1;
  const paragraphs = useMemo(() => data.paragraphs.map((_, index) => index), [data.paragraphs]);

  return (
    <div
      ref={container}
      className="relative h-full overflow-y-auto overscroll-contain px-4 py-2 outline-none sm:px-6"
      onMouseUp={handleMouseUp}
      onWheel={() => (lastUserScroll.current = Date.now())}
      onTouchMove={() => (lastUserScroll.current = Date.now())}
      onTouchEnd={handleTouchEnd}
      onKeyDown={(event) => {
        if (event.key === "Escape") onSelect(null);
      }}
      tabIndex={-1}
    >
      {paragraphs.map((index) => {
        const [firstSentence, lastSentence] = data.paragraphs[index];
        const first = data.sentences[firstSentence][0];
        const last = data.sentences[lastSentence][1];
        const overlaps = (range: WordSelection | null) => range && range.last >= first && range.first <= last;
        return (
          <Paragraph
            key={index}
            data={data}
            index={index}
            coverage={coverage}
            clipNumbers={clipNumbers}
            selFirst={overlaps(selection) ? selection!.first : -1}
            selLast={overlaps(selection) ? selection!.last : -2}
            matchFlags={matchFlags}
            activeFirst={overlaps(activeMatch) ? activeMatch!.first : -1}
            activeLast={overlaps(activeMatch) ? activeMatch!.last : -2}
            momentFlags={momentFlags}
            hoverFirst={overlaps(hoverMoment) ? hoverMoment!.first : -1}
            hoverLast={overlaps(hoverMoment) ? hoverMoment!.last : -2}
            showSpeaker={
              showSpeakers &&
              (index === 0 ||
                data.words[first][3] !== data.words[data.sentences[data.paragraphs[index - 1][1]][1]][3])
            }
            onSeek={onSeek}
          />
        );
      })}
    </div>
  );
});
