import { downloadBlob } from "@/lib/clip-actions";
import {
  clamp,
  editDuration,
  footageKey,
  footageUrl,
  mappedBroll,
  outputSize,
  renderSegments,
  type EditDocument,
  type EditorState,
} from "./document";
import { drawEditorFrame, loadEditorFont, type BRollLayer } from "./render";
import {
  docSpeechSpans,
  musicFileUrl,
  musicGain,
  musicOf,
  musicPosition,
  musicTrackKey,
  type Span,
} from "./music";
import type { MusicClip } from "./document";

const MUSIC_BLOCK = 128;

/** Add the draft's music to interleaved samples that start at edit time `start`. */
function mixMusic(
  data: Float32Array,
  channels: number,
  rate: number,
  start: number,
  pieces: MusicClip[],
  buffers: Map<string, AudioBuffer>,
  spans: Span[],
  total: number,
) {
  const frames = data.length / channels;
  for (const piece of pieces) {
    const buffer = buffers.get(musicTrackKey(piece.track));
    if (!buffer) continue;
    const sources = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    for (let block = 0; block < frames; block += MUSIC_BLOCK) {
      const t = start + block / rate;
      const gain = musicGain(piece, t, spans, total);
      if (gain <= 0) continue;
      let position = Math.round(musicPosition(piece, t) * buffer.sampleRate);
      const last = Math.min(frames, block + MUSIC_BLOCK);
      for (let f = block; f < last; f++, position++) {
        if (position >= buffer.length) {
          if (!piece.loop) break;
          position = 0;
        }
        for (let c = 0; c < channels; c++) data[f * channels + c] += sources[c % sources.length][position] * gain;
      }
    }
  }
}

