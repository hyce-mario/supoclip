# Transcript reader and studio music

## Transcript reader

The task page has a **Clips / Transcript** switch (`?view=transcript`) for the owner once processing has finished.
The reader shows the whole source transcript next to a player of the source video:

- **Read and play.** Click a word to play from it; "Follow playback" keeps the spoken word in view.
- **Select.** Drag across words (long-press on phones), double-click a sentence, triple-click a paragraph,
  Shift-click to extend. Search finds phrases (case and punctuation ignored).
- **Existing clips** are shaded with a "Clip N" badge where they start.

Code: `backend/src/transcript_reader.py` (words → sentences → paragraphs), `backend/src/api/routes/transcript.py`,
`frontend/src/components/transcript/`, `frontend/src/lib/transcript.ts`.

**Data.** `GET /tasks/{id}/transcript` reads `task_processing_checkpoints.payload->'transcript_data'` (word timings in
ms), falling back to a `.transcript_cache.json` beside a stored local source. Words go out as compact
`[text, start_s, end_s, speaker]` arrays. `GET /tasks/{id}/source/media` streams the stored source (local files only
inside `TEMP_DIR`) or redirects to its signed URL; without a stored source a YouTube embed plays instead.

### Clips from a selection

`POST /tasks/{id}/clips/from-range` `{start, end, hook_title?}` (3 s to 3 min) stores a `range_clip_jobs` row and
enqueues `create_range_clip` on the video worker (`services/range_clip_service.py`):

- The exact range renders as one **planned** segment (no sentence snapping or extension) with the task's settings:
  captions, cleanup, B-roll, plan resolution. A hook title is burned in only when given.
- The clip is appended after the task's last clip. **No minutes are charged**: the source was metered at creation.
- When the source's transcript sidecar is gone, the worker restores it from the checkpoint before rendering, so
  captions always have words.
- At most 10 requests wait or render per task; a `rendering` row older than 45 minutes reads as failed.
  `GET .../clips/from-range` lists recent requests; the task page polls it and reloads the clip list on completion.

### AI moments

`POST /tasks/{id}/moments` `{preset?, prompt?, range_start?, range_end?}` stores a `transcript_moment_runs` row and
enqueues `find_moments_job` on the **AI worker** (`supoclip_ai` queue; `services/moments_service.py`):

- Presets: `viral` (the plain highlights selection), `quotes`, `stories`, `advice`, `hot_takes`. A preset and a
  free-text request combine into the selection model's `instructions`.
- An optional range (at least 30 s, from the current selection) limits the search to those transcript lines.
- Results run through the same model as clip generation (`get_most_relevant_parts_by_transcript`). Each segment is
  snapped to whole sentences (`transcript_reader.snap_to_sentences`: a sentence counts when at least half of it
  lies inside the model's whole-second range) and duplicates are dropped.
- `MOMENTS_DAILY_LIMIT` (default 50) searches per user per day; failed searches don't count.
- The side panel highlights the shown search's moments in the reader. A moment's title becomes the hook title when
  it is created.

## Studio music

The clip studio's **Audio** tab has background music, and the timeline a **Music** lane under the clip's audio.

- **Library:** audio files in `backend/music/` (mounted into the containers; subfolders become categories).
  Only add music you are licensed to publish.
- **Uploads:** `POST /music/uploads` takes any common audio file (≤ 30 MB, ≤ 15 min), transcodes it to stereo AAC and
  stores it in the bucket (`music/<owner>/…`) or under `TEMP_DIR/music`. Rows: `user_music_tracks`.
  Renders fetch uploads into a per-machine `TEMP_DIR/music-cache`.
- **Draft model:** `EditDocument.music` pieces live on the **edit** timeline (cuts never chop a song): `start`,
  `end`, `offset` into the track, `volume`, `fadeIn`, `fadeOut`, `loop`, `track`. `musicDuck` (default on) lowers
  music under speech.
- **One gain curve everywhere:** volume × fades × duck, where duck dips to 30 % over speech spans built from the
  caption words (0.25 s attack, 0.5 s release). `backend/src/editor_music.py` (server export, an ffmpeg volume
  expression) and `frontend/src/lib/editor/music.ts` (preview and browser export) implement it with the same
  numbers; their tests share expectations.
- Combining drafts starts the combination without music.
