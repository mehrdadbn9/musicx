"""A livestream must never reach the download pipeline.

It has no end, so `download_audio` on one returns only when the broadcast
stops. The job stays at "downloading" and the worker thread it holds is gone
until then — three of them is the whole default pool. The guard is in three
places, and all three are tested here: resolve (so no job is created),
candidate selection (so a search never picks one), and the download itself
(for a video that went live between resolve and download).
"""

import pytest

from app import downloader


def test_reject_live_raises_on_live_entry():
    with pytest.raises(downloader.DownloadError, match="live"):
        downloader._reject_live({"id": "x", "title": "t", "is_live": True})


def test_reject_live_passes_everything_else():
    assert downloader._reject_live({"id": "x", "title": "t", "is_live": False}) is None
    # Absent key, which is what a normal upload's info dict looks like.
    assert downloader._reject_live({"id": "x", "title": "t"}) is None


def test_download_opts_carry_the_filter():
    """The guard is worth nothing if it isn't wired into the options."""
    import inspect

    source = inspect.getsource(downloader.download_audio)
    assert "match_filter=_reject_live" in source


def test_candidate_skips_live_even_at_the_exact_duration():
    """A live entry reporting a matching duration must still lose.

    Some extractors report elapsed time as `duration` on an ongoing stream,
    which would otherwise score as a perfect match and win outright.
    """
    live = {"id": "live", "url": "u1", "duration": 200, "is_live": True}
    real = {"id": "real", "url": "u2", "duration": 205}
    assert downloader._pick_candidate([live, real], 200)["id"] == "real"


def test_candidate_skips_live_in_the_fallback_too():
    """Nothing within tolerance falls back to the top result — not to a live one."""
    live = {"id": "live", "url": "u1", "duration": 9999, "is_live": True}
    real = {"id": "real", "url": "u2", "duration": 8888}
    assert downloader._pick_candidate([live, real], 200)["id"] == "real"


def test_candidate_skips_live_with_no_target_duration():
    """The `target_seconds <= 0` path returns entries[0] without scoring."""
    live = {"id": "live", "url": "u1", "is_live": True}
    real = {"id": "real", "url": "u2", "duration": 180}
    assert downloader._pick_candidate([live, real], 0)["id"] == "real"


def test_all_candidates_live_is_no_results():
    with pytest.raises(downloader.DownloadError, match="No results"):
        downloader._pick_candidate([{"id": "a", "is_live": True}], 200)


def test_resolve_refuses_a_live_url(monkeypatch):
    from app import ytdlp
    from app.models import ProviderError

    monkeypatch.setattr(
        ytdlp,
        "_extract",
        lambda url: {"id": "x", "title": "Some Radio", "is_live": True, "duration": None},
    )
    with pytest.raises(ProviderError, match="live stream"):
        ytdlp.resolve("https://youtube.com/watch?v=live")


def test_resolve_drops_live_entries_from_a_playlist(monkeypatch):
    """A channel page broadcasting right now should still yield its uploads."""
    from app import ytdlp

    monkeypatch.setattr(
        ytdlp,
        "_extract",
        lambda url: {
            "_type": "playlist",
            "title": "A Channel",
            "uploader": "Someone",
            "entries": [
                {"id": "1", "title": "Someone - Live Now", "is_live": True},
                {"id": "2", "title": "Someone - A Real Song", "duration": 200},
            ],
        },
    )
    collection = ytdlp.resolve("https://youtube.com/@someone")
    assert [t.id for t in collection.tracks] == ["2"]


def test_resolve_playlist_of_only_live_entries_is_empty(monkeypatch):
    """Dropping every entry must read as empty, not as a one-track playlist."""
    from app import ytdlp
    from app.models import ProviderError

    monkeypatch.setattr(
        ytdlp,
        "_extract",
        lambda url: {
            "_type": "playlist",
            "title": "All Live",
            "entries": [{"id": "1", "title": "x", "is_live": True}],
        },
    )
    with pytest.raises(ProviderError, match="empty or private"):
        ytdlp.resolve("https://youtube.com/@someone")
