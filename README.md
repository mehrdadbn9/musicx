# MusicX

<p align="center">
  <img src="frontend/public/icon-192.png" width="96" alt="MusicX app icon" />
</p>

<h1 align="center">MusicX</h1>

<p align="center">
  <b>Self-hosted music: search, download, and play like a Spotify client — no account, no API key, no cost.</b>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-%E2%9C%93-blue" />
  <img alt="No account" src="https://img.shields.io/badge/no%20account-required-purple" />
  <img alt="No API key" src="https://img.shields.io/badge/no%20API%20key-required-pink" />
</p>

---

MusicX is a self-hosted music app. Paste a **Spotify / Deezer / Apple Music / YouTube / SoundCloud** track, album or playlist URL — or just search — and get **tagged audio files at the quality you pick** (128 / 192 / 320 kbps MP3, or the original stream untouched).

Then play it back in a **Spotify-style player** that runs entirely on your own server: full-screen Now Playing with synced lyrics, shuffle/repeat, a collapsible mini-player, and a liked-tracks shelf that survives reloads.

No accounts. No API keys. Nothing paid. You run it, so the files are yours and nobody stands in between.

---

## Why it exists

Most "get my music" tools are either a one-shot downloader with no player, or a streaming app that keeps your library behind someone else's account and servers. MusicX is both, on your hardware:

- **You own the files.** Downloads are real tagged MP3s with cover art, sitting in your library.
- **You own the experience.** The player is a proper client — queue, lyrics, liked songs, the works — not a web-page wrapper.
- **It works where the big players don't.** Self-hosted Inter font (no Google Fonts dependency → loads cleanly from restricted networks) and recommendations that don't fall apart on non-Latin catalog.

---

## Features

### Discover & download
- **Multi-source search** — one search box across Spotify, Deezer, Apple Music, YouTube and SoundCloud.
- **Link paste** — drop a track, album or playlist URL from any supported source.
- **Quality you choose** — 128 / 192 / 320 kbps MP3, or the source's original file, always with tags + cover art.
- **Playlists** — create, rename, add/remove tracks, and download the whole thing as a ZIP.
- **Offline, content-based recommendations** — "similar songs" for any track, derived from the *real* artist in the title so Persian/Farsi recommendations survive noisy uploader seeds.

### Player experience (the Spotify part)
- **Now Playing overlay** — tap expand in the player bar (or the sidebar widget) for large artwork, a **synced-lyrics tab** (LRC with click-to-seek, plain-text fallback) and a **Queue** tab. Drag down to dismiss.
- **Transport** — play/pause, prev/next, seek, mute, plus **shuffle** and **repeat** (off → all → one), available from both the bar and the overlay.
- **Mini-player** — collapse the bar to a slim strip (cover + title + controls) and expand anytime.
- **Liked tracks** — heart any track from the bar, the overlay, or a library row. The list lives in the player store and is **persisted to `localStorage`**, so it survives reloads. Reach it three ways: the **Liked** tab in the Library, the **Liked** card in the right rail (click to play), and the **Liked** shortcut in the left nav.
- **Sidebar widgets** — a quiet Now Playing anchor at the bottom of the left sidebar (current track + playing indicator); the right rail shows your liked shelf, a quality guide, library stats, and shortcuts.

Everything plays at full length: a downloaded track off disk, or anything else proxied by `/api/stream`.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| **Frontend** | React 19 + TypeScript, Vite 8, Tailwind CSS v4, TanStack Query |
| **State** | Lightweight in-module store (player, queue, liked) — no Redux |
| **Backend** | FastAPI (Python) + Uvicorn |
| **Extraction** | yt-dlp, ffmpeg, mutagen (tagging) |
| **PO tokens** | `bgutil-ytdlp-pot-provider` sidecar for YouTube datacenter-IP handling |
| **Storage** | SQLite for library + analytics |
| **Deploy** | Docker Compose (api + frontend + pot-provider) |

---

## Architecture

```
                ┌─────────────────────────────┐
   Browser ───▶ │  React SPA (Vite/nginx)     │  player bar · Now Playing
                │  queue · lyrics · library   │  overlay · liked · mini-player
                └──────────────┬──────────────┘
                               │  /api/*
                ┌──────────────▼──────────────┐
                │  FastAPI backend            │
                │  search · download · stream │
                │  lyrics · library · recs    │
                └──────┬───────────────┬──────┘
                       │               │
                 yt-dlp + ffmpeg   bgutil PO-token
                 (sources)          provider (sidecar)
                       │
                 tagged files → SQLite library
```

- **Frontend** is a single-page React client; all playback state (queue, position, shuffle/repeat, liked) lives in a small module-level store so any surface — bar, overlay, sidebar — stays in sync without prop-drilling.
- **Backend** resolves catalog URLs, downloads/tags audio, and proxies playback through `/api/stream` so the browser never talks to the source directly.
- **pot-provider** mints the proof-of-origin tokens YouTube asks datacenter IPs for; it runs as a sidecar and is a no-op on a normal connection.

See `CONTEXT.md` and `docs/DESIGN.md` for deeper architecture and local-stack notes.

---

## Quick start

```bash
docker compose up -d --build
# app: http://localhost:8080
```

Backend tests:

```bash
cd backend && .venv/bin/python -m pytest tests/ -q
```

---

## Keyboard shortcuts

`Space` play/pause · `← / →` seek ±10s · `Shift + ← / →` previous/next · `M` mute · `Esc` stop

---

## What makes it unique

- **Files + player, one app.** Not a downloader bolted to a webpage — a real client over your own library and streams.
- **Recommendations that respect the catalog.** Artist is derived from the track title, so non-Latin (Persian/Farsi) music gets sensible "more like this" instead of uploader-seed garbage.
- **Runs clean from anywhere.** Self-hosted fonts, no third-party CDNs, no accounts — including behind restrictive networks.
- **Privacy by construction.** The optional analytics store no raw IP and set no cookie; the only secret (`ADMIN_TOKEN`) is off by default and the dashboard returns 503 when unset.

---

## Brand

- Purple/magenta palette (violet `#a855f7` → fuchsia `#c026d3` → pink `#ec4899`), dark glass surfaces.
- X monogram logo; icons regenerated via `frontend/scripts/make-icons.sh`.
- Self-hosted Inter font (no Google Fonts dependency — loads cleanly from restricted networks).
- English-only UI (0 Farsi characters in the bundle).

---

## License & author

MIT — © 2026 Mehrdad Biukian Naeini (SRE, [@mehrdadbn9](https://github.com/mehrdadbn9)). Built and run as a personal self-hosted project.