export async function exportDraft(
  url: string,
  doc: EditDocument,
  asset: EditorState,
  preset: string,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  // Preserve a continuous dissolve (and frame timestamps) through UI splits.
  doc = { ...doc, segments: renderSegments(doc.segments) };
  const m = await import("mediabunny");
  const size = outputSize(doc, asset.width, asset.height);
  const bitrate = preset === "reels" ? 12_000_000 : 10_000_000;
  const audioCodec = (await m.canEncodeAudio("aac"))
    ? "aac"
    : (await m.canEncodeAudio("opus"))
      ? "opus"
      : null;
  const music = musicOf(doc);
  if (
    !(await m.canEncodeVideo("avc", { ...size, bitrate })) ||
    ((asset.hasAudio || music.length > 0) && !audioCodec)
  )
    throw new Error(
      "This browser cannot encode this video. Choose background export to render it on the server.",
    );
  await loadEditorFont(doc.captions.font);
  const mediaUrl = asset.hasLayout && doc.framing.fit === "auto" && doc.framing.aspect === "vertical" ? url.replace(/clean\.mp4$/, "layout.mp4") : url;
  const response = await fetch(mediaUrl, { signal });
  if (!response.ok) throw new Error("Could not load the source video.");
  const input = new m.Input({
    source: new m.BlobSource(await response.blob()),
    formats: m.ALL_FORMATS,
  });
  const output = new m.Output({
    format: new m.Mp4OutputFormat(),
    target: new m.BufferTarget(),
  });
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    input.dispose();
    throw new Error("Canvas is unavailable. Use background export.");
  }
  let finalized = false;
  // Stock footage is decoded alongside the clip and drawn under the captions.
  const pieces = mappedBroll(doc);
  const footage = new Map<string, { input: InstanceType<typeof m.Input>; sink: InstanceType<typeof m.VideoSampleSink> }>();
  const endpoint = url.replace(/\/media\/clean\.mp4$/, "");
  try {
    for (const piece of pieces) {
      const key = footageKey(piece.clip.footage);
      if (footage.has(key)) continue;
      const response = await fetch(footageUrl(endpoint, piece.clip.footage), { signal });
      if (!response.ok) throw new Error("Could not load B-roll footage. Use background export.");
      const footageInput = new m.Input({
        source: new m.BlobSource(await response.blob()),
        formats: m.ALL_FORMATS,
      });
      const track = await footageInput.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) {
        footageInput.dispose();
        throw new Error("This browser cannot decode the B-roll. Use background export.");
      }
      footage.set(key, { input: footageInput, sink: new m.VideoSampleSink(track) });
    }
    const video = await input.getPrimaryVideoTrack(),
      audio = await input.getPrimaryAudioTrack();
    if (
      !video ||
      !(await video.canDecode()) ||
      (audio && !(await audio.canDecode()))
    )
      throw new Error(
        "This browser cannot decode the source. Use background export.",
      );
    const videoSource = new m.CanvasSource(canvas, { codec: "avc", bitrate });
    output.addVideoTrack(videoSource);
    if ((audio || music.length > 0) && !audioCodec)
      throw new Error("Audio encoding is unavailable. Use background export.");
    // Music is decoded at the clip's own rate so its samples line up with the voice.
    const sampleRate = audio ? await audio.getSampleRate() : 48_000;
    const musicBuffers = new Map<string, AudioBuffer>();
    for (const piece of music) {
      const key = musicTrackKey(piece.track);
      if (musicBuffers.has(key)) continue;
      const response = await fetch(musicFileUrl(piece.track), { signal });
      if (!response.ok) throw new Error("Could not load the music. Use background export.");
      const decoder = new OfflineAudioContext(2, 1, sampleRate);
      musicBuffers.set(key, await decoder.decodeAudioData(await response.arrayBuffer()));
    }
    const spans = docSpeechSpans(doc);
    const audioSource =
      (audio || music.length > 0) && audioCodec
        ? new m.AudioSampleSource({ codec: audioCodec, bitrate: 192_000 })
        : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    const duration = editDuration(doc);
    const renderVideo = async () => {
      let cursor = 0;
      for (const segment of doc.segments) {
        const sink = new m.VideoSampleSink(video);
        for await (const sample of sink.samples(segment.start, segment.end)) {
          try {
            signal.throwIfAborted();
            const start = Math.max(segment.start, sample.timestamp),
              end = Math.min(segment.end, sample.timestamp + sample.duration);
            if (end <= start) continue;
            const at = cursor + start - segment.start;
            const piece = pieces.find((p) => at >= p.start && at < p.end);
            const brollSample = piece
              ? await footage
                  .get(footageKey(piece.clip.footage))
                  ?.sink.getSample(piece.offset + at - piece.start)
              : null;
            let layer: BRollLayer | null = null;
            if (piece && brollSample) {
              const fade = piece.fadeDuration;
              const alpha = clamp(
                Math.min(
                  piece.fadeIn && fade > 0 ? (at - piece.start) / fade : 1,
                  piece.fadeOut && fade > 0 ? (piece.end - at) / fade : 1,
                ),
                0,
                1,
              );
              layer = {
                width: brollSample.displayWidth,
                height: brollSample.displayHeight,
                alpha,
                draw: (x, y, w, h) => brollSample.draw(ctx, x, y, w, h),
              };
            }
            try {
              drawEditorFrame(
                ctx,
                doc,
                sample.displayWidth,
                sample.displayHeight,
                at,
                (rect) =>
                  sample.draw(ctx, rect.x, rect.y, rect.width, rect.height),
                asset.captionLooks,
                layer,
              );
            } finally {
              brollSample?.close();
            }
            await videoSource.add(at, end - start);
            progress(
              Math.min(99, Math.round(((at + end - start) / duration) * 100)),
            );
          } finally {
            sample.close();
          }
        }
        cursor += segment.end - segment.start;
      }
      videoSource.close();
    };
    const renderMusicOnly = async () => {
      if (!audioSource) return;
      const channels = 2;
      for (let start = 0; start < duration; start += 1) {
        signal.throwIfAborted();
        const frames = Math.round(Math.min(1, duration - start) * sampleRate);
        if (frames <= 0) break;
        const data = new Float32Array(frames * channels);
        mixMusic(data, channels, sampleRate, start, music, musicBuffers, spans, duration);
        const sample = new m.AudioSample({ data, format: "f32", numberOfChannels: channels, sampleRate, timestamp: start });
        try {
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
      }
      audioSource.close();
    };
    const renderAudio = async () => {
      if (!audio) return renderMusicOnly();
      if (!audioSource) return;
      let cursor = 0;
      for (const segment of doc.segments) {
        const sink = new m.AudioSampleSink(audio);
        for await (const sample of sink.samples(segment.start, segment.end)) {
          try {
            signal.throwIfAborted();
            const startFrame = Math.max(
              0,
              Math.ceil((segment.start - sample.timestamp) * sample.sampleRate),
            );
            const endFrame = Math.min(
              sample.numberOfFrames,
              Math.floor((segment.end - sample.timestamp) * sample.sampleRate),
            );
            if (endFrame <= startFrame) continue;
            const full = new Float32Array(
              sample.allocationSize({ planeIndex: 0, format: "f32" }) / 4,
            );
            sample.copyTo(full, { planeIndex: 0, format: "f32" });
            const data = full.slice(
              startFrame * sample.numberOfChannels,
              endFrame * sample.numberOfChannels,
            );
            const gain = doc.muted ? 0 : doc.volume;
            for (let i = 0; i < data.length; i++) data[i] *= gain;
            const timestamp = cursor + sample.timestamp + startFrame / sample.sampleRate - segment.start;
            if (music.length > 0)
              mixMusic(data, sample.numberOfChannels, sample.sampleRate, timestamp, music, musicBuffers, spans, duration);
            const next = new m.AudioSample({
              data,
              format: "f32",
              numberOfChannels: sample.numberOfChannels,
              sampleRate: sample.sampleRate,
              timestamp,
            });
            try {
              await audioSource.add(next);
            } finally {
              next.close();
            }
          } finally {
            sample.close();
          }
        }
        cursor += segment.end - segment.start;
      }
      audioSource.close();
    };
    // Await both producers before releasing input/output, including on failure.
    const outcomes = await Promise.allSettled([renderVideo(), renderAudio()]);
    const failed = outcomes.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed) throw failed.reason;
    signal.throwIfAborted();
    await output.finalize();
    finalized = true;
    if (!output.target.buffer) throw new Error("Export produced no video.");
    signal.throwIfAborted();
    downloadBlob(
      new Blob([output.target.buffer], { type: "video/mp4" }),
      `supoclip-${preset}.mp4`,
    );
    progress(100);
  } finally {
    if (!finalized) await output.cancel().catch(() => {});
    input.dispose();
    for (const { input: footageInput } of footage.values()) footageInput.dispose();
  }
}
