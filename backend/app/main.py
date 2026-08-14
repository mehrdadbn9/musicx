"""MusicX API — resolve music URLs and download their tracks.

Run with:  uvicorn app.main:app --reload --port 8000
"""

import hmac
import io
import os
import re
import threading
import zipfile
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import asynccontextmanager
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import quote, urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import (
    analytics,
    deezer,
    downloader,
    embed,
    itunes,
    jobs,
    library,
    limits,
    lyrics,
    recommender,
    soundcloud,
    streamer,
    ytdlp,
)
from .models import Collection, ProviderError, SearchResult

# Every provider here is keyless and free — no accounts, no API credentials.
SEARCH_TIMEOUT_SECONDS = 20

# Titles read from one collection before the rest are ignored. A centroid is
# settled long before the hundredth track; the cap is there so a 900-track
# discography cannot turn one request into a long lookup loop.
MAX_COLLECTION_TITLES = 100


def resolve_any(url: str) -> Collection:
    """Route a URL to the right metadata provider.

    Deezer / Apple Music URLs go to their public JSON APIs; YouTube and
    SoundCloud go through yt-dlp. Spotify URLs go through the public embed
    pages — no account or API key is ever required.
    """
    if deezer.is_deezer_url(url):
        return deezer.resolve(url)
    if itunes.is_itunes_url(url):
        return itunes.resolve(url)
    # SoundCloud via its web API first — yt-dlp flat playlists often omit
    # titles, artwork and duration. Fall back to yt-dlp if the API is unreachable.
    if soundcloud.is_soundcloud_url(url):
        try:
            return soundcloud.resolve(url)
        except ProviderError:
            return ytdlp.resolve(url)
    if ytdlp.is_supported_url(url):
        return ytdlp.resolve(url)
    spotify_ref = embed.parse_url(url)
    if spotify_ref:
        return embed.resolve(*spotify_ref)
    raise ProviderError(
        "Unsupported link — paste a Spotify, Deezer, Apple Music, "
        "YouTube or SoundCloud URL, or search by name instead."
    )


def provider_of(url: str) -> str:
    """Which catalog a pasted link belongs to — an analytics dimension only."""
    if deezer.is_deezer_url(url):
        return "deezer"
    if itunes.is_itunes_url(url):
        return "apple"
    if soundcloud.is_soundcloud_url(url):
        return "soundcloud"
    if ytdlp.is_supported_url(url):
        return "youtube"
    if embed.parse_url(url):
        return "spotify"
    return "unknown"


