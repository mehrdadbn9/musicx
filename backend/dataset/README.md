# The recommendation dataset lives here

`tcc_ceds_music.csv` — Kaggle "Music Dataset: 1950 to 2019"
(<https://www.kaggle.com/datasets/saurabhshahane/music-dataset-1950-to-2019>),
28,372 songs with 16 lyrical topic scores, 6 audio features and a release
year. It is not committed: it is licensed on Kaggle, not here, and it is the
only part of this repo that needs an account to obtain.

Without it `/api/recommend` answers 503, `/api/recommend/status` reports
`available: false`, and the UI hides the feature. Everything else works. An
image built with `--build-arg WITH_RECOMMENDER=0` has no pandas or
scikit-learn and behaves identically, dataset or not.

Download the CSV and drop it in this directory:

    backend/dataset/tcc_ceds_music.csv

With Docker the same file is bind-mounted read-only at `/app/dataset`; set
`DATASET_DIR` in `.env` to keep it somewhere else. `RECOMMEND_DATASET_PATH`
overrides the full path for a non-Docker run.
