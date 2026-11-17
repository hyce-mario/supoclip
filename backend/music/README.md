# Music library

Audio files in this folder appear in the clip studio's **Audio** tab as
background music, the same way fonts in `backend/fonts/` do. No restart is
needed when the folder is mounted (docker-compose mounts it).

- Formats: `.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.flac`, `.opus`.
- Subfolders become categories, e.g. `music/chill/sunset.mp3` is listed under
  "Chill".
- The title comes from the file's title tag, otherwise from its file name.

Only add music you are licensed to use in published videos (royalty-free
libraries, or tracks you own). Creators can also upload their own tracks from
the studio; those are stored per account, not here.