def _squash(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — for comparing."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def dedup_key(result: SearchResult) -> str:
    """Identity of a result across providers: kind + name + lead artist.

    Sent to the client too, so it can drop cross-page duplicates that no
    single page could have caught on its own.
    """
    artist = _squash(result.subtitle.split("·")[0])
    return f"{result.kind}:{_squash(result.name).replace(' ', '')}:{artist.replace(' ', '')}"


# Catalog APIs carry cleaner metadata than raw user uploads, so an otherwise
# equal match from Deezer outranks the same song ripped to YouTube.
_SOURCE_WEIGHT = {"deezer": 1.0, "itunes": 0.97, "soundcloud": 0.9, "youtube": 0.87}


def relevance(result: SearchResult, query: str) -> float:
    """0–1 score for how well a result answers the query.

    Compared against the name alone *and* against "name + artist", because
    people search both ways ("bohemian rhapsody" and "queen bohemian").
    """
    q = _squash(query)
    name = _squash(result.name)
    both = f"{name} {_squash(result.subtitle)}".strip()

    score = max(
        SequenceMatcher(None, q, name).ratio(),
        SequenceMatcher(None, q, both).ratio(),
    )
    if name == q:
        score = 1.0
    elif name.startswith(q):
        score = max(score, 0.93)
    elif q in name:
        score = max(score, 0.86)
    # Every word of the query appears somewhere in the title or the artist.
    tokens = set(q.split())
    if tokens and tokens <= set(both.split()):
        score = max(score, 0.8)

    return score * _SOURCE_WEIGHT.get(result.source, 0.85)


def search_any(query: str, page: int = 0) -> tuple[list[SearchResult], bool]:
    """Fan out to every free source in parallel and merge one page of results.

    Each provider pages independently (page N asks each for its own Nth
    slice), near-duplicates keep only the higher-quality hit, and what
    survives is ordered by relevance rather than by which provider answered
    first. A slow or failing source never blocks the others.

    Returns the page plus whether it's worth asking for another one.
    """
    def soundcloud_search(q: str, p: int) -> list[SearchResult]:
        try:
            return soundcloud.search(q, p)  # full parity: tracks/people/albums/sets
        except Exception:
            return ytdlp.search_soundcloud(q, p)  # fallback: tracks only

    providers = [deezer.search, itunes.search, soundcloud_search, ytdlp.search_youtube]

    pool = ThreadPoolExecutor(max_workers=len(providers))
    futures = [pool.submit(p, query, page) for p in providers]
    wait(futures, timeout=SEARCH_TIMEOUT_SECONDS)
    # Don't block on stragglers — abandon anything still running.
    pool.shutdown(wait=False, cancel_futures=True)

    merged: list[SearchResult] = []
    seen: set[str] = set()
    errors: list[Exception] = []
    for future in futures:
        if not future.done():
            continue
        if future.exception():
            errors.append(future.exception())
            continue
        for result in future.result():
            key = dedup_key(result)
            if key in seen:
                continue
            seen.add(key)
            merged.append(result)

    if not merged and errors:
        raise ProviderError(f"Search failed: {errors[0]}")

    merged.sort(key=lambda r: relevance(r, query), reverse=True)
    # Nothing came back for this page, so there is nothing deeper either.
    return merged, bool(merged)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    analytics.start()
    jobs.start_sweeper()
    # The durable library. start() creates the schema; the scan reconciles it
    # with the downloads folder — adopting files finished before a restart and
    # dropping rows whose file was swept — off the startup path so a large
    # folder does not hold the port shut.
    library.start()
    threading.Thread(target=library.scan, name="library-scan", daemon=True).start()
    # Reading 28k rows and fitting a scaler is a second the first curious
    # visitor should not spend. In a thread, and silent when there is no
    # dataset — see recommender.warm().
    threading.Thread(target=recommender.warm, name="recommender-warm", daemon=True).start()
    yield


app = FastAPI(title="MusicX", version="0.0.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ResolveRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    track_ids: list[str] | None = None  # None = everything
    quality: str = downloader.DEFAULT_QUALITY  # mp3 bitrate, or "original"


# Served files are no longer always mp3 — "original" keeps the upload's own
# container, and the browser needs to be told which one it is getting.
_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
}


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/search")
def search(request: Request, q: str, page: int = 0) -> dict:
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Empty search query")
    if page < 0:
        raise HTTPException(status_code=400, detail="Bad page number")
    limits.enforce("search", request)
    try:
        results, has_more = search_any(q, page)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Only the first page counts as "a search" — infinite scroll would
    # otherwise report one curious visitor as five.
    if page == 0:
        analytics.record(
            "search",
            visitor=limits.visitor(request),
            detail="hit" if results else "empty",
            label=" ".join(q.lower().split()),
            value=len(results),
        )
    return {
        "results": [asdict(r) | {"dedup_key": dedup_key(r)} for r in results],
        "page": page,
        "has_more": has_more,
    }


# ---------------------------------------------------------------------------
# AI Vibe DJ — free, keyless LLM (OpenRouter free tier) turns a plain-language
# vibe into a mood profile + a real catalog search. No paid Gemini key needed;
# the model call is server-side so the key never reaches the browser. If the
# model is unreachable we fall back to an on-device keyword classifier.
# ---------------------------------------------------------------------------
import json as _json
import urllib.request as _urllib_request
import urllib.error as _urllib_error

# One free model, short timeout. The free tier is rate-limited and slow, so
# we never block on it: if it doesn't answer with valid JSON in time we fall
# back to the offline classifier (sub-second). A tiny cache keeps repeats
# instant.
_DJ_MODEL = "liquid/lfm-2.5-2.6b:free"
_DJ_TIMEOUT = 8
_DJ_CACHE: dict[str, dict] = {}


def _dj_classify_offline(vibe: str) -> dict:
    """Keyword fallback — mirrors the client classifier; always works."""
    v = vibe.lower()
    energy = "mid"
    genres = []
    if any(w in v for w in ["gym", "workout", "run", "phonk", "party", "club", "rock", "metal", "hype", "pump"]):
        energy = "high"
    if any(w in v for w in ["sleep", "calm", "chill", "relax", "study", "focus", "sad", "rain"]):
        energy = "low"
    for g, pat in {
        "phonk": r"phonk", "lo-fi": r"lo[-\s]?fi", "house": r"house",
        "amapiano": r"amapiano", "edm": r"edm|electronic|techno", "rock": r"rock",
        "jazz": r"jazz", "piano": r"piano", "pop": r"pop", "hiphop": r"hip[-\s]?hop|rap",
        "afro": r"afro", "ambient": r"ambient", "r&b": r"r\s*&\s*b",
    }.items():
        if re.search(pat, v):
            genres.append(g)
    query = genres[0] if genres else " ".join(vibe.split()[:3])
    bpm = "150–180" if energy == "high" else "60–80" if energy == "low" else "90–110"
    return {"energy": energy, "genres": genres or ["mixed"], "query": query, "bpm": bpm,
            "eq": "Punchy low-end" if energy == "high" else "Soft highs" if energy == "low" else "Balanced"}


def _dj_classify_llm(vibe: str, timeout: int = _DJ_TIMEOUT) -> dict | None:
    cached = _DJ_CACHE.get(vibe)
    if cached is not None:
        return cached
    key = os.environ.get("HERMES_CUSTOM_OPENROUTER_AI_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        return None
    prompt = (
        "You are a music DJ. Given a vibe, output ONLY a JSON object with keys: "
        "energy (low|mid|high), genres (array of 1-3 genre words), query (a 1-3 word "
        "search query for a music catalog), bpm (string), eq (short tip). "
        f"Vibe: {vibe!r}. Respond with JSON only, no prose."
    )
    body = _json.dumps({
        "model": _DJ_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 250,
    }).encode()

    def _call():
        req = _urllib_request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with _urllib_request.urlopen(req, timeout=timeout) as r:
            msg = _json.load(r)["choices"][0]["message"]
            return msg.get("content") or msg.get("reasoning") or ""

    try:
        with ThreadPoolExecutor(max_workers=1) as ex:
            text = ex.submit(_call).result(timeout=timeout)
    except Exception:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = _json.loads(text[start:end + 1])
    except Exception:
        return None
    if isinstance(data.get("query"), str) and data["query"].strip():
        result = {
            "energy": data.get("energy", "mid"),
            "genres": data.get("genres") or ["mixed"],
            "query": data["query"].strip(),
            "bpm": str(data.get("bpm", "")),
            "eq": str(data.get("eq", "")),
            "model": _DJ_MODEL,
        }
        _DJ_CACHE[vibe] = result
        return result
    return None


@app.get("/api/dj")
def dj(request: Request, q: str, wait: bool = False) -> dict:
    q = (q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="Empty vibe")
    limits.enforce("search", request)
    # Default: instant offline mix. With wait=true we block on the free LLM
    # (up to ~20s) so the user can explicitly ask for the AI-enhanced mix;
    # the result is cached so a later non-wait call returns it instantly.
    if wait:
        profile = _dj_classify_llm(q, timeout=25) or _dj_classify_offline(q)
    else:
        profile = _dj_classify_offline(q)
        # Kick the LLM in the background so a later wait/refresh reuses it.
        if os.environ.get("OPENROUTER_API_KEY") or os.environ.get("HERMES_CUSTOM_OPENROUTER_AI_API_KEY"):
            def _warm():
                try:
                    _dj_classify_llm(q)
                except Exception:
                    pass
            ThreadPoolExecutor(max_workers=1).submit(_warm)
    try:
        results, has_more = search_any(profile["query"], 0)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "profile": profile,
        "results": [asdict(r) | {"dedup_key": dedup_key(r)} for r in results],
        "has_more": has_more,
    }


@app.get("/api/dj_wait")
def dj_wait(request: Request, q: str) -> dict:
    """Blocking variant: waits for the free LLM before returning."""
    return dj(request, q, wait=True)


@app.get("/api/artist/{artist_id}")
def artist(request: Request, artist_id: str) -> dict:
    if not artist_id.isdigit():
        raise HTTPException(status_code=400, detail="Bad artist id")
    # One Deezer fetch, same cost profile as opening a link.
    limits.enforce("resolve", request)
    try:
        data = deezer.artist(artist_id)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    analytics.record(
        "artist_view",
        visitor=limits.visitor(request),
        source="deezer",
        label=data.get("name"),
    )
    # Same shape as /api/search results, dedup_key included, so the client
    # can render an artist's tracks and albums with the same components.
    for key in ("top_tracks", "albums"):
        data[key] = [asdict(r) | {"dedup_key": dedup_key(r)} for r in data[key]]
    return data


@app.post("/api/resolve")
def resolve(body: ResolveRequest, request: Request) -> dict:
    limits.enforce("resolve", request)
    try:
        collection = resolve_any(body.url)
    except ProviderError as exc:
        analytics.record(
            "resolve_error",
            visitor=limits.visitor(request),
            source=provider_of(body.url),
        )
        raise HTTPException(status_code=400, detail=str(exc))
    analytics.record(
        "resolve",
        visitor=limits.visitor(request),
        source=provider_of(body.url),
        detail=collection.kind,
        label=collection.name,
        value=len(collection.tracks),
    )
    return asdict(collection)


@app.post("/api/download")
def download(body: DownloadRequest, request: Request) -> dict:
    if body.quality not in downloader.QUALITIES:
        raise HTTPException(
            status_code=400,
            detail=f"Quality must be one of: {', '.join(downloader.QUALITIES)}",
        )
    client = limits.enforce("download", request)
    # Before resolving: a caller at their limit shouldn't get a provider fetch
    # out of the request that turns them away.
    if limits.MAX_ACTIVE_JOBS > 0 and jobs.active_count(client) >= limits.MAX_ACTIVE_JOBS:
        raise HTTPException(
            status_code=429,
            detail="Too many downloads at once — wait for one to finish.",
        )

    try:
        collection = resolve_any(body.url)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    tracks = collection.tracks
    if body.track_ids is not None:
        wanted = set(body.track_ids)
        tracks = [t for t in tracks if t.id in wanted]
    if not tracks:
        raise HTTPException(status_code=400, detail="No tracks to download")
    if limits.MAX_TRACKS_PER_JOB > 0 and len(tracks) > limits.MAX_TRACKS_PER_JOB:
        raise HTTPException(
            status_code=400,
            detail=f"Too many tracks — {limits.MAX_TRACKS_PER_JOB} at a time at most.",
        )

    visitor = limits.visitor(request)
    job = jobs.start(
        collection.name,
        tracks,
        body.quality,
        owner=client,
        visitor=visitor,
    )
    analytics.record(
        "download_start",
        visitor=visitor,
        source=provider_of(body.url),
        detail=body.quality,
        label=collection.name,
        value=len(tracks),
    )
    return {"job_id": job.id}


@app.get("/api/recommend")
def recommend(request: Request, q: str, limit: int = 10) -> dict:
    """Songs similar to a title, from the offline content-based model.

    Deliberately not part of /api/search: this answers "what else sounds like
    this", from a fixed 28k-song dataset, and its misses are ordinary — most
    of what the catalogs can find is not in it. Callers feed a pick straight
    back into /api/search to download it.
    """
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Empty search query")
    limit = max(1, min(limit, 50))
    # Same cost profile as a search: one in-process matrix pass, no network.
    limits.enforce("search", request)
    try:
        matched, results = recommender.recommend(q, limit)
    except recommender.RecommenderUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Recommendations unavailable — {exc}")
    except LookupError:
        analytics.record(
            "recommend",
            visitor=limits.visitor(request),
            detail="miss",
            label=" ".join(q.lower().split()),
            value=0,
        )
        raise HTTPException(status_code=404, detail="Song not in the recommendation dataset")
    analytics.record(
        "recommend",
        visitor=limits.visitor(request),
        detail="hit",
        label=matched.track_name,
        value=len(results),
    )
    return {"query": q, "matched": asdict(matched), "results": [asdict(r) for r in results]}


class RecommendCollectionRequest(BaseModel):
    titles: list[str]
    limit: int = 10


@app.post("/api/recommend/collection")
def recommend_collection(body: RecommendCollectionRequest, request: Request) -> dict:
    """Songs that fit a whole album or playlist.

    POST rather than a repeated query parameter: a 900-track discography does
    not belong in a URL. The work is the same single matrix pass a track
    costs — the member lookups are dictionary hits — so it is charged as one
    search, not one per title.
    """
    titles = [t.strip() for t in body.titles if t.strip()][:MAX_COLLECTION_TITLES]
    if not titles:
        raise HTTPException(status_code=400, detail="No track titles to recommend from")
    limit = max(1, min(body.limit, 50))
    limits.enforce("search", request)
    try:
        matched, results = recommender.recommend_for_collection(titles, limit)
    except recommender.RecommenderUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Recommendations unavailable — {exc}")
    except LookupError:
        analytics.record(
            "recommend_collection",
            visitor=limits.visitor(request),
            detail="miss",
            value=0,
        )
        raise HTTPException(
            status_code=404, detail="No track of this collection is in the recommendation dataset"
        )
    analytics.record(
        "recommend_collection",
        visitor=limits.visitor(request),
        detail="hit",
        # How much of the collection the dataset actually knew, which is the
        # number that says whether a thin result is the model's fault.
        value=len(matched),
    )
    return {
        "matched": [asdict(song) for song in matched],
        "matched_count": len(matched),
        "considered": len(titles),
        "results": [asdict(song) for song in results],
    }


class RecommendCatalogRequest(BaseModel):
    artist: str
    # Titles already in the collection, so it is not recommended back to
    # itself. Normalized server-side.
    exclude: list[str] = []
    limit: int = 8


@app.post("/api/recommend/catalog")
def recommend_catalog(body: RecommendCatalogRequest, request: Request) -> dict:
    """"More like this" for music the offline dataset does not cover.

    The content-based model is 28k English songs; Persian and other
    non-Western tracks are simply not in it, and for those the honest answer
    used to be "not in the dataset". This is the fallback: Deezer's own
    related-artists graph, which does know that catalog. No model, no
    dataset — the provider's own notion of adjacency, turned into playable
    titles the user can search and download like any recommendation.

    Always 200 with a (possibly empty) list: it is the last resort, so a
    Deezer miss is "nothing to suggest", not an error.
    """
    artist = body.artist.strip()
    if not artist and not body.exclude:
        raise HTTPException(status_code=400, detail="An artist or a title is required")
    limit = max(1, min(body.limit, 30))
    limits.enforce("search", request)

    exclude = {" ".join(t.lower().split()) for t in body.exclude if t.strip()}
    # re-normalized to match deezer.related_tracks' own key function
    import re as _re

    exclude = {_re.sub(r"[^a-z0-9]+", " ", t).strip() for t in exclude}

    try:
        matched_artist, results = deezer.related_tracks_any(artist, list(body.exclude), exclude, limit)
    except Exception:
        # The fallback's fallback: never surface a provider error from here.
        matched_artist, results = "", []

    analytics.record(
        "recommend_catalog",
        visitor=limits.visitor(request),
        detail="hit" if results else "miss",
        label=matched_artist or artist,
        value=len(results),
    )
    return {"artist": matched_artist or artist, "results": results}


@app.get("/api/recommend/status")
def recommend_status() -> dict:
    """Whether the dataset is installed — the UI hides the feature if not."""
    return recommender.status()


# --------------------------------------------------------------------------
# Library — the durable half of downloads: files that survive a restart, and
# playlists over them. See app/library.py.


@app.get("/api/lyrics")
def lyrics_get(artist: str = "", title: str = "") -> dict:
    """Lyrics for a track, fetched from keyless public sources.

    The player bar calls this with the current queue item. Returns
    {found, synced, plain, source} — `synced` is LRC when the source had it,
    `plain` is always present when found.
    """
    return lyrics.lookup(artist, title)


@app.get("/api/library")
def library_list() -> dict:
    """Every downloaded track this instance still has on disk."""
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    tracks = library.list_tracks()
    return {"tracks": [t.as_dict() for t in tracks], "count": len(tracks)}


@app.get("/api/library/status")
def library_status() -> dict:
    """Track and playlist counts, for the UI to decide whether to show it."""
    return library.status()


@app.get("/api/library/{track_id}/stream")
def library_stream(track_id: int, request: Request) -> FileResponse:
    """Play a track from the library — the file straight off disk.

    A FileResponse, so it answers HTTP Range and the player can seek in it.
    404 rather than 503 when the row or file is gone: the specific track is
    missing, which is what a scan will reconcile on the next restart.
    """
    limits.enforce("file", request)
    path = library.file_path(track_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Track not in the library")
    return FileResponse(
        path,
        media_type=_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        filename=path.name,
    )


@app.delete("/api/library/{track_id}", status_code=204)
def library_delete(track_id: int, request: Request) -> Response:
    """Remove a track from the library and delete its file."""
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    if not library.remove(track_id):
        raise HTTPException(status_code=404, detail="Track not in the library")
    return Response(status_code=204)


@app.get("/api/playlists")
def playlists_list() -> dict:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    return {"playlists": library.list_playlists()}


class PlaylistCreateRequest(BaseModel):
    name: str


@app.post("/api/playlists", status_code=201)
def playlist_create(body: PlaylistCreateRequest) -> dict:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="A playlist name is required")
    return library.create_playlist(name)


@app.get("/api/playlists/{playlist_id}")
def playlist_get(playlist_id: int) -> dict:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    playlist = library.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="No such playlist")
    return playlist


