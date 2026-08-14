# MusicX

<p align="center">
  <img src="frontend/public/icon-192.png" width="96" alt="MusicX app icon" />
</p>

<h1 align="center">MusicX</h1>

<p align="center">
  <b>Your own music app: search, download, and play like a streaming client — no account, no API key, no cost.</b>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-%E2%9C%93-blue" />
  <img alt="No account" src="https://img.shields.io/badge/no%20account-required-blue" />
  <img alt="AI-style UI" src="https://img.shields.io/badge/UI-modern%20AI%20music%20app%20look-indigo" />
  <img alt="AI DJ" src="https://img.shields.io/badge/AI%20Vibe%20DJ-free%20LLM-cyan" />
</p>

---

MusicX is a self-hosted music app that feels like a proper streaming client, but runs entirely on your own machine. Paste a **Spotify / Deezer / Apple Music / YouTube / SoundCloud** link — or just type what you're in the mood for — and get **tagged audio at the quality you pick** (128 / 192 / 320 kbps MP3, or the original stream untouched).

Then play it back in a real player: full-screen Now Playing with synced lyrics, shuffle/repeat, a mini-player, and a liked shelf that sticks around after a reload.

No accounts. No API keys. No subscriptions. You run it, so the music is yours and nobody sits between you and it.

---

## What's new in v2

This release is a full reskin plus a genuinely useful AI feature:

- **AI Vibe DJ** — describe a mood or a moment ("heavy gym phonk", "lo-fi beats to study", "sunset afro house party") and it builds a real mix from the catalog. It runs on a **free model** (no paid key), and if that model isn't reachable it quietly falls back to an on-device classifier so it always works — even fully offline.
- **Drag-and-drop, everywhere** — reorder your queue by dragging, drag tracks up to "play first", reorder your search results, and even drag the filter tabs (All / Tracks / Artists / Albums / Playlists) into whatever order you like. Your tab order is remembered.
- **Phone access** — expose the app through a Cloudflare tunnel so it loads on your phone from anywhere, no static IP or port-forwarding needed.
- **Plays without the 502s** — Deezer playback now falls back to a 30-second preview when full-length extraction is blocked, so a track always starts instead of erroring out.
- **Fresh look** — slate surfaces, indigo and cyan accents, glass panels, a spinning disc brand mark and a clean three-column layout inspired by modern AI music apps.

---

## Features

### Discover & download
- **One search, every source** — Spotify, Deezer, Apple Music, YouTube and SoundCloud answered together.
- **Paste a link** — drop a track, album or playlist URL from any supported source.
- **Quality you choose** — 128 / 192 / 320 kbps MP3, or the source's original file, always tagged with cover art.
- **Playlists** — create, rename, add/remove tracks, and download the whole thing as a ZIP.
- **Recommendations that respect the catalog** — "more like this" is derived from the actual artist in the title, so non-Latin (Persian/Farsi) music gets sensible picks instead of uploader-seed noise.

### The player (the streaming part)
- **Now Playing overlay** — tap expand for large artwork, a **synced-lyrics tab** (LRC with click-to-seek, plain-text fallback) and a **Queue** tab. Drag down to dismiss.
- **Transport** — play/pause, prev/next, seek, mute, plus **shuffle** and **repeat** (off → all → one), from the bar or the overlay.
- **Mini-player** — collapse the bar to a slim strip and expand whenever.
- **Liked tracks** — heart any track; the list persists to `localStorage` and is reachable from the Library, the right rail, and the left nav.
- **AI Vibe DJ** — see above. Describe a vibe, get a mix, hit play.

### AI Vibe DJ, in detail
- **Generate mix** (instant, offline-capable) — reads the vibe with an on-device classifier and searches the catalog.
- **Enhance with AI** (optional) — asks a free hosted model to craft a smarter mix. No key, no payment; if the model is busy it just uses the instant version.
- Every generated track is playable through the same stream pipeline as everything else, so mixes never 502.

### Drag-and-drop
- Queue rows reorder by dragging; a "play first" action jumps any track to the top.
- Search-result tracks and the result-type filter tabs are draggable too, and tab order is saved locally.

---

## Why it exists

Most "get my music" tools are either a one-shot downloader with no player, or a streaming app that keeps your library behind someone else's account and servers. MusicX is both, on your hardware:

- **You own the files.** Downloads are real tagged MP3s with cover art, in your library.
- **You own the experience.** The player is a proper client — queue, lyrics, liked songs — not a web wrapper.
- **It works where the big players don't.** Self-hosted Inter font (no Google Fonts dependency) and catalog-aware recommendations that survive non-Latin titles.

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

## Quick start

```bash
docker compose up -d --build
# app: http://localhost:8090
```

Optional — enable the AI Vibe DJ's hosted model (otherwise it uses the offline classifier):

```bash
# in .env (gitignored)
OPENROUTER_API_KEY=your_free_key
docker compose up -d --force-recreate api
```

Expose it on your phone (no static IP needed):

```bash
cloudflared tunnel --url http://localhost:8090
```

Backend tests:

```bash
cd backend && .venv/bin/python -m pytest tests/ -q
```

---

## Keyboard shortcuts

`Space` play/pause · `← / →` seek ±10s · `Shift + ← / →` previous/next · `M` mute · `Esc` stop

---

## Privacy

- The optional analytics store no raw IP and set no cookie; the only secret (`ADMIN_TOKEN`) is off by default and the dashboard returns 503 when unset.
- The AI Vibe DJ only sends your vibe text to a free model endpoint when you click "Enhance with AI". The instant "Generate mix" stays fully local.

---

## Brand

- Indigo (`#6366f1`) primary with a cyan (`#22d3ee`) accent on slate surfaces; glass panels and rounded corners. A spinning disc marks the brand.
- Self-hosted Inter font (no Google Fonts dependency — loads cleanly from restricted networks).
- English-only UI.

---

## License & author

MIT — © 2026 Mehrdad Biukian Naeini (SRE, [@mehrdadbn9](https://github.com/mehrdadbn9)). Built and run as a personal self-hosted project.
