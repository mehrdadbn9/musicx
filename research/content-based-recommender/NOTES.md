# Where the recommender came from

`music-recommendation.ipynb` is the original standalone project this feature
was merged in from, kept here unchanged as the record of *why* the model looks
the way it does. `README.md` next to it is that project's own write-up, and
`similarity_distribution.png` the figure it produced.

The shipped code is `backend/app/recommender.py`. Three things carried over
from the notebook, and they are the whole reason it is worth reading:

- **StandardScaler, not MinMaxScaler.** MinMax leaves every vector in the
  non-negative corner of the space, so every pair of songs scores ~0.98 and
  the ranking carries no information. Centering at zero spreads good matches
  out to ~0.77–0.83.
- **No PCA.** It was tried and made things worse — the first component is
  almost entirely acousticness, energy and age, so reducing onto it discards
  the 16 lyrical dimensions that make two songs feel alike.
- **Similarity on demand, never an NxN matrix.** 28,372 songs squared is
  ~6 GB; one row against the matrix is microseconds.

What the API adds on top: title normalization and unique-prefix lookup (the
notebook required an exact lowercase title), `argpartition` instead of a full
sort for the top N, a lazy load so a download-only instance never imports
pandas, and the two honest failure modes — song not in the dataset (404),
dataset not installed (503).

Known limitation, inherited: `genre` is not in the feature vector, so
recommendations cross genres freely. The notebook's conclusion — weighting
lyrical and audio features separately instead of treating all 23 dimensions
equally — is still the most promising next step.

The dataset itself is not in this repo; see [`backend/dataset/README.md`](../../backend/dataset/README.md).
