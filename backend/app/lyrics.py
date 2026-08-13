"""Lyrics lookup — keyless and free, like every other provider in this app.

Primary source is lrclib.net (synced LRC plus plain text); lyrics.ovh is the
fallback for tracks lrclib has never seen. Both are public APIs that need no
account. Nothing is written to disk; a small in-memory cache means replaying
the same track in a session does not hit the network again.

The lookup runs inside FastAPI's threadpool (the route is a sync `def`), so
the blocking urllib calls here never stall the event loop.
"""

import json
import re
import time
import urllib.parse
import urllib.request

LRCLIB_BASE = "https://lrclib.net/api"
LYRICS_OVH = "https://api.lyrics.ovh/v1"
TIMEOUT_SECONDS = 10
_CACHE_TTL_SECONDS = 6 * 3600

# A single [mm:ss.xx] timestamp tag at the start of an LRC line.
_LRC_TAG = re.compile(r"\[(\d{1,2}:)?\d{1,2}([.:]\d{1,3})?\]")

_cache: dict[tuple[str, str], tuple[float, dict | None]] = {}


def _fetch(url: str) -> bytes | None:
    req = urllib.request.Request(
        url, headers={"User-Agent": "MusicX/1.0 (self-hosted, keyless)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            if resp.status != 200:
                return None
            return resp.read()
    except Exception:
        return None


def _lrc_to_plain(lrc: str) -> str:
    """Strip the [mm:ss.xx] tags from synced lyrics, keep the words."""
    lines = []
    for line in lrc.splitlines():
        text = _LRC_TAG.sub("", line).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def _result(synced: str | None, plain: str | None, source: str) -> dict:
    if not synced and not plain:
        return {"found": False}
    return {
        "found": True,
        "synced": synced,
        "plain": plain or (_lrc_to_plain(synced) if synced else None),
        "source": source,
    }


def _lookup_uncached(artist: str, title: str) -> dict:
    # lrclib's /api/get is exact-match on artist + track. Best first.
    params = urllib.parse.urlencode({"artist_name": artist, "track_name": title})
    raw = _fetch(f"{LRCLIB_BASE}/get?{params}")
    if raw:
        try:
            data = json.loads(raw)
            return _result(
                data.get("syncedLyrics") or None,
                data.get("plainLyrics") or None,
                "lrclib",
            )
        except (ValueError, TypeError):
            pass

    # /api/search is fuzzy; take the first hit that actually has lyrics.
    q = urllib.parse.urlencode({"q": f"{artist} {title}".strip()})
    raw = _fetch(f"{LRCLIB_BASE}/search?{q}")
    if raw:
        try:
            for hit in json.loads(raw) or []:
                result = _result(
                    hit.get("syncedLyrics") or None,
                    hit.get("plainLyrics") or None,
                    "lrclib",
                )
                if result["found"]:
                    return result
        except (ValueError, TypeError):
            pass

    # Last resort: lyrics.ovh, plain text only, often sparser than lrclib.
    path = f"{LYRICS_OVH}/{urllib.parse.quote(artist)}/{urllib.parse.quote(title)}"
    raw = _fetch(path)
    if raw:
        try:
            data = json.loads(raw)
            lyrics = data.get("lyrics")
            if lyrics and lyrics != "No lyrics found":
                return {"found": True, "synced": None, "plain": lyrics, "source": "lyrics.ovh"}
        except (ValueError, TypeError):
            pass

    return {"found": False}


def lookup(artist: str, title: str) -> dict:
    """Lyrics for a track. `title` must be non-empty; `artist` can be empty
    for instrumentals and one-off uploads whose artist field is blank."""
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not title:
        return {"found": False}

    key = (artist.lower(), title.lower())
    now = time.time()
    cached = _cache.get(key)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1] if cached[1] is not None else {"found": False}

    result = _lookup_uncached(artist, title)
    # Negative results are cached too — a miss for a track won't change for
    # six hours, and re-querying every click is just noise against the APIs.
    _cache[key] = (now, result if result["found"] else None)
    return result