class PlaylistRenameRequest(BaseModel):
    name: str


@app.patch("/api/playlists/{playlist_id}")
def playlist_rename(playlist_id: int, body: PlaylistRenameRequest) -> dict:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    if not library.rename_playlist(playlist_id, body.name):
        raise HTTPException(status_code=404, detail="No such playlist, or empty name")
    return library.get_playlist(playlist_id) or {}


@app.delete("/api/playlists/{playlist_id}", status_code=204)
def playlist_delete(playlist_id: int) -> Response:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    if not library.delete_playlist(playlist_id):
        raise HTTPException(status_code=404, detail="No such playlist")
    return Response(status_code=204)


class PlaylistTrackRequest(BaseModel):
    track_id: int


@app.post("/api/playlists/{playlist_id}/tracks", status_code=204)
def playlist_add_track(playlist_id: int, body: PlaylistTrackRequest) -> Response:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    if not library.add_to_playlist(playlist_id, body.track_id):
        raise HTTPException(status_code=404, detail="No such playlist or track")
    return Response(status_code=204)


@app.delete("/api/playlists/{playlist_id}/tracks/{track_id}", status_code=204)
def playlist_remove_track(playlist_id: int, track_id: int) -> Response:
    if not library.is_available():
        raise HTTPException(status_code=503, detail="Library storage is unavailable")
    if not library.remove_from_playlist(playlist_id, track_id):
        raise HTTPException(status_code=404, detail="Track not in that playlist")
    return Response(status_code=204)


