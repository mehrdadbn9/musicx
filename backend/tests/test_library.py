"""The durable library and playlists.

The point of the library is that it outlives a job. jobs.py forgets a job on
restart, but the file is still on disk and the library row still points at
it — so these tests exercise add/scan/list/remove and the playlist CRUD
against a real SQLite file in a tmp downloads folder.
"""

import importlib

import pytest


@pytest.fixture
def lib(tmp_path, monkeypatch):
    """A fresh library module bound to a temp DB and downloads folder."""
    from app import jobs, library

    downloads = tmp_path / "downloads"
    downloads.mkdir()
    monkeypatch.setattr(jobs, "DOWNLOADS_DIR", downloads)
    monkeypatch.setattr(library, "DB_PATH", tmp_path / "library.db")
    # _ready is module-global; reset it so start() actually re-opens the DB.
    monkeypatch.setattr(library, "_ready", False)
    library.start()
    assert library.is_available()
    return library, downloads


def _make_file(downloads, rel, data=b"audio"):
    path = downloads / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_add_and_list(lib):
    library, downloads = lib
    _make_file(downloads, "job1/Artist - Song.mp3")
    library.add("job1/Artist - Song.mp3", title="Song", artist="Artist",
                album="Album", cover_url=None, job_id="job1", duration_ms=1000)
    tracks = library.list_tracks()
    assert len(tracks) == 1
    assert tracks[0].title == "Song"
    assert tracks[0].artist == "Artist"
    assert tracks[0].ext == "mp3"


def test_add_is_idempotent_on_rel_path(lib):
    """Re-downloading to the same file updates the row, never duplicates it."""
    library, downloads = lib
    _make_file(downloads, "job1/x.mp3")
    library.add("job1/x.mp3", title="First", artist="A", album="", cover_url=None, job_id="job1")
    library.add("job1/x.mp3", title="Second", artist="A", album="", cover_url=None, job_id="job1")
    tracks = library.list_tracks()
    assert len(tracks) == 1
    assert tracks[0].title == "Second"


def test_scan_adopts_orphan_files(lib):
    """A file with no row — a download that finished before a crash — is
    adopted, its title read from the 'Artist - Title' stem."""
    library, downloads = lib
    _make_file(downloads, "old-job/Daft Punk - One More Time.mp3")
    result = library.scan()
    assert result["added"] == 1
    tracks = library.list_tracks()
    assert tracks[0].artist == "Daft Punk"
    assert tracks[0].title == "One More Time"


def test_scan_drops_rows_for_missing_files(lib):
    """A swept or deleted file leaves a dead row; scan removes it."""
    library, downloads = lib
    path = _make_file(downloads, "job1/gone.mp3")
    library.add("job1/gone.mp3", title="Gone", artist="A", album="", cover_url=None, job_id="job1")
    path.unlink()
    result = library.scan()
    assert result["removed"] == 1
    assert library.list_tracks() == []


def test_stream_path_and_remove_deletes_file(lib):
    library, downloads = lib
    path = _make_file(downloads, "job1/keep.mp3")
    library.add("job1/keep.mp3", title="Keep", artist="A", album="", cover_url=None, job_id="job1")
    track_id = library.list_tracks()[0].id

    assert library.file_path(track_id) == path
    assert library.remove(track_id) is True
    assert not path.exists()  # the file went with the row
    assert library.file_path(track_id) is None


def test_remove_without_delete_keeps_file(lib):
    library, downloads = lib
    path = _make_file(downloads, "job1/keep.mp3")
    library.add("job1/keep.mp3", title="Keep", artist="A", album="", cover_url=None, job_id="job1")
    track_id = library.list_tracks()[0].id
    library.remove(track_id, delete_file=False)
    assert path.exists()


def test_playlist_lifecycle(lib):
    library, downloads = lib
    _make_file(downloads, "job1/a.mp3")
    _make_file(downloads, "job1/b.mp3")
    library.add("job1/a.mp3", title="A", artist="X", album="", cover_url=None, job_id="job1")
    library.add("job1/b.mp3", title="B", artist="X", album="", cover_url=None, job_id="job1")
    # list_tracks is newest-first, so map by title rather than assume order.
    by_title = {t.title: t.id for t in library.list_tracks()}

    pl = library.create_playlist("My Mix")
    pid = pl["id"]
    # Added A then B — the playlist must preserve that insertion order.
    assert library.add_to_playlist(pid, by_title["A"]) is True
    assert library.add_to_playlist(pid, by_title["B"]) is True
    # Idempotent: adding the same track again is a success, not a duplicate.
    assert library.add_to_playlist(pid, by_title["A"]) is True

    full = library.get_playlist(pid)
    assert full["track_count"] == 2
    assert [t["title"] for t in full["tracks"]] == ["A", "B"]

    assert library.remove_from_playlist(pid, by_title["A"]) is True
    assert library.get_playlist(pid)["track_count"] == 1

    assert library.rename_playlist(pid, "Renamed") is True
    assert library.get_playlist(pid)["name"] == "Renamed"

    assert library.delete_playlist(pid) is True
    assert library.get_playlist(pid) is None


def test_deleting_a_library_track_removes_it_from_playlists(lib):
    """The ON DELETE CASCADE has to actually fire (foreign_keys pragma)."""
    library, downloads = lib
    _make_file(downloads, "job1/a.mp3")
    library.add("job1/a.mp3", title="A", artist="X", album="", cover_url=None, job_id="job1")
    tid = library.list_tracks()[0].id
    pid = library.create_playlist("P")["id"]
    library.add_to_playlist(pid, tid)
    assert library.get_playlist(pid)["track_count"] == 1

    library.remove(tid)
    assert library.get_playlist(pid)["track_count"] == 0


def test_add_to_missing_playlist_or_track_fails(lib):
    library, _ = lib
    assert library.add_to_playlist(999, 999) is False


def test_status_counts(lib):
    library, downloads = lib
    _make_file(downloads, "job1/a.mp3")
    library.add("job1/a.mp3", title="A", artist="X", album="", cover_url=None, job_id="job1")
    library.create_playlist("P")
    st = library.status()
    assert st == {"available": True, "tracks": 1, "playlists": 1}


def test_app_import_does_not_break(lib):
    """main.py must import with the library wired in."""
    import app.main as main

    importlib.reload(main)
    assert hasattr(main, "library_list")
