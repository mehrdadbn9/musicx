"""Content-based song recommendations — "more like this" for a track title.

The model is the one from the content-based-music-recommender notebook: each
song is a 23-dimensional vector (16 lyrical topic scores, 6 audio features,
age), standardized, compared by cosine similarity. StandardScaler rather than
MinMax is the whole finding of that project — MinMax leaves every vector in
the same non-negative corner of the space, so every pair scores ~0.98 and the
ranking says nothing. Centering at zero spreads the scores out to ~0.77-0.83
and the ranking starts to mean something.

Similarity is computed on demand, one row against the matrix, never as a full
NxN matrix: 28,372 songs squared is ~6 GB, and a 1xN vector is microseconds.

The dataset is not in the repo — it is the Kaggle "Music Dataset: 1950 to
2019" CSV (tcc_ceds_music.csv, ~28k rows), which is licensed there rather
than here. Without it every endpoint reports itself unavailable and the rest
of the app is unaffected; see README for where to put the file.

The same is true of the ML stack itself: pandas and scikit-learn are an
optional extra (`--build-arg WITH_RECOMMENDER=0` leaves them out), so both
"no data" and "no libraries" have to degrade to the same unavailable, and
every import of them happens inside a function rather than at module scope.
"""

import importlib.util
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

# The 23 feature columns, in the notebook's order. `lyrics` is raw text,
# `genre`/`topic` are categorical (and already represented by the topic
# scores), and `len` is lyric length — none of them belong in the vector.
FEATURE_COLUMNS = [
    "dating",
    "violence",
    "world/life",
    "night/time",
    "shake the audience",
    "family/gospel",
    "romantic",
    "communication",
    "obscene",
    "music",
    "movement/places",
    "light/visual perceptions",
    "family/spiritual",
    "like/girls",
    "sadness",
    "feelings",
    "danceability",
    "loudness",
    "acousticness",
    "instrumentalness",
    "valence",
    "energy",
    "age",
]

# Columns carried into the response — everything a caller needs to turn a
# recommendation back into a search query.
META_COLUMNS = ["track_name", "artist_name", "genre", "release_date"]

DATASET_PATH = Path(
    os.getenv("RECOMMEND_DATASET_PATH", Path(__file__).resolve().parent.parent / "dataset" / "tcc_ceds_music.csv")
)

# Loading is ~1s of pandas + a scaler fit, and most instances never get a
# recommendation request, so it happens on first use rather than at startup.
_lock = threading.Lock()
_model: "Model | None" = None
_load_error: str | None = None


class RecommenderUnavailable(RuntimeError):
    """The dataset is missing or unreadable — a 503, not a bad request."""


@dataclass
class Song:
    """One row of the dataset, as returned to a caller."""

    track_name: str
    artist_name: str
    genre: str
    release_date: int
    similarity: float | None = None


@dataclass
class Model:
    data: object  # pd.DataFrame — typed loosely so pandas stays an import away
    features: object  # np.ndarray, standardized
    index: dict  # normalized title -> row position


