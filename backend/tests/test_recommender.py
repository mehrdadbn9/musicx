"""The recommender, against a hand-written stand-in for the Kaggle dataset.

The real CSV is 28k songs and not in the repo, so these tests build a tiny one
with the same columns. What they check is the wiring — scaling, title lookup,
ranking, and the two failure modes a caller sees (song not in the dataset,
dataset not installed) — not the quality of the recommendations, which is the
notebook's subject.
"""

import pytest

from app import recommender

# A pair that sits together, one middling song and one obvious outlier, so
# both a single track's ranking and a collection's centroid are decidable
# without depending on the real feature distribution.
ROWS = [
    # (track, artist, genre, year, lyric feature level, audio feature level)
    ("sweater weather", "the neighbourhood", "pop", 2012, 0.8, 0.7),
    ("keep on", "the green", "reggae", 2011, 0.79, 0.69),
    ("blue rain", "cold season", "country", 1998, 0.4, 0.45),
    ("thunder march", "loud brigade", "metal", 1975, 0.05, 0.1),
]


def write_dataset(path) -> None:
    import pandas as pd

    records = []
    for track, artist, genre, year, lyric, audio in ROWS:
        row = {"track_name": track, "artist_name": artist, "genre": genre, "release_date": year}
        for column in recommender.FEATURE_COLUMNS:
            if column == "age":
                row[column] = (2020 - year) / 100
            elif column in ("danceability", "loudness", "acousticness", "instrumentalness", "valence", "energy"):
                row[column] = audio
            else:
                row[column] = lyric
        records.append(row)
    pd.DataFrame(records).to_csv(path, index=False)


@pytest.fixture
def loaded(tmp_path, monkeypatch):
    """A recommender pointed at the stand-in dataset, freshly loaded."""
    csv = tmp_path / "tcc_ceds_music.csv"
    write_dataset(csv)
    monkeypatch.setattr(recommender, "DATASET_PATH", csv)
    monkeypatch.setattr(recommender, "_model", None)
    monkeypatch.setattr(recommender, "_load_error", None)
    return recommender


def test_recommends_the_similar_song_first(loaded):
    matched, results = loaded.recommend("sweater weather", limit=2)

    assert matched.track_name == "sweater weather"
    assert matched.artist_name == "the neighbourhood"
    # The input song is never its own recommendation.
    assert [r.track_name for r in results] == ["keep on", "blue rain"]
    assert results[0].similarity > results[1].similarity


def test_title_lookup_ignores_case_and_punctuation(loaded):
    matched, _ = loaded.recommend("Sweater  Weather!", limit=1)
    assert matched.track_name == "sweater weather"


def test_unique_prefix_resolves_but_ambiguity_does_not(loaded):
    matched, _ = loaded.recommend("thunder", limit=1)
    assert matched.track_name == "thunder march"

    # Matches nothing at all — a prefix of no title.
    with pytest.raises(LookupError):
        loaded.recommend("zzz nothing", limit=1)


def test_limit_caps_the_result_count(loaded):
    _, results = loaded.recommend("sweater weather", limit=1)
    assert len(results) == 1


def test_missing_dataset_is_unavailable_not_a_crash(tmp_path, monkeypatch):
    monkeypatch.setattr(recommender, "DATASET_PATH", tmp_path / "absent.csv")
    monkeypatch.setattr(recommender, "_model", None)
    monkeypatch.setattr(recommender, "_load_error", None)

    assert recommender.is_available() is False
    assert recommender.status() == {"available": False, "songs": None}
    with pytest.raises(recommender.RecommenderUnavailable):
        recommender.recommend("sweater weather")


def test_status_reports_the_song_count_once_loaded(loaded):
    loaded.recommend("sweater weather", limit=1)
    assert loaded.status() == {"available": True, "songs": len(ROWS)}


def test_a_collection_is_recommended_from_its_centroid(loaded):
    """Two members that sit together pull the centroid to their own corner."""
    matched, results = loaded.recommend_for_collection(
        ["sweater weather", "keep on"], limit=5
    )

    assert [m.track_name for m in matched] == ["sweater weather", "keep on"]
    # Members are never recommended back to the collection they came from.
    assert {r.track_name for r in results}.isdisjoint({"sweater weather", "keep on"})
    assert results[0].track_name == "blue rain"


def test_a_collection_ignores_titles_the_dataset_lacks(loaded):
    """Most catalog tracks are not in 28k rows — a partial match is normal."""
    matched, results = loaded.recommend_for_collection(
        ["sweater weather", "some song that does not exist"], limit=3
    )

    assert [m.track_name for m in matched] == ["sweater weather"]
    assert len(results) == 3


def test_a_collection_counts_a_repeated_title_once(loaded):
    """A deluxe edition must not weight the centroid toward its duplicates."""
    matched, _ = loaded.recommend_for_collection(
        ["sweater weather", "Sweater Weather!", "keep on"], limit=2
    )
    assert len(matched) == 2


def test_a_collection_with_no_known_track_is_a_lookup_error(loaded):
    with pytest.raises(LookupError):
        loaded.recommend_for_collection(["nothing here", "nor here"], limit=5)


def test_a_build_without_the_extra_is_unavailable_not_a_crash(loaded, monkeypatch):
    """`--build-arg WITH_RECOMMENDER=0` leaves pandas out of the image."""
    monkeypatch.setattr(loaded, "_libraries_installed", lambda: False)

    assert loaded.is_available() is False
    with pytest.raises(loaded.RecommenderUnavailable, match="recommender extra"):
        loaded.recommend("sweater weather")


def test_warm_loads_the_dataset_up_front(loaded):
    loaded.warm()
    # Loaded before anyone asked, so the first request pays nothing.
    assert loaded.status()["songs"] == len(ROWS)


def test_warm_is_silent_when_there_is_nothing_to_load(tmp_path, monkeypatch):
    """Startup calls this on every instance, including the ones with no data."""
    monkeypatch.setattr(recommender, "DATASET_PATH", tmp_path / "absent.csv")
    monkeypatch.setattr(recommender, "_model", None)
    monkeypatch.setattr(recommender, "_load_error", None)

    recommender.warm()  # must not raise
    assert recommender.status() == {"available": False, "songs": None}


def test_pandas_is_not_imported_until_the_first_recommendation():
    """A download-only instance should not pay for the ML stack at import."""
    import subprocess
    import sys

    code = "import app.main, sys; print('pandas' in sys.modules or 'sklearn' in sys.modules)"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.stdout.strip() == "False", result.stderr
