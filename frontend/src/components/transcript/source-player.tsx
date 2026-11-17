"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import type { TranscriptMedia } from "@/lib/transcript";

/** What the reader drives, whichever player is behind it. */
export interface SourcePlayerHandle {
  seek: (seconds: number, play?: boolean) => void;
  play: () => void;
  pause: () => void;
  time: () => number;
}

interface Props {
  media: TranscriptMedia | null;
  /** Called every animation frame while playing, and after seeks. */
  onTime: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

// --- YouTube IFrame API (loaded once, on demand) ----------------------------------

interface YouTubePlayer {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  getCurrentTime: () => number;
  destroy: () => void;
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: () => void;
        onStateChange?: (event: { data: number }) => void;
        onError?: () => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: { PLAYING: number };
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApi: Promise<YouTubeNamespace> | null = null;

function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeApi) {
    youtubeApi = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT) resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        youtubeApi = null;
        reject(new Error("YouTube player failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return youtubeApi;
}

// --- Player ---------------------------------------------------------------------

export const SourcePlayer = forwardRef<SourcePlayerHandle, Props>(function SourcePlayer(
  { media, onTime, onPlayingChange },
  ref,
) {
  const t = useTranslations("transcript");
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeHost = useRef<HTMLDivElement>(null);
  const youtube = useRef<YouTubePlayer | null>(null);
  const youtubeReady = useRef(false);
  const pendingSeek = useRef<{ seconds: number; play: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onTime, onPlayingChange });
  callbacks.current = { onTime, onPlayingChange };

  const currentTime = () =>
    media?.kind === "youtube" ? (youtube.current?.getCurrentTime() ?? 0) : (videoRef.current?.currentTime ?? 0);

  const stopTicking = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const startTicking = () => {
    stopTicking();
    const tick = () => {
      callbacks.current.onTime(currentTime());
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  useImperativeHandle(ref, () => ({
    seek(seconds, play = false) {
      if (media?.kind === "youtube") {
        if (!youtube.current || !youtubeReady.current) {
          pendingSeek.current = { seconds, play };
          return;
        }
        youtube.current.seekTo(seconds, true);
        if (play) youtube.current.playVideo();
      } else if (videoRef.current) {
        videoRef.current.currentTime = seconds;
        if (play) void videoRef.current.play().catch(() => undefined);
      }
      callbacks.current.onTime(seconds);
    },
    play() {
      if (media?.kind === "youtube") youtube.current?.playVideo();
      else void videoRef.current?.play().catch(() => undefined);
    },
    pause() {
      if (media?.kind === "youtube") youtube.current?.pauseVideo();
      else videoRef.current?.pause();
    },
    time: currentTime,
  }));

  useEffect(() => {
    if (media?.kind !== "youtube" || !youtubeHost.current) return;
    let cancelled = false;
    const host = document.createElement("div");
    youtubeHost.current.replaceChildren(host);
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        youtube.current = new YT.Player(host, {
          videoId: media.video_id,
          width: "100%",
          height: "100%",
          playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
          events: {
            onReady: () => {
              youtubeReady.current = true;
              const seek = pendingSeek.current;
              pendingSeek.current = null;
              if (seek) {
                youtube.current?.seekTo(seek.seconds, true);
                if (seek.play) youtube.current?.playVideo();
              }
            },
            onStateChange: ({ data }) => {
              const playing = data === YT.PlayerState.PLAYING;
              callbacks.current.onPlayingChange(playing);
              if (playing) startTicking();
              else {
                stopTicking();
                callbacks.current.onTime(currentTime());
              }
            },
            onError: () => setFailed(true),
          },
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      stopTicking();
      youtube.current?.destroy();
      youtube.current = null;
      youtubeReady.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreate only when the video changes
  }, [media?.kind, media?.kind === "youtube" ? media.video_id : null]);

  useEffect(() => stopTicking, []);

  if (!media) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        {t("player.unavailable")}
      </div>
    );
  }

  if (media.kind === "youtube") {
    return (
      <div className="space-y-2">
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <div ref={youtubeHost} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
          {failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 p-4 text-center text-sm text-white">
              <p>{t("player.embedFailed")}</p>
              <a
                className="inline-flex items-center gap-1 underline underline-offset-2"
                href={`https://www.youtube.com/watch?v=${media.video_id}`}
                target="_blank"
                rel="noreferrer"
              >
                {t("player.openYouTube")}
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <video
        ref={videoRef}
        src={`/api${media.url}`}
        controls
        preload="metadata"
        playsInline
        className="aspect-video w-full rounded-xl bg-black"
        onPlay={() => {
          onPlayingChange(true);
          startTicking();
        }}
        onPause={() => {
          onPlayingChange(false);
          stopTicking();
          onTime(currentTime());
        }}
        onSeeked={() => onTime(currentTime())}
        onError={() => setFailed(true)}
      />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/80 p-4 text-center text-sm text-white">
          {t("player.loadFailed")}
        </div>
      )}
    </div>
  );
});
