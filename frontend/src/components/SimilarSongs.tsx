import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import clsx from 'clsx'
import {
  getSimilar,
  getSimilarForCollection,
  getSimilarFromCatalog,
  recommendAvailable,
  type CollectionRecommendations,
  type Recommendations,
  type SimilarSong,
} from '../lib/api'

/** One track's answer or a whole collection's; they differ only in what the
 *  line under the heading can honestly say. */
type Answer = Recommendations | CollectionRecommendations

const isCollectionAnswer = (answer: Answer): answer is CollectionRecommendations =>
  'matched_count' in answer

interface Props {
  /** Track titles similarity is measured against: one for a track, all of
   *  them for an album or playlist (the server averages the ones it knows). */
  titles: string[]
  kind: 'track' | 'album' | 'playlist' | 'artist'
  /** The collection's main artist. Drives the catalog fallback below, which
   *  is what answers for Persian and other music the English dataset lacks. */
  artist?: string
  /** Searching for a suggestion is how it gets downloaded: this app's
   *  catalogs know far more songs than the 28k-row dataset does. */
  onPick: (query: string) => void
  /** Margin override for embedded placements (per-row expanders, panels). */
  className?: string
}

const HEADING = {
  track: 'More like this track',
  album: 'More like this album',
  playlist: 'More like this playlist',
  artist: 'More like this artist',
}

/** The same three words as a bare noun, for the "nothing found" line. */
const KIND_NOUN = {
  track: 'track',
  album: 'album',
  playlist: 'playlist',
  artist: 'artist',
}

/** "More like this", two layers deep.
 *
 *  First the offline content-based model (28k English songs, scored by cosine
 *  similarity). When that has nothing — a Persian track, or any music outside
 *  its catalog — it falls back to Deezer's own related-artists graph, which
 *  does know that music. Only when both are empty does it say so.
 */
export function SimilarSongs({ titles, kind, artist, onPick, className }: Props) {
  // Asked once per session, not per collection: it answers from a file check
  // and cannot change while the page is open.
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    recommendAvailable().then((ok) => alive && setAvailable(ok))
    return () => {
      alive = false
    }
  }, [])

  const single = titles.length === 1
  const { data, isPending } = useQuery<Answer | null>({
    // The whole track list is the identity of the query — two albums by the
    // same artist are different questions.
    queryKey: ['similar', kind, titles],
    queryFn: () => (single ? getSimilar(titles[0], 8) : getSimilarForCollection(titles, 8)),
    enabled: available === true && titles.length > 0,
    staleTime: Infinity,
  })

  const datasetEmpty = available !== true || !data || data.results.length === 0

  // Fallback: the catalog's related-artists graph. Enabled once the
  // dataset has resolved to nothing — with or without an artist seed,
  // because the server can derive the real artist from the titles
  // themselves ("Moein - Vaghti To Ba Man Nisti" -> Moein), which is what
  // answers when the seed is an uploader handle, not the musician.
  const { data: catalog, isPending: catalogPending } = useQuery({
    queryKey: ['similar-catalog', artist, titles],
    queryFn: () => getSimilarFromCatalog(artist ?? '', titles, 8),
    enabled: datasetEmpty && !isPending,
    staleTime: Infinity,
  })

  // The dataset answered — the richer, scored result wins.
  if (data && data.results.length > 0) {
    const subline = isCollectionAnswer(data)
      ? kind === 'artist'
        ? `Based on ${data.matched_count} of ${data.considered} tracks by this artist`
        : `Based on ${data.matched_count} of ${data.considered} tracks in this collection`
      : `Based on “${data.matched.track_name}” by ${data.matched.artist_name}`
    return (
      <Section kind={kind} subline={subline} songs={data.results} onPick={onPick} className={className} />
    )
  }

  // Still deciding: primary query in flight, or the fallback is.
  if (available === null || isPending) return null
  if (datasetEmpty && catalogPending) return null

  // The catalog fallback found related tracks — the answer for Persian music.
  if (catalog && catalog.results.length > 0) {
    return (
      <Section
        kind={kind}
        subline={`Based on “${catalog.artist}” and similar artists`}
        songs={catalog.results}
        onPick={onPick}
        className={className}
      />
    )
  }

  // No dataset installed and no artist to fall back on: the feature does not
  // exist on this instance, so it advertises nothing.
  if (available !== true && !artist) return null

  // Genuinely nothing to suggest. Said out loud so silence is not read as a
  // broken feature.
  return (
    <section className="mt-8 animate-fade-up">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-ink-600" />
        <h2 className="text-micro font-semibold text-ink-400">{HEADING[kind]}</h2>
      </div>
      <p className="mt-1 text-mini text-ink-600" dir="auto">
        No suggestions found for this {KIND_NOUN[kind]}.
      </p>
    </section>
  )
}

function Section({
  kind,
  subline,
  songs,
  onPick,
  className,
}: {
  kind: 'track' | 'album' | 'playlist' | 'artist'
  subline: string
  songs: SimilarSong[]
  onPick: (query: string) => void
  className?: string
}) {
  return (
    <section className={clsx('animate-fade-up', className ?? 'mt-8')}>
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-ink-600" />
        <h2 className="text-micro font-semibold text-ink-400">{HEADING[kind]}</h2>
      </div>
      <p className="mt-1 text-mini text-ink-600" dir="auto">
        {subline}
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {songs.map((song) => (
          <li key={`${song.track_name}-${song.artist_name}`}>
            <SimilarRow song={song} onPick={onPick} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function SimilarRow({ song, onPick }: { song: SimilarSong; onPick: (query: string) => void }) {
  const query = `${song.track_name} ${song.artist_name}`
  return (
    <button
      onClick={() => onPick(query)}
      dir="auto"
      title={`Search “${song.track_name}”`}
      className="tap-target flex w-full items-center gap-3 rounded-btn border border-ink-800 bg-ink-900 px-3 py-2.5 text-left transition duration-200 hover:border-ink-600 active:scale-[0.99]"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-100">{song.track_name}</span>
        <span className="block truncate text-mini text-ink-500" dir="auto">
          {song.genre ? `${song.artist_name} · ${song.genre}` : song.artist_name}
        </span>
      </span>
      {/* Cosine similarity, as a percentage — dataset answers only. The
          catalog fallback has no score, so this is blank there. The model's
          range is ~0.77-0.83 even for good matches, so read the gaps. */}
      <span className="shrink-0 text-mini tabular-nums text-ink-600">
        {song.similarity == null ? '' : `${Math.round(song.similarity * 100)}%`}
      </span>
    </button>
  )
}
