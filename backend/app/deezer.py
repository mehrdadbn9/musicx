"""Search and resolve via Deezer's public API — no key, no account.

Deezer exposes its catalog (search, tracks, albums, playlists) at
api.deezer.com without any authentication, which makes it a perfect
metadata source for in-app search. The downloader only needs
artist + title + duration, so where the metadata comes from doesn't
matter — the audio is found on YouTube either way.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .models import Collection, ProviderError, SearchResult, Track

_API = "https://api.deezer.com"
_URL_RE = re.compile(
    r"deezer\.com/(?:[a-z]{2}/)?(track|album|playlist)/(\d+)"
)


def is_deezer_url(url: str) -> bool:
    return _URL_RE.search(url) is not None


def _get(path: str, **params) -> dict:
    url = f"{_API}{path}"
    if params:
        url += "?" + urlencode(params)
    try:
        with urlopen(Request(url), timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except URLError as exc:
        raise ProviderError(f"Could not reach Deezer: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise ProviderError("Deezer returned an unreadable response.") from exc
    if isinstance(data, dict) and data.get("error"):
        message = data["error"].get("message", "unknown error")
        raise ProviderError(f"Deezer API error: {message}")
    return data


def _track_result(item: dict) -> SearchResult:
    return SearchResult(
        kind="track",
        id=str(item["id"]),
        url=item.get("link", f"https://www.deezer.com/track/{item['id']}"),
        name=item.get("title", ""),
        subtitle=(item.get("artist") or {}).get("name", ""),
        cover_url=(item.get("album") or {}).get("cover_medium"),
    )


def _album_result(item: dict, artist: str = "") -> SearchResult:
    year = (item.get("release_date") or "")[:4]
    record_type = (item.get("record_type") or "").upper()
    artist = (item.get("artist") or {}).get("name") or artist
    subtitle = " · ".join(p for p in (artist, year, record_type if record_type not in ("", "ALBUM") else "") if p)
    return SearchResult(
        kind="album",
        id=str(item["id"]),
        url=item.get("link", f"https://www.deezer.com/album/{item['id']}"),
        name=item.get("title", ""),
        subtitle=subtitle,
        cover_url=item.get("cover_medium"),
    )


def _artist_result(item: dict) -> SearchResult:
    count = item.get("nb_album")
    return SearchResult(
        kind="artist",
        id=str(item["id"]),
        url=item.get("link", f"https://www.deezer.com/artist/{item['id']}"),
        name=item.get("name", ""),
        subtitle=f"{count} releases" if count else "Artist",
        cover_url=item.get("picture_medium"),
    )


def _playlist_result(item: dict) -> SearchResult:
    owner = (item.get("user") or {}).get("name", "")
    count = item.get("nb_tracks")
    subtitle = " · ".join(
        part
        for part in (f"by {owner}" if owner else "", f"{count} tracks" if count else "")
        if part
    )
    return SearchResult(
        kind="playlist",
        id=str(item["id"]),
        url=item.get("link", f"https://www.deezer.com/playlist/{item['id']}"),
        name=item.get("title", ""),
        subtitle=subtitle,
        cover_url=item.get("picture_medium"),
    )


# Per-page quota for each of the four sub-searches. Deezer pages with an
# absolute `index`, so page N asks for index = N * quota.
PAGE_QUOTA = {"track": 30, "album": 20, "artist": 12, "playlist": 12}


def search(query: str, page: int = 0) -> list[SearchResult]:
    """Tracks, albums, artists and playlists — the four calls run in parallel."""
    index = lambda kind: page * PAGE_QUOTA[kind]  # noqa: E731
    with ThreadPoolExecutor(max_workers=4) as pool:
        tracks = pool.submit(
            _get, "/search/track", q=query,
            limit=PAGE_QUOTA["track"], index=index("track"),
        )
        albums = pool.submit(
            _get, "/search/album", q=query,
            limit=PAGE_QUOTA["album"], index=index("album"),
        )
        artists = pool.submit(
            _get, "/search/artist", q=query,
            limit=PAGE_QUOTA["artist"], index=index("artist"),
        )
        playlists = pool.submit(
            _get, "/search/playlist", q=query,
            limit=PAGE_QUOTA["playlist"], index=index("playlist"),
        )

    results: list[SearchResult] = []
    results += [_track_result(i) for i in tracks.result().get("data") or []]
    results += [_album_result(i) for i in albums.result().get("data") or []]
    results += [_artist_result(i) for i in artists.result().get("data") or []]
    results += [_playlist_result(i) for i in playlists.result().get("data") or []]
    return results


def artist(artist_id: str) -> dict:
    """Full artist page: profile, top tracks, and complete discography."""
    with ThreadPoolExecutor(max_workers=3) as pool:
        profile_f = pool.submit(_get, f"/artist/{artist_id}")
        top_f = pool.submit(_get, f"/artist/{artist_id}/top", limit=10)
        albums_f = pool.submit(_get, f"/artist/{artist_id}/albums", limit=100)

    profile = profile_f.result()
    name = profile.get("name", "")

    top = [_track_result(item) for item in top_f.result().get("data") or []]

    # Discography is paginated via an absolute "next" URL, like playlists.
    page = albums_f.result()
    items = list(page.get("data") or [])
    next_url = page.get("next")
    while next_url:
        page = json.loads(urlopen(Request(next_url), timeout=15).read().decode())
        items.extend(page.get("data") or [])
        next_url = page.get("next")
    items.sort(key=lambda i: i.get("release_date") or "", reverse=True)
    albums = [_album_result(item, artist=name) for item in items]

    return {
        "id": str(profile.get("id", artist_id)),
        "name": name,
        "picture_url": profile.get("picture_big") or profile.get("picture_medium"),
        "fan_count": profile.get("nb_fan"),
        "top_tracks": top,
        "albums": albums,
    }


def _name_matches(candidate: str, hit_name: str) -> bool:
    """Whether Deezer's top hit plausibly *is* the candidate — the gate that
    stops a fuzzy match to an unrelated artist ("Lyra Entertainment" ->
    "LAVA ENTERTAINMENT") from being handed out as a recommendation."""
    if not hit_name:
        return False
    # Non-ASCII candidate (Persian, ...): Deezer stores the Latin
    # transliteration, so no token can line up — trust the search engine.
    if re.search(r"[^\x00-\x7f]", candidate):
        return True
    c = re.sub(r"[^a-z0-9]+", " ", candidate.lower()).strip()
    h = re.sub(r"[^a-z0-9]+", " ", hit_name.lower()).strip()
    if not c or not h:
        return False
    return c in h or h in c


def related_tracks_any(
    artist_name: str, titles: list[str], exclude: set[str], limit: int = 8
) -> tuple[str, list[dict]]:
    """Try several artist candidates, in order, until one is a real match.

    The seed the UI sends is often an *uploader* — a YouTube channel or
    SoundCloud handle ("Lyra Entertainment", "alireza.siavash") — not the
    musician, so a single Deezer search for it can miss entirely or land on
    an unrelated artist. The real artist is usually the leading name in the
    track titles themselves ("Moein - Vaghti To Ba Man Nisti" -> "Moein"),
    so each title is split on the separators these catalogs use and the
    first segment tried in turn.

    A candidate only wins when Deezer's top hit for it actually matches the
    name (see _name_matches) — a fuzzy hit like "LAVA ENTERTAINMENT" for
    "Lyra Entertainment" is skipped so the title-derived artist gets its
    turn. If no candidate passes the gate but one produced results anyway,
    those are returned as the last resort. Returns the winning artist name
    plus its related tracks — the empty string and an empty list when
    nothing matched.
    """
    candidates: list[str] = [artist_name]
    for title in titles:
        for part in re.split(r"\s+[-–—|:،/]\s*|[-–—|]+\s*", title):
            part = part.strip()
            if not part or len(part) < 2:
                continue
            # Drop the "Topic", "(Official Video)", "Lyrics" etc. suffixes
            # that ride along in these catalogs' titles.
            part = re.sub(
                r"\s*-\s*(?:Topic|Topic\s*Videos?|Official\s+(?:Audio|Video|Lyric)|Lyrics?|Audio|Video|Music\s*Video|With\s*Lyrics)\s*$",
                "",
                part,
                flags=re.IGNORECASE,
            ).strip()
            if part and part not in candidates:
                candidates.append(part)
    best_hit, best_results = "", []
    for candidate in candidates:
        if not candidate.strip():
            continue
        hit_name, results = _related_tracks_with_hit(candidate, exclude, limit)
        if not results:
            continue
        if _name_matches(candidate, hit_name):
            return candidate, results
        if not best_results:
            best_hit, best_results = hit_name, results
    return best_hit, best_results


def _related_tracks_with_hit(
    artist_name: str, exclude: set[str], limit: int = 8
) -> tuple[str, list[dict]]:
    """“More like this” for music the offline dataset does not cover.

    The content-based recommender is 28k English songs; a Persian or other
    non-Western track is simply not in it. Deezer's own catalog is, and it
    knows two things worth using: an artist's *related artists*, and each
    artist's *top tracks*. The union — this artist's own songs plus the hits
    of the artists Deezer files next to them — is a serviceable "if you like
    X" without any model at all.

    `exclude` holds already-known titles (normalized) so a collection's own
    tracks are not recommended back to it. Returns dicts shaped like the
    dataset recommender's rows, so one renderer draws both.

    Best-effort: any Deezer hiccup yields an empty list rather than an error,
    because this is itself the fallback path.
    """
    try:
        hits = (_get("/search/artist", q=artist_name, limit=1).get("data")) or []
    except ProviderError:
        return "", []
    if not hits:
        return "", []

    hit_name = hits[0].get("name", "")
    artist_id = hits[0]["id"]
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            related_f = pool.submit(_get, f"/artist/{artist_id}/related", limit=6)
            own_f = pool.submit(_get, f"/artist/{artist_id}/top", limit=12)
        related = (related_f.result().get("data")) or []
        own = (own_f.result().get("data")) or []
    except ProviderError:
        return hit_name, []

    # One top track from each related artist, fetched in parallel. Their names
    # are the recommendation; the specific track is just a way to play one.
    def top_of(rel: dict) -> list[dict]:
        try:
            return (_get(f"/artist/{rel['id']}/top", limit=2).get("data")) or []
        except ProviderError:
            return []

    related_tracks_lists: list[list[dict]] = []
    if related:
        with ThreadPoolExecutor(max_workers=min(6, len(related))) as pool:
            related_tracks_lists = list(pool.map(top_of, related))

    # The artist's own songs first (closest to the seed), then the related
    # artists' hits. De-duplicated by normalized title, and never a title the
    # collection already contains.
    seen = set(exclude)
    out: list[dict] = []

    def add(item: dict) -> None:
        title = item.get("title") or ""
        key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not key or key in seen:
            return
        seen.add(key)
        artist = (item.get("artist") or {}).get("name", "")
        out.append(
            {
                "track_name": title,
                "artist_name": artist,
                "genre": "",
                "release_date": 0,
                "similarity": None,
            }
        )

    # Roughly half the slots to the seed artist's own songs, the rest to the
    # related artists — otherwise a prolific artist's own top tracks fill the
    # whole list and it reads as "more by this artist" rather than "more like".
    own_quota = max(1, limit // 2)
    for item in own[: own_quota * 2]:
        add(item)
        if sum(1 for _ in out) >= own_quota:
            break

    for item in _interleave(related_tracks_lists):
        add(item)
        if len(out) >= limit:
            break

    # Backfill from the seed artist if the related artists were thin, so the
    # list still reaches `limit` rather than stopping half full.
    if len(out) < limit:
        for item in own:
            add(item)
            if len(out) >= limit:
                break

    return hit_name, out[:limit]


def related_tracks(artist_name: str, exclude: set[str], limit: int = 8) -> list[dict]:
    """Results-only wrapper, for callers that do not need the matched name."""
    return _related_tracks_with_hit(artist_name, exclude, limit)[1]


def _interleave(lists: list[list[dict]]):
    """Yield one item from each list in turn until all are exhausted."""
    index = 0
    while True:
        drained = True
        for entries in lists:
            if index < len(entries):
                drained = False
                yield entries[index]
        if drained:
            return
        index += 1


def _track_from_api(item: dict, album_name: str = "", cover_url: str | None = None) -> Track:
    album = item.get("album") or {}
    return Track(
        id=str(item["id"]),
        title=item.get("title", "Unknown"),
        artists=[(item.get("artist") or {}).get("name", "Unknown")],
        album=album.get("title", album_name),
        duration_ms=int(item.get("duration") or 0) * 1000,
        cover_url=album.get("cover_big") or cover_url,
        track_number=item.get("track_position", 0),
        release_date=(item.get("release_date") or "")[:4],
        preview_url=item.get("preview") or None,
    )


def resolve(url: str) -> Collection:
    match = _URL_RE.search(url)
    if not match:
        raise ProviderError("That doesn't look like a Deezer URL.")
    kind, deezer_id = match.group(1), match.group(2)

    if kind == "track":
        item = _get(f"/track/{deezer_id}")
        track = _track_from_api(item)
        return Collection(
            kind="track",
            name=track.title,
            owner=", ".join(track.artists),
            cover_url=track.cover_url,
            tracks=[track],
        )

    if kind == "album":
        album = _get(f"/album/{deezer_id}")
        cover = album.get("cover_big")
        name = album.get("title", "")
        year = (album.get("release_date") or "")[:4]
        artist = (album.get("artist") or {}).get("name", "")
        tracks = []
        for i, item in enumerate((album.get("tracks") or {}).get("data") or [], 1):
            track = _track_from_api(item, album_name=name, cover_url=cover)
            track.cover_url = track.cover_url or cover
            track.track_number = track.track_number or i
            track.release_date = track.release_date or year
            tracks.append(track)
        return Collection(
            kind="album", name=name, owner=artist, cover_url=cover, tracks=tracks
        )

    # playlist — track list is paginated via an absolute "next" URL
    playlist = _get(f"/playlist/{deezer_id}")
    cover = playlist.get("picture_big")
    tracks_page = playlist.get("tracks") or {}
    items = list(tracks_page.get("data") or [])
    next_url = tracks_page.get("next")
    while next_url:
        page = json.loads(urlopen(Request(next_url), timeout=15).read().decode())
        items.extend(page.get("data") or [])
        next_url = page.get("next")
    tracks = [_track_from_api(item, cover_url=cover) for item in items]
    return Collection(
        kind="playlist",
        name=playlist.get("title", ""),
        owner=(playlist.get("creator") or {}).get("name", ""),
        cover_url=cover,
        tracks=tracks,
    )