@app.get("/api/jobs")
def job_statuses(ids: str) -> dict:
    """Poll several jobs at once: ?ids=a,b,c

    Unknown ids are omitted rather than raising, so a client restoring a job
    list from a previous session learns which the server has already swept
    without failing the whole poll.
    """
    wanted = [i for i in (part.strip() for part in ids.split(",")) if i][:50]
    return {"jobs": [job.as_dict() for i in wanted if (job := jobs.get(i))]}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job")
    return job.as_dict()


@app.get("/api/jobs/{job_id}/tracks/{track_id}/file")
def track_file(job_id: str, track_id: str, request: Request) -> FileResponse:
    limits.enforce("file", request)
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job")
    state = job.tracks.get(track_id)
    if not state or state.status != "done" or not state.file_path:
        raise HTTPException(status_code=404, detail="Track not ready")
    # The file leaving the server is the closest thing to "a download" in
    # the sense a user means it — everything before this is just a queue.
    analytics.record(
        "file_save",
        visitor=limits.visitor(request),
        detail=job.quality,
        label=f"{', '.join(state.track.artists)} - {state.track.title}",
    )
    return FileResponse(
        state.file_path,
        media_type=_MEDIA_TYPES.get(
            state.file_path.suffix.lower(), "application/octet-stream"
        ),
        filename=state.file_path.name,
    )


