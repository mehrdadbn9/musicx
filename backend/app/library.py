"""A durable library of downloaded tracks, and playlists over them.

Downloads themselves are ephemeral: jobs live in memory (app/jobs.py) and
vanish on restart, taking their per-track file links with them even though
the audio is still on disk. That is fine for "is this download finished
yet" and wrong for "play the music I have" — which is what a library is.

So this is the persistent half. A SQLite database on the data volume records
every finished file — where it is, what it is — and playlists are rows that
point at those records. Two things keep it honest across a restart:

  * `add()` is called the moment a track finishes, so a running instance
    never has a file it has forgotten.
  * `scan()` walks the downloads folder at startup and reconciles: files on
    disk with no row are adopted (a job that finished before this code
    existed, or before a crash), and rows whose file is gone are dropped.

Streaming a library track is an ordinary FileResponse in main.py, which
already speaks HTTP Range — so the player can seek in it exactly as it seeks
in a fresh download.

mutagen is a core dependency (it is what tags a download in the first
place), so reading tags back here costs no optional extra.
"""

import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

DB_PATH = Path(
    os.getenv("LIBRARY_DB_PATH", Path(__file__).resolve().parent.parent / "data" / "library.db")
)

# Extensions the downloader can produce (see downloader.QUALITIES / originals).
_AUDIO_EXTS = {".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav", ".aac"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path   TEXT NOT NULL UNIQUE,   -- path under DOWNLOADS_DIR: the file's identity
    title      TEXT NOT NULL,
    artist     TEXT NOT NULL DEFAULT '',
    album      TEXT NOT NULL DEFAULT '',
    ext        TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    cover_url  TEXT,
    job_id     TEXT,
    added_at   INTEGER NOT NULL        -- unix seconds
);
CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS pt_playlist ON playlist_tracks (playlist_id, position);
"""

_lock = threading.Lock()
_ready = False


class LibraryUnavailable(RuntimeError):
    """The data volume could not be opened — the feature is simply off."""


@dataclass
class LibraryTrack:
    id: int
    title: str
    artist: str
    album: str
    ext: str
    size: int
    duration_ms: int
    cover_url: str | None
    rel_path: str
    added_at: int

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "ext": self.ext,
            "size": self.size,
            "duration_ms": self.duration_ms,
            "cover_url": self.cover_url,
            "added_at": self.added_at,
        }


def _downloads_dir() -> Path:
    # Imported lazily to avoid a circular import: jobs imports downloader,
    # and nothing here needs the rest of jobs.
    from .jobs import DOWNLOADS_DIR

    return DOWNLOADS_DIR


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def start() -> None:
    """Open the database and create the schema. Safe to call twice."""
    global _ready
    with _lock:
        if _ready:
            return
        try:
            DB_PATH.parent.mkdir(parents=True, exist_ok=True)
            conn = _connect()
            conn.executescript(_SCHEMA)
            conn.commit()
            conn.close()
            _ready = True
        except Exception:
            # An unwritable volume disables the library, exactly as it does
            # analytics — the app still downloads and plays.
            _ready = False


def is_available() -> bool:
    return _ready


def _require() -> None:
    if not _ready:
        raise LibraryUnavailable("Library storage is not available")


# --------------------------------------------------------------------------
# ingest


def _read_tags(path: Path) -> tuple[str, str, str, int]:
    """(title, artist, album, duration_ms) from a file's own tags.

    Falls back to the filename for the title, since the download names the
    file "Artist - Title" and a missing tag should still be recognisable.
    """
    title = path.stem
    artist = album = ""
    duration_ms = 0
    # " - " splits the download's own "Artist - Title" stem as a last resort.
    if " - " in path.stem:
        maybe_artist, maybe_title = path.stem.split(" - ", 1)
        artist, title = maybe_artist.strip(), maybe_title.strip()
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path)
        if audio is not None:
            if audio.info and getattr(audio.info, "length", 0):
                duration_ms = int(audio.info.length * 1000)
            tags = audio.tags or {}

            def first(*keys) -> str:
                for key in keys:
                    if key in tags:
                        value = tags[key]
                        text = value[0] if isinstance(value, list) else value
                        text = str(text).strip()
                        if text:
                            return text
                return ""

            # ID3 (TIT2/TPE1/TALB), MP4 atoms, and Vorbis comments in turn.
            title = first("TIT2", "\xa9nam", "title") or title
            artist = first("TPE1", "\xa9ART", "artist") or artist
            album = first("TALB", "\xa9alb", "album") or album
    except Exception:
        # A file mutagen cannot parse still belongs in the library under its
        # filename — better a plain entry than a missing song.
        pass
    return title, artist, album, duration_ms


def add(rel_path: str, *, title: str, artist: str, album: str, cover_url: str | None, job_id: str,
        duration_ms: int = 0) -> None:
    """Record a freshly downloaded file. Called from the job on completion.

    Keyed by rel_path, so re-adding the same file (a re-download to the same
    stem) updates the row rather than duplicating it.
    """
    if not _ready:
        return  # a download must still succeed with the library off
    absolute = _downloads_dir() / rel_path
    try:
        size = absolute.stat().st_size
    except OSError:
        size = 0
    ext = absolute.suffix.lstrip(".")
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """INSERT INTO tracks (rel_path, title, artist, album, ext, size,
                        duration_ms, cover_url, job_id, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(rel_path) DO UPDATE SET
                        title=excluded.title, artist=excluded.artist,
                        album=excluded.album, ext=excluded.ext, size=excluded.size,
                        duration_ms=excluded.duration_ms, cover_url=excluded.cover_url,
                        job_id=excluded.job_id""",
                (rel_path, title or absolute.stem, artist, album, ext, size,
                 duration_ms, cover_url, job_id, int(time.time())),
            )
            conn.commit()
        finally:
            conn.close()


def scan() -> dict:
    """Reconcile the database with the downloads folder. Returns counts.

    Adopt files with no row (finished before this ran, or before a crash),
    and drop rows whose file has been swept or deleted out from under them.
    Cheap enough to run at every startup: a stat() per file.
    """
    if not _ready:
        return {"added": 0, "removed": 0}
    root = _downloads_dir()
    added = removed = 0
    with _lock:
        conn = _connect()
        try:
            known = {row["rel_path"] for row in conn.execute("SELECT rel_path FROM tracks")}

            on_disk: set[str] = set()
            if root.exists():
                for path in root.rglob("*"):
                    if not path.is_file() or path.suffix.lower() not in _AUDIO_EXTS:
                        continue
                    rel = str(path.relative_to(root))
                    on_disk.add(rel)
                    if rel in known:
                        continue
                    title, artist, album, duration_ms = _read_tags(path)
                    try:
                        size = path.stat().st_size
                    except OSError:
                        size = 0
                    # job_id is the first path segment for a normal download
                    # (downloads/<job>/<file>); harmless if the layout differs.
                    job_id = path.relative_to(root).parts[0] if len(path.relative_to(root).parts) > 1 else ""
                    conn.execute(
                        """INSERT OR IGNORE INTO tracks (rel_path, title, artist, album,
                                ext, size, duration_ms, cover_url, job_id, added_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (rel, title, artist, album, path.suffix.lstrip("."), size,
                         duration_ms, None, job_id, int(time.time())),
                    )
                    added += 1

            gone = known - on_disk
            for rel in gone:
                conn.execute("DELETE FROM tracks WHERE rel_path = ?", (rel,))
                removed += 1
            conn.commit()
        finally:
            conn.close()
    return {"added": added, "removed": removed}


# --------------------------------------------------------------------------
# reads


def _row_to_track(row: sqlite3.Row) -> LibraryTrack:
    return LibraryTrack(
        id=row["id"],
        title=row["title"],
        artist=row["artist"],
        album=row["album"],
        ext=row["ext"],
        size=row["size"],
        duration_ms=row["duration_ms"],
        cover_url=row["cover_url"],
        rel_path=row["rel_path"],
        added_at=row["added_at"],
    )


def list_tracks() -> list[LibraryTrack]:
    _require()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute("SELECT * FROM tracks ORDER BY added_at DESC, id DESC").fetchall()
        finally:
            conn.close()
    return [_row_to_track(r) for r in rows]


def get(track_id: int) -> LibraryTrack | None:
    _require()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        finally:
            conn.close()
    return _row_to_track(row) if row else None


def file_path(track_id: int) -> Path | None:
    """Absolute path for streaming, or None if the row or file is gone."""
    track = get(track_id)
    if not track:
        return None
    absolute = _downloads_dir() / track.rel_path
    return absolute if absolute.exists() else None


def remove(track_id: int, *, delete_file: bool = True) -> bool:
    """Drop a track from the library, and by default its file too.

    A library entry with no file is useless, so the default is a real delete;
    the flag exists for the scan path, which removes only rows for files that
    are already gone.
    """
    _require()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT rel_path FROM tracks WHERE id = ?", (track_id,)).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
            conn.commit()
        finally:
            conn.close()
    if delete_file:
        try:
            (_downloads_dir() / row["rel_path"]).unlink(missing_ok=True)
        except OSError:
            pass
    return True


# --------------------------------------------------------------------------
# playlists


def create_playlist(name: str) -> dict:
    _require()
    name = name.strip() or "Untitled"
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute(
                "INSERT INTO playlists (name, created_at) VALUES (?, ?)",
                (name, int(time.time())),
            )
            conn.commit()
            playlist_id = cur.lastrowid
        finally:
            conn.close()
    return {"id": playlist_id, "name": name, "track_count": 0, "tracks": []}


def list_playlists() -> list[dict]:
    _require()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """SELECT p.id, p.name, p.created_at, COUNT(pt.track_id) AS n
                   FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
                   GROUP BY p.id ORDER BY p.created_at DESC"""
            ).fetchall()
        finally:
            conn.close()
    return [{"id": r["id"], "name": r["name"], "track_count": r["n"]} for r in rows]


