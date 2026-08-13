"""Full-length playback without downloading first.

A catalog track's `preview_url` is 30 seconds — that is all Deezer, iTunes
and the Spotify embed publish, and no parameter makes it longer. So playing
a whole song used to mean downloading it and waiting.

This resolves the same upload the downloader would have picked and hands its
audio straight to the browser instead of to a file. Nothing is written to
disk and nothing is added to a job; it is playback, not a download.

Two details make it work at all:

- **It proxies rather than redirects.** The direct URL yt-dlp returns is
  issued against the *server's* address and, on YouTube, tied to it — a
  browser on a different address gets a 403. The bytes have to come back
  through here.
- **Range requests are passed through.** Seeking is a Range request, and an
  <audio> element that cannot get one plays but will not scrub.

Resolved URLs are cached briefly: a seek re-requests the stream, and paying
for a fresh yt-dlp extraction on every scrub would make the bar unusable.
They also expire upstream, hence the short TTL rather than a permanent map.
"""

import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from yt_dlp import YoutubeDL

from .models import ProviderError, Track
from .ytdlp import base_opts

# How long a resolved media URL is reused. YouTube's expire within hours;
# this is short enough to stay inside that and long enough that scrubbing
# through one song never re-resolves.
CACHE_TTL_SECONDS = 900

# Enough for the player to start and seek; the browser asks for more as it
# needs it. Without a ceiling one paused tab would pull a whole file.
CHUNK_BYTES = 64 * 1024

_cache: dict[str, tuple[float, str]] = {}
_lock = threading.Lock()


class StreamError(Exception):
    """Nothing playable could be resolved for this track."""


def _cached(key: str) -> str | None:
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        expires, url = entry
        if expires < time.time():
            del _cache[key]
            return None
        return url


def _remember(key: str, url: str) -> None:
    with _lock:
        # Bounded so a long session cannot grow it without limit; these are
        # cheap to re-resolve, so the crude eviction costs one extraction.
        if len(_cache) > 256:
            _cache.clear()
        _cache[key] = (time.time() + CACHE_TTL_SECONDS, url)


def _is_direct_media(url: str | None) -> bool:
    """True when `url` already points at playable audio we can proxy as-is.

    Deezer's CDN preview (cdnt-preview/cdns-preview .dzcdn.net) is a signed,
    directly-fetchable MP3 — no yt-dlp extraction needed, which also sidesteps
    the datacenter-IP YouTube block that would otherwise 502.
    """
    if not url:
        return False
    # Deezer's CDN URL is `…/something.mp3?hdnea=…` — the extension is not at
    # the very end because of the signed query string, so match on presence of
    # the extension rather than a strict suffix.
    return "dzcdn.net" in url and ".mp3" in url.lower()


def resolve_audio_url(track: Track) -> str:
    """The direct media URL for `track`, resolved the way a download would.

    Uses the track's own page when it has one, otherwise the same search the
    downloader runs — so what plays is what would have been downloaded.
    """
    key = track.source_url or track.query
    cached = _cached(key)
    if cached:
        return cached

    # A Deezer CDN preview (or any directly-playable CDN clip) is already
    # audio — proxy it instead of running yt-dlp, which would resolve a 30s
    # clip anyway and, on a datacenter IP, get bot-blocked into a 502.
    if _is_direct_media(track.source_url):
        _remember(key, track.source_url)
        return track.source_url
    if _is_direct_media(track.preview_url):
        pkey = f"preview:{track.preview_url}"
        pcached = _cached(pkey)
        if pcached:
            return pcached
        _remember(pkey, track.preview_url)
        return track.preview_url

    # Imported here to keep the module import cheap and to avoid a cycle:
    # downloader imports nothing from this file, and this needs its search.
    from .downloader import DownloadError, search_source

    page_url = track.source_url
    if not page_url:
        try:
            page_url = search_source(track)
        except DownloadError as exc:
            raise StreamError(str(exc)) from exc

    opts = base_opts(format="bestaudio/best", noplaylist=True, socket_timeout=15)
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as exc:  # extractor errors are all "cannot play this"
        raise StreamError(f"could not resolve audio: {exc}") from exc

    if info.get("is_live"):
        # Same rule as the downloader: an endless source is not a track.
        raise StreamError("live streams cannot be played as a track")

    url = info.get("url")
    if not url:
        # A merged format has no single URL; pick the best audio-only one.
        formats = [f for f in (info.get("formats") or []) if f.get("acodec") not in (None, "none")]
        if formats:
            url = formats[-1].get("url")
    if not url:
        raise StreamError("no audio stream in that upload")

    _remember(key, url)
    return url


def open_upstream(url: str, range_header: str | None) -> tuple[int, dict[str, str], object]:
    """Open `url`, forwarding a Range header, and return (status, headers, body).

    The caller streams `body` back and copies the headers that matter, so a
    206 upstream stays a 206 downstream — which is what makes seeking work.
    """
    headers = {
        # Some CDNs serve differently (or refuse) without a browser UA.
        "User-Agent": "Mozilla/5.0",
    }
    if range_header:
        headers["Range"] = range_header

    request = Request(url, headers=headers)
    try:
        response = urlopen(request, timeout=20)
    except HTTPError as exc:
        # 403 here is usually an expired or address-bound media URL; the
        # caller drops the cache entry and the next attempt re-resolves.
        raise StreamError(f"upstream refused the stream ({exc.code})") from exc
    except URLError as exc:
        raise StreamError(f"upstream unreachable: {exc.reason}") from exc

    passthrough = {}
    for name in ("Content-Length", "Content-Range", "Content-Type", "Accept-Ranges"):
        value = response.headers.get(name)
        if value:
            passthrough[name] = value
    passthrough.setdefault("Accept-Ranges", "bytes")
    return response.status, passthrough, response


def forget(track: Track) -> None:
    """Drop a cached URL — called when upstream rejects it as stale."""
    with _lock:
        _cache.pop(track.source_url or track.query, None)


def track_from_query(
    title: str,
    artist: str,
    duration_ms: int,
    source_url: str | None,
    preview_url: str | None = None,
) -> Track:
    """The minimum Track the resolver needs, built from query parameters.

    Only `query` and `source_url` are read downstream, but duration is
    carried through because it is what makes the search pick the right
    upload rather than a remix or an hour-long mix. `preview_url` is a
    last-resort playable fallback when no full-length source resolves.
    """
    if not title.strip():
        raise ProviderError("A title is required to play a track")
    return Track(
        id="stream",
        title=title.strip(),
        artists=[artist.strip()] if artist.strip() else [],
        album="",
        duration_ms=max(0, duration_ms),
        cover_url=None,
        source_url=source_url or None,
        preview_url=preview_url or None,
    )