@app.get("/api/stream")
def stream_track(
    request: Request,
    title: str,
    artist: str = "",
    duration_ms: int = 0,
    source_url: str | None = None,
    preview_url: str | None = None,
) -> StreamingResponse:
    """Play a track at full length without downloading it first.

    The catalog's own preview is 30 seconds; this resolves the upload the
    downloader would have fetched and proxies its audio. Nothing is written
    to disk — a job is still how you keep a copy.

    Charged against the download limiter rather than the file one: it costs
    an extraction and upstream bandwidth, which is a download's cost profile,
    not a static file's.
    """
    limits.enforce("download", request)
    try:
        track = streamer.track_from_query(title, artist, duration_ms, source_url, preview_url)
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    range_header = request.headers.get("range")

    def attempt(retry_on_stale: bool):
        url = streamer.resolve_audio_url(track)
        try:
            return streamer.open_upstream(url, range_header)
        except streamer.StreamError:
            if not retry_on_stale:
                raise
            # A cached media URL that has expired or was issued to another
            # address fails here; drop it and resolve once more.
            streamer.forget(track)
            url = streamer.resolve_audio_url(track)
            return streamer.open_upstream(url, range_header)

    try:
        status, headers, upstream = attempt(retry_on_stale=True)
    except streamer.StreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    analytics.record(
        "stream",
        visitor=limits.visitor(request),
        label=f"{artist} - {title}".strip(" -"),
    )

    def body():
        try:
            while chunk := upstream.read(streamer.CHUNK_BYTES):
                yield chunk
        finally:
            # The browser abandons a connection on every seek, which arrives
            # here as a closed generator — the socket has to go with it.
            upstream.close()

    return StreamingResponse(
        body(),
        status_code=status,
        headers=headers,
        media_type=headers.get("Content-Type", "audio/mpeg"),
    )