def get_playlist(playlist_id: int) -> dict | None:
    _require()
    with _lock:
        conn = _connect()
        try:
            head = conn.execute("SELECT * FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
            if not head:
                return None
            rows = conn.execute(
                """SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                   WHERE pt.playlist_id = ? ORDER BY pt.position, pt.track_id""",
                (playlist_id,),
            ).fetchall()
        finally:
            conn.close()
    tracks = [_row_to_track(r).as_dict() for r in rows]
    return {"id": head["id"], "name": head["name"], "track_count": len(tracks), "tracks": tracks}


def rename_playlist(playlist_id: int, name: str) -> bool:
    _require()
    name = name.strip()
    if not name:
        return False
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, playlist_id))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def delete_playlist(playlist_id: int) -> bool:
    _require()
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def add_to_playlist(playlist_id: int, track_id: int) -> bool:
    """Append a library track to a playlist. Idempotent — already-present is
    a success, not a duplicate row."""
    _require()
    with _lock:
        conn = _connect()
        try:
            if not conn.execute("SELECT 1 FROM playlists WHERE id = ?", (playlist_id,)).fetchone():
                return False
            if not conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
                return False
            row = conn.execute(
                "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlist_tracks WHERE playlist_id = ?",
                (playlist_id,),
            ).fetchone()
            conn.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
                (playlist_id, track_id, row["pos"]),
            )
            conn.commit()
            return True
        finally:
            conn.close()


def remove_from_playlist(playlist_id: int, track_id: int) -> bool:
    _require()
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
                (playlist_id, track_id),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def status() -> dict:
    """What /api/library/status reports — cheap, no scan."""
    if not _ready:
        return {"available": False, "tracks": 0, "playlists": 0}
    with _lock:
        conn = _connect()
        try:
            tracks = conn.execute("SELECT COUNT(*) AS n FROM tracks").fetchone()["n"]
            playlists = conn.execute("SELECT COUNT(*) AS n FROM playlists").fetchone()["n"]
        finally:
            conn.close()
    return {"available": True, "tracks": tracks, "playlists": playlists}
