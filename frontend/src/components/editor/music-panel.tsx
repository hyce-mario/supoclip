"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Music, Pause, Play, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { timecode, uid, type EditDocument } from "@/lib/editor/document";
import {
  addMusic,
  musicDucks,
  musicFileUrl,
  musicOf,
  musicTrackKey,
  removeMusic,
  updateMusic,
  type MusicTrack,
} from "@/lib/editor/music";

import { Range, Section } from "./studio-ui";

interface Library {
  library: MusicTrack[];
  uploads: MusicTrack[];
  limits: { maxBytes: number; maxSeconds: number };
}

function useMusicLibrary() {
  const [data, setData] = useState<Library | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/music", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setData((await response.json()) as Library);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, failed, load, setData };
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

interface Props {
  doc: EditDocument;
  update: (change: (doc: EditDocument) => EditDocument, group?: string) => void;
  /** Playhead in edit seconds: new music starts here. */
  editTime: number;
  selected: string | null;
  select: (id: string | null) => void;
}

/** Background music: the library, the creator's uploads, and the selected piece's controls. */
export function MusicPanel({ doc, update, editTime, selected, select }: Props) {
  const t = useTranslations("editor.music");
  const { data, failed, load, setData } = useMusicLibrary();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      previewAudio.current?.pause();
    },
    [],
  );

  const togglePreview = (track: MusicTrack) => {
    const key = musicTrackKey(track);
    previewAudio.current?.pause();
    if (previewing === key) {
      setPreviewing(null);
      return;
    }
    const audio = new Audio(musicFileUrl(track));
    audio.volume = 0.6;
    audio.onended = () => setPreviewing((current) => (current === key ? null : current));
    previewAudio.current = audio;
    setPreviewing(key);
    void audio.play().catch(() => setPreviewing(null));
  };

  const add = (track: MusicTrack) => {
    const id = uid();
    update((current) => addMusic(current, track, editTime, id).doc);
    select(id);
    toast.success(t("added", { title: track.title }));
  };

  const upload = async (file: File) => {
    if (data && file.size > data.limits.maxBytes) {
      toast.error(t("errors.too_large"));
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/music/upload", { method: "POST", body: form });
      if (!response.ok) {
        let code = "unknown";
        try {
          code = ((await response.json()) as { detail?: { code?: string } }).detail?.code ?? "unknown";
        } catch {
          // Keep "unknown".
        }
        toast.error(t(["too_large", "not_audio", "too_many", "storage"].includes(code) ? `errors.${code}` : "errors.unknown"));
        return;
      }
      const { track } = (await response.json()) as { track: MusicTrack };
      setData((current) => (current ? { ...current, uploads: [track, ...current.uploads] } : current));
      toast.success(t("uploaded", { title: track.title }));
    } catch {
      toast.error(t("errors.unknown"));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const deleteUpload = async (track: MusicTrack) => {
    setData((current) => (current ? { ...current, uploads: current.uploads.filter((u) => u.id !== track.id) } : current));
    const response = await fetch(`/api/music/uploads/${encodeURIComponent(track.id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      toast.error(t("errors.delete"));
      void load();
    }
  };

  const categories = useMemo(
    () => [...new Set((data?.library ?? []).map((track) => track.category).filter((c): c is string => Boolean(c)))],
    [data],
  );
  const needle = query.trim().toLowerCase();
  const matches = (track: MusicTrack) =>
    !needle || `${track.title} ${track.artist ?? ""} ${track.category ?? ""}`.toLowerCase().includes(needle);
  const library = (data?.library ?? []).filter((track) => matches(track) && (!category || track.category === category));
  const uploads = (data?.uploads ?? []).filter(matches);

  const piece = musicOf(doc).find((item) => item.id === selected) ?? null;

  const row = (track: MusicTrack, removable: boolean) => {
    const key = musicTrackKey(track);
    return (
      <li key={key} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-accent/60">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t(previewing === key ? "stopPreview" : "preview", { title: track.title })}
          onClick={() => togglePreview(track)}
        >
          {previewing === key ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{track.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[track.artist, track.category, clock(track.duration)].filter(Boolean).join(" · ")}
          </p>
        </div>
        {removable && (
          <Button size="icon-sm" variant="ghost" aria-label={t("deleteUpload", { title: track.title })} onClick={() => void deleteUpload(track)}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => add(track)}>
          <Plus className="size-3.5" />
          {t("add")}
        </Button>
      </li>
    );
  };

  return (
    <div className="space-y-6" data-tour="editor-music">
      <Section title={t("title")} description={t("description")}>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="music-duck" className="text-sm font-normal">
            {t("duck")}
          </Label>
          <Switch
            id="music-duck"
            checked={musicDucks(doc)}
            onCheckedChange={(musicDuck) => update((d) => ({ ...d, musicDuck }))}
          />
        </div>
        <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">{t("duckHint")}</p>
      </Section>

      {piece && (
        <Section
          title={piece.track.title || t("untitled")}
          description={t("pieceRange", { start: timecode(piece.start), end: timecode(piece.end) })}
          action={
            <Button size="icon-sm" variant="ghost" aria-label={t("deselect")} onClick={() => select(null)}>
              <X className="size-4" />
            </Button>
          }
        >
          <Range
            label={t("volume")}
            value={Math.round(piece.volume * 100)}
            min={0}
            max={150}
            unit="%"
            onChange={(value) => update((d) => updateMusic(d, piece.id, { volume: value / 100 }), `music-volume:${piece.id}`)}
          />
          <Range
            label={t("fadeIn")}
            value={piece.fadeIn}
            min={0}
            max={5}
            step={0.1}
            unit="s"
            onChange={(value) => update((d) => updateMusic(d, piece.id, { fadeIn: value }), `music-fade-in:${piece.id}`)}
          />
          <Range
            label={t("fadeOut")}
            value={piece.fadeOut}
            min={0}
            max={5}
            step={0.1}
            unit="s"
            onChange={(value) => update((d) => updateMusic(d, piece.id, { fadeOut: value }), `music-fade-out:${piece.id}`)}
          />
          {piece.track.duration > 1 && (
            <Range
              label={t("offset")}
              value={Math.round(piece.offset * 10) / 10}
              min={0}
              max={Math.max(0, Math.floor((piece.track.duration - 0.5) * 10) / 10)}
              step={0.1}
              unit="s"
              onChange={(value) =>
                update(
                  (d) =>
                    updateMusic(d, piece.id, {
                      offset: value,
                      end: piece.loop ? piece.end : Math.min(piece.end, piece.start + piece.track.duration - value),
                    }),
                  `music-offset:${piece.id}`,
                )
              }
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="music-loop" className="text-sm font-normal">
              {t("loop")}
            </Label>
            <Switch
              id="music-loop"
              checked={piece.loop}
              onCheckedChange={(loop) =>
                update((d) =>
                  updateMusic(d, piece.id, {
                    loop,
                    end: loop ? piece.end : Math.min(piece.end, piece.start + piece.track.duration - piece.offset),
                  }),
                )
              }
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => {
              update((d) => removeMusic(d, piece.id));
              select(null);
            }}
          >
            <Trash2 className="size-4" />
            {t("remove")}
          </Button>
        </Section>
      )}

      <Section
        title={t("libraryTitle")}
        description={t("libraryDescription", { time: timecode(editTime) })}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="h-8 pl-8"
          />
        </div>
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("categories")}>
            {[null, ...categories].map((value) => (
              <button
                key={value ?? "all"}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors",
                  category === value
                    ? "border-foreground bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value ?? t("allCategories")}
              </button>
            ))}
          </div>
        )}
        {!data && !failed && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {failed && (
          <p className="text-xs text-destructive">
            {t("loadFailed")}{" "}
            <button type="button" className="underline" onClick={() => void load()}>
              {t("retry")}
            </button>
          </p>
        )}
        {data && data.library.length === 0 && (
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Music className="mt-0.5 size-3.5 shrink-0" />
            {t("libraryEmpty")}
          </p>
        )}
        {library.length > 0 && <ul className="max-h-72 space-y-0.5 overflow-y-auto">{library.map((track) => row(track, false))}</ul>}
        {data && data.library.length > 0 && library.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("noMatches")}</p>
        )}
      </Section>

      <Section
        title={t("uploadsTitle")}
        description={t("uploadsDescription")}
        action={
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {t("upload")}
          </Button>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.opus"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        {uploads.length > 0 ? (
          <ul className="max-h-60 space-y-0.5 overflow-y-auto">{uploads.map((track) => row(track, true))}</ul>
        ) : (
          data && <p className="text-xs text-muted-foreground">{t("uploadsEmpty")}</p>
        )}
      </Section>
    </div>
  );
}