class _ZipSink(io.RawIOBase):
    """Holds what ZipFile writes until the generator can yield it away.

    ZipFile insists on a file object; the response wants an iterator. This
    is the seam. Unseekable on purpose — that makes ZipFile emit each entry
    with a data descriptor instead of rewinding to patch its header, which
    is what allows the archive to be produced in one forward pass.
    """

    def __init__(self) -> None:
        self._chunks: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:  # noqa: ANN001 — memoryview or bytes
        self._chunks.append(bytes(data))
        return len(data)

    def drain(self) -> bytes:
        out = b"".join(self._chunks)
        self._chunks.clear()
        return out


# One track's worth of bytes in flight at a time, not one album's.
_ZIP_CHUNK_BYTES = 256 * 1024


def _zip_chunks(files: list[Path]) -> Iterator[bytes]:
    """Yield a ZIP of `files` as it is built.

    Buffering the whole archive was a memory bomb: a 100-track album at 320
    kbps is a few hundred MB, doubled while the response was assembled, with
    nothing capping how many people asked at once. Stored (not deflated), so
    a file's bytes pass through once and peak memory is one chunk.
    """
    sink = _ZipSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as zf:
        for path in files:
            try:
                source = path.open("rb")
            except OSError:
                continue  # swept mid-download; the rest of the album is fine
            with source, zf.open(path.name, "w") as entry:
                while chunk := source.read(_ZIP_CHUNK_BYTES):
                    entry.write(chunk)
                    if data := sink.drain():
                        yield data
            if data := sink.drain():
                yield data
    # The central directory, written when ZipFile closed.
    if data := sink.drain():
        yield data


