"use client";

import { useEffect, useMemo, useRef } from "react";

import { outputTime, type EditDocument } from "@/lib/editor/document";
import {
  docSpeechSpans,
  musicFileUrl,
  musicGain,
  musicLength,
  musicOf,
  musicPosition,
} from "@/lib/editor/music";

interface Player {
  element: HTMLAudioElement;
  url: string;
  gain: GainNode | null;
}

/**
 * Plays a draft's background music in step with the preview video: one audio
 * element per piece, routed through the preview's AudioContext so its gain
 * (volume, fades, ducking) follows the same curve as the exports.
 */
export function useMusicPlayback(
  doc: EditDocument,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  segmentIndex: number,
  audioRef: React.RefObject<{ context: AudioContext } | null>,
) {
  const players = useRef(new Map<string, Player>());
  const pieces = useMemo(() => musicOf(doc), [doc]);
  const spans = useMemo(() => docSpeechSpans(doc), [doc]);

  // One element per piece; a changed track gets a new element.
  useEffect(() => {
    const current = players.current;
    const wanted = new Map(pieces.map((piece) => [piece.id, musicFileUrl(piece.track)]));
    for (const [id, player] of current) {
      if (wanted.get(id) !== player.url) {
        player.element.pause();
        player.gain?.disconnect();
        current.delete(id);
      }
    }
    for (const [id, url] of wanted) {
      if (current.has(id)) continue;
      const element = new Audio();
      element.preload = "auto";
      element.src = url;
      current.set(id, { element, url, gain: null });
    }
  }, [pieces]);

  useEffect(
    () => () => {
      for (const player of players.current.values()) {
        player.element.pause();
        player.gain?.disconnect();
      }
      players.current.clear();
    },
    [],
  );

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const video = videoRef.current;
      const context = audioRef.current?.context;
      if (!video || players.current.size === 0) return;
      const index = Math.min(segmentIndex, doc.segments.length - 1);
      const t = outputTime(doc, index, video.currentTime);
      const total = doc.segments.reduce((sum, s) => sum + s.end - s.start, 0);
      for (const piece of pieces) {
        const player = players.current.get(piece.id);
        if (!player) continue;
        const { element } = player;
        const inside = t >= piece.start && t < piece.start + musicLength(piece, total);
        if (video.paused || !inside || !context) {
          if (!element.paused) element.pause();
          continue;
        }
        if (!player.gain) {
          const gain = context.createGain();
          context.createMediaElementSource(element).connect(gain);
          gain.connect(context.destination);
          player.gain = gain;
        }
        player.gain.gain.setTargetAtTime(musicGain(piece, t, spans, total), context.currentTime, 0.02);
        element.loop = piece.loop;
        element.playbackRate = video.playbackRate;
        const wanted = musicPosition(piece, t);
        if (Math.abs(element.currentTime - wanted) > 0.25) element.currentTime = wanted;
        if (element.paused) void element.play().catch(() => {});
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioRef, doc, pieces, segmentIndex, spans, videoRef]);
}
