# MusicX

A self-hosted web app for searching songs, albums and playlists — or pasting a Spotify/Deezer/Apple Music/YouTube/SoundCloud link — and downloading them as tagged MP3 files at the quality you pick. Fully English UI, purple/magenta palette, X monogram, self-hosted Inter font.

## Product

- Search tracks/albums/artists/playlists, or paste a Spotify/Deezer link.
- Download as tagged MP3 files; per-track quality picker (Original/320/256/192/128).
- Offline content-based recommender ("Similar songs") under each track.
- Playlists: create/list/get/rename/delete/add/remove — backend routes + frontend lib already implemented and tested (56 backend tests pass).
- Full-length playback without downloading first: the player resolves the same upload a download would fetch and proxies its audio.

## Brand

- Name: MusicX. Footer credit: "MusicX — built and run by Mehrdad".
- Palette: violet `#a855f7` -> fuchsia `#c026d3` -> pink `#ec4899` (diagonal 115deg gradient). Dark glass surfaces.
- Logo: white X monogram on gradient tile (inline SVG in app; MVG-rendered PNGs in public/).
- Fonts: self-hosted Inter (400/500/600/700 woff2) in public/fonts/; Vazirmatn kept as fallback so Persian artist/song names render.
- Icons: favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png, favicon.svg, og.png (1200x630). Regenerate with frontend/scripts/make-icons.sh.

## Local stack

- `docker compose up -d --build` from repo root; app on http://localhost:8080 (nginx -> frontend, /api -> backend).
- Backend: FastAPI + recommender (large image ~1.82 GB, intentional — recommender is core).
- Disk hygiene: .env + compose json-file log caps.