@app.get("/api/jobs/{job_id}/zip")
def job_zip(job_id: str, request: Request) -> Response:
    limits.enforce("zip", request)
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job")
    files = [
        s.file_path
        for s in job.tracks.values()
        if s.status == "done" and s.file_path and s.file_path.exists()
    ]
    if not files:
        raise HTTPException(status_code=404, detail="No completed tracks yet")

    analytics.record(
        "zip_download",
        visitor=limits.visitor(request),
        detail=job.quality,
        label=job.name,
        value=len(files),
    )

    # HTTP headers are latin-1 only; non-ASCII names (e.g. "PERSIĀDELICĀ")
    # need the RFC 5987 filename* form with an ASCII fallback.
    name = (job.name or "musicx").replace('"', "").replace("\\", "")
    ascii_name = name.encode("ascii", "ignore").decode().strip() or "musicx"
    disposition = (
        f'attachment; filename="{ascii_name}.zip"; '
        f"filename*=UTF-8''{quote(name)}.zip"
    )
    return StreamingResponse(
        _zip_chunks(files),
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


# --------------------------------------------------------------------------
# Analytics: one beacon in, a token-gated dashboard out.


class CollectRequest(BaseModel):
    """What the browser is allowed to tell us. Everything else is ignored."""

    name: str
    path: str | None = None
    referrer: str | None = None
    device: str | None = None
    standalone: bool = False  # running as an installed PWA
    detail: str | None = None


# The server records everything it can see by itself; these are the few
# things only the browser knows.
_CLIENT_EVENTS = {"page_view", "share", "pwa_install", "install_prompt"}
_DEVICES = {"mobile", "tablet", "desktop"}


def _referrer_host(referrer: str | None, request: Request) -> str | None:
    """Host that sent the visitor, or None for direct and self-referrals."""
    if not referrer:
        return "direct"
    try:
        host = urlparse(referrer).hostname
    except ValueError:
        return None
    if not host or host == request.url.hostname:
        return None  # in-app navigation, not an arrival
    return host[:80]


@app.post("/api/collect", status_code=204)
def collect(body: CollectRequest, request: Request) -> Response:
    """Page views and other browser-only events, from `sendBeacon`.

    Deliberately forgiving: an unknown event name is dropped rather than
    answered with an error, because nothing on the page waits for this
    response and a beacon must never turn into a visible failure.
    """
    limits.enforce("collect", request)
    if body.name in _CLIENT_EVENTS:
        analytics.record(
            body.name,
            surface="pwa" if body.standalone else "web",
            visitor=limits.visitor(request),
            source=_referrer_host(body.referrer, request) if body.name == "page_view" else None,
            detail=body.device if body.device in _DEVICES else body.detail,
            # Query strings can carry a search term; the search event already
            # records those properly, so keep paths to the path.
            label=(body.path or "/").split("?")[0][:120],
        )
    return Response(status_code=204)


ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")


def require_admin(request: Request) -> None:
    """Bearer-token gate. Unset token means the dashboard does not exist."""
    if not ADMIN_TOKEN:
        raise HTTPException(
            status_code=503, detail="Admin dashboard is off — set ADMIN_TOKEN to enable it."
        )
    header = request.headers.get("authorization", "")
    token = header[7:] if header[:7].lower() == "bearer " else ""
    if not hmac.compare_digest(token, ADMIN_TOKEN):
        # Charged only on failure, so normal polling is never throttled.
        limits.enforce("admin", request)
        raise HTTPException(status_code=401, detail="Bad admin token")


@app.get("/api/admin/stats")
def admin_stats(request: Request, days: int = 30) -> dict:
    require_admin(request)
    days = max(1, min(days, analytics.RETENTION_DAYS))
    return analytics.stats(days) | {"live": jobs.live_counts()}


@app.get("/api/admin/events")
def admin_events(request: Request, limit: int = 200) -> dict:
    """Raw event feed — for confirming the wiring works, not for reading."""
    require_admin(request)
    return {"events": analytics.recent(limit)}


@app.get("/api/admin/extraction")
def admin_extraction(request: Request) -> dict:
    """What the anti-bot settings resolved to inside the container.

    Both of them are mounts and environment variables rather than code, so
    the failure they share is arriving at neither: YouTube answers "sign in
    to confirm you're not a bot" the same way whether the provider is
    unreachable, the cookie file never got mounted, or both are fine and the
    IP is simply burnt. This says which of those it is.
    """
    require_admin(request)
    return ytdlp.status()
