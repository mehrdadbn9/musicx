# MusicX — Project Goal & Status

> Personal self-hosted music app, built and run by Mehrdad Biukian Naeini (SRE, [@mehrdadbn9](https://github.com/mehrdadbn9)).
> Repo: https://github.com/mehrdadbn9/musicx · Runs locally via `docker compose up -d --build` on `localhost:8080`.

## Goal

A **Spotify-style, self-hosted music client** you own end to end: search any catalog, get tagged
audio files at the quality you pick, and play everything back through a real client — full-screen
Now Playing, shuffle/repeat, a collapsible mini-player, a persistent liked shelf, and a
**reorderable queue / playlist** you build by drag-and-drop. No accounts, no API keys, nothing paid.

### Non-goals / hard constraints
- No personal tokens, cookies as files, or corporate identity in the repo. (Commit author = personal
  Gmail; `cookies.txt`/`.env` gitignored.)
- Must run clean from Iran: self-hosted Inter font, no third-party CDNs.
- Deezer only publishes a 30-second preview without a paid/DRM API — full-length Deezer playback
  depends on YouTube/SoundCloud extraction, which is bot-blocked on a datacenter IP. The app must
  **never hard-fail (502)**: it tries full-length, then falls back to the preview clip.

## What's built (verified live)

### Discovery & download
- Multi-source search: Spotify, Deezer, Apple Music, YouTube, SoundCloud from one box + URL paste.
- Quality you choose: 128 / 192 / 320 kbps MP3 or original, always tagged + cover art.
- Playlists: create, rename, add/remove, ZIP download.
- Offline content-based "similar songs" that derive the real artist from the title (Persian/Farsi
  recommendations survive noisy uploader seeds).

### Player (the Spotify part)
- **Now Playing overlay**: large artwork, synced-lyrics tab (LRC click-to-seek), queue tab.
- **Transport**: play/pause, prev/next, seek, mute, shuffle, repeat (off → all → one).
- **Mini-player** collapse.
- **Liked tracks** persisted to `localStorage`; reachable 3 ways (Library tab, right-rail shelf,
  left-nav shortcut).
- **Reorderable queue / playlist** (NEW): drag any track to reorder; "Play first" sends a track to
  the top of what's next; current track stays pinned. Persisted with the queue.

### Deezer playback fix (NEW)
- Root cause: Deezer tracks resolved with `source_url = null`, so `/api/stream` fell back to a
  YouTube search that is bot-blocked from the VPS → HTTP 502 (nothing played).
- Fix: `/api/stream` now uses an **ordered fallback** — SoundCloud search → YouTube search →
  Deezer preview CDN. Full-length audio when the network allows; the 30s preview clip otherwise.
  **Never a 502.** Verified: `GET /api/stream?...&preview_url=<deezer>` returns 200 audio.

### UI
- Recent searches moved directly under the search bar (was buried at page end).
- Professional, LinkedIn/X-ready README (Tech stack + Architecture + unique features).
- Author consistently "© 2026 Mehrdad Biukian Naeini (SRE, @mehrdadbn9)".

## Open / next
- Residential proxy for YouTube extraction → reliable full-length Deezer playback (currently
  depends on YouTube/SoundCloud cooperating from the VPS IP).
- "Play all" button at the top of search results (playlist from a search) — queue reorder covers
  the edit-order need; this is the remaining convenience gap.
- GitHub repo description + topics; LinkedIn/X post copy.