def _normalize(title: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — for title lookup.

    The dataset's titles are already lowercased and lightly cleaned, but what
    arrives from a search box is neither.
    """
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def _libraries_installed() -> bool:
    """Whether the `recommend` extra is in this image — a lean build has no
    pandas, and asking for it is not an error, just a smaller install."""
    return all(importlib.util.find_spec(name) is not None for name in ("pandas", "sklearn"))


def _load() -> Model:
    """Read the CSV, standardize the feature matrix, index titles."""
    if not _libraries_installed():
        raise RecommenderUnavailable(
            "Built without the recommender extra — rebuild with WITH_RECOMMENDER=1"
        )

    # Imported here, not at module scope: pandas and scikit-learn are 670 MB
    # of install that a download-only instance should never pay for.
    import numpy as np
    import pandas as pd
    from sklearn.preprocessing import StandardScaler

    if not DATASET_PATH.exists():
        raise RecommenderUnavailable(f"Dataset not found at {DATASET_PATH}")

    data = pd.read_csv(DATASET_PATH)
    missing = [c for c in FEATURE_COLUMNS + META_COLUMNS if c not in data.columns]
    if missing:
        raise RecommenderUnavailable(f"Dataset is missing columns: {', '.join(missing)}")

    features = StandardScaler().fit_transform(data[FEATURE_COLUMNS])
    features = np.ascontiguousarray(features, dtype=np.float32)

    # First occurrence wins: duplicate titles across artists are common, and
    # the dataset is ordered so the earlier row is the better-known release.
    index: dict[str, int] = {}
    for position, title in enumerate(data["track_name"].astype(str)):
        index.setdefault(_normalize(title), position)

    return Model(data=data, features=features, index=index)


def _model_or_raise() -> Model:
    global _model, _load_error
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        # A missing dataset does not change between requests — remember the
        # failure instead of re-reading the disk on every call.
        if _load_error is not None:
            raise RecommenderUnavailable(_load_error)
        try:
            _model = _load()
        except RecommenderUnavailable as exc:
            _load_error = str(exc)
            raise
        except Exception as exc:  # a corrupt CSV reads as unavailable too
            _load_error = f"Dataset could not be loaded: {exc}"
            raise RecommenderUnavailable(_load_error) from exc
        return _model


def is_available() -> bool:
    """Whether recommendations can be served — cheap enough to call per request."""
    if _model is not None:
        return True
    if _load_error is not None:
        return False
    return DATASET_PATH.exists() and _libraries_installed()


def warm() -> None:
    """Load the dataset now, if there is one, so no user request pays for it.

    Called off the startup path in a thread: a slow disk must not hold up the
    port opening, and a failure here is the same unavailable the endpoints
    already report — never a reason not to start.
    """
    if not is_available():
        return
    try:
        _model_or_raise()
    except RecommenderUnavailable:
        pass


def status() -> dict:
    """What /api/recommend/status reports, without forcing a load."""
    if _model is not None:
        return {"available": True, "songs": int(len(_model.data))}
    return {"available": is_available(), "songs": None}


def _row(model: Model, position: int, similarity: float | None = None) -> Song:
    row = model.data.iloc[position]
    return Song(
        track_name=str(row["track_name"]),
        artist_name=str(row["artist_name"]),
        genre=str(row["genre"]),
        release_date=int(row["release_date"]),
        similarity=None if similarity is None else round(float(similarity), 4),
    )


def _position(model: Model, title: str) -> int | None:
    """Row number for a title: exact (normalized) match, then unique prefix.

    "sweater" finding "sweater weather" is worth having; "love" matching 400
    songs is not, so an ambiguous prefix is a miss rather than a guess.
    """
    key = _normalize(title)
    if not key:
        return None
    position = model.index.get(key)
    if position is not None:
        return position
    prefixed = [pos for name, pos in model.index.items() if name.startswith(key)]
    return prefixed[0] if len(prefixed) == 1 else None


def find(title: str) -> Song | None:
    """The dataset row a title refers to, or None if it holds no such song."""
    model = _model_or_raise()
    position = _position(model, title)
    return None if position is None else _row(model, position)


def _nearest(model: Model, vector, exclude: set[int], limit: int) -> list[Song]:
    """The `limit` rows closest to `vector`, minus the ones asked to skip."""
    from sklearn.metrics.pairwise import cosine_similarity

    scores = cosine_similarity(vector.reshape(1, -1), model.features)[0]

    # argpartition over a full sort: the top 10 of 28k costs O(n) this way.
    # The excluded rows score highest (they *are* the input), so the window
    # has to be wide enough to still hold `limit` after they are dropped.
    import numpy as np

    take = min(limit + len(exclude), len(scores))
    candidates = np.argpartition(-scores, take - 1)[:take]
    candidates = candidates[np.argsort(-scores[candidates])]

    picked = [_row(model, int(pos), scores[pos]) for pos in candidates if int(pos) not in exclude]
    return picked[:limit]


def recommend(title: str, limit: int = 10) -> tuple[Song, list[Song]]:
    """Songs most similar to `title`, with the dataset row it matched.

    Raises LookupError when the title is not in the dataset — 28k songs is a
    small catalog next to what the rest of the app can download, so "not in
    the dataset" is the common case, not an error worth a 500.
    """
    # After the load, never before it: on a build without the extra there is
    # no sklearn to import, and the caller is owed the same "unavailable" it
    # gets for a missing dataset rather than an ImportError out of a 500.
    model = _model_or_raise()
    position = _position(model, title)
    if position is None:
        raise LookupError(f"Not in the recommendation dataset: {title}")

    return _row(model, position), _nearest(model, model.features[position], {position}, limit)


def recommend_for_collection(titles: list[str], limit: int = 10) -> tuple[list[Song], list[Song]]:
    """Songs similar to an album or playlist as a whole.

    The collection's taste is the **centroid** of its member vectors, not the
    union of each track's neighbours. A union answers "more like track 3" ten
    times over and is dominated by whichever member is most typical; the
    centroid answers the question actually being asked — what fits this record
    as a set. In standardized space the mean is well defined and cheap: one
    average, then the same single pass over the matrix a track does.

    Members are excluded from their own recommendations. Returns the rows that
    matched (a partial match is normal — most catalog tracks are not in the
    dataset) and raises LookupError only when none of them did.
    """
    import numpy as np

    model = _model_or_raise()

    # Same title twice, or two versions of it, must not weight the centroid
    # twice — a "deluxe edition" would otherwise pull it toward its duplicates.
    positions: list[int] = []
    for title in titles:
        position = _position(model, title)
        if position is not None and position not in positions:
            positions.append(position)
    if not positions:
        raise LookupError("No track of this collection is in the recommendation dataset")

    centroid = np.asarray(model.features[positions]).mean(axis=0)
    matched = [_row(model, position) for position in positions]
    return matched, _nearest(model, centroid, set(positions), limit)
