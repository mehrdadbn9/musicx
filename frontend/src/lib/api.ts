import axios from 'axios'

export interface Track {
  id: string
  title: string
  artists: string[]
  album: string
  duration_ms: number
  cover_url: string | null
  track_number: number
  release_date: string
  preview_url: string | null
  /** Page the track already lives on (YouTube / SoundCloud) — the server
   *  then resolves that exact page instead of re-searching for the upload. */
  source_url: string | null
}

export interface Collection {
  kind: 'track' | 'album' | 'playlist'
  name: string
  owner: string
  cover_url: string | null
  tracks: Track[]
}

export type TrackStatus =
  'queued' | 'searching' | 'downloading' | 'tagging' | 'retrying' | 'done' | 'error'

export interface JobTrack {
  id: string
  status: TrackStatus
  progress: number
  error: string | null
  /** Format the finished file actually came out as ('mp3' | 'm4a' | 'opus'). */
  ext: string | null
}

export interface Job {
  id: string
  name: string
  quality: Quality
  tracks: JobTrack[]
  done: number
  failed: number
  total: number
  finished: boolean
}

/** Audio the user can ask for: an mp3 bitrate in kbps, or the upload's own
 *  stream untouched. Mirrors QUALITIES in backend/app/downloader.py. */
export const QUALITIES = ['128', '192', '320', 'original'] as const

export type Quality = (typeof QUALITIES)[number]

export const DEFAULT_QUALITY: Quality = '192'

export const QUALITY_LABEL: Record<Quality, string> = {
  '128': '128',
  '192': '192',
  '320': '320',
  original: 'Original',
}

export const QUALITY_HINT: Record<Quality, string> = {
  '128': 'Smallest files — fine for podcasts or a phone that’s low on space.',
  '192': 'The default. Good quality at roughly half the size of 320.',
  '320': 'The best mp3 gets. Plays everywhere.',
  original:
    'No re-encoding — the upload’s own m4a or opus. Best sound, biggest files, and won’t play on some older devices.',
}

export const isQuality = (value: unknown): value is Quality => QUALITIES.includes(value as Quality)

export type Source = 'deezer' | 'itunes' | 'youtube' | 'soundcloud'

export type ResultKind = 'track' | 'album' | 'artist' | 'playlist'

export interface SearchResult {
  kind: ResultKind
  id: string
  name: string
  subtitle: string
  cover_url: string | null
  url: string
  source: Source
  /** Server-computed identity (kind + name + artist). The backend dedupes
   *  within a page; the client reuses this key to dedupe across pages. */
  dedup_key: string
}

export interface SearchPage {
  results: SearchResult[]
  page: number
  has_more: boolean
}

export interface ArtistDetail {
  id: string
  name: string
  picture_url: string | null
  fan_count: number | null
  top_tracks: SearchResult[]
  albums: SearchResult[]
}

const client = axios.create({ baseURL: '/api' })

/** The backend already composes subtitles in English ("5 releases",
 *  "by X · 40 tracks"), so search results pass through unchanged now that the
 *  UI is English too. Kept as a seam in case a surface ever wants to reword
 *  one without forking the backend. */
const localizeResult = (result: SearchResult): SearchResult => result

/** For anything without a usable `detail`: a short, plain message per status.
 *  The backend's own `detail` is already end-user English, so it is preferred
 *  over these whenever it is present. */
const STATUS_FALLBACK: Record<number, string> = {
  400: "This link wouldn't open — it may be private or its source unavailable.",
  404: 'Not found.',
  429: 'Slow down a moment and try again.',
}

function describeError(detail: string, status: number): string {
  // The backend speaks plain English already, so its message is the best one
  // to show. Fall back to a per-status line only when there isn't one.
  if (detail) return detail
  return STATUS_FALLBACK[status] ?? "The server didn't respond — try once more."
}

export function apiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    const detail = err.response?.data?.detail
    if (status == null) return "Couldn't reach the server — check your connection."
    return describeError(typeof detail === 'string' ? detail : '', status)
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

const URL_PATTERNS = [
  /open\.spotify\.com\/(intl-[a-zA-Z-]+\/)?(track|album|playlist)\//,
  /deezer\.com\/([a-z]{2}\/)?(track|album|playlist)\/\d+/,
  /music\.apple\.com\/([a-z]{2}\/)?(album|song)\//,
  /(music\.|www\.|m\.)?(youtube\.com\/(watch|playlist)\?|youtu\.be\/)/,
  /(www\.|m\.|on\.)?soundcloud\.com\/./,
]

export const isCatalogUrl = (input: string) => URL_PATTERNS.some((re) => re.test(input))

export async function searchCatalog(query: string, page = 0): Promise<SearchPage> {
  const { data } = await client.get<SearchPage>('/search', {
    params: { q: query, page },
  })
  return { ...data, results: data.results.map(localizeResult) }
}

/** Append a page, dropping anything already on screen. */
export function mergeResults(current: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const seen = new Set(current.map((r) => r.dedup_key))
  const fresh: SearchResult[] = []
  for (const result of incoming) {
    if (seen.has(result.dedup_key)) continue
    seen.add(result.dedup_key)
    fresh.push(result)
  }
  return fresh.length > 0 ? [...current, ...fresh] : current
}

export async function getArtist(id: string): Promise<ArtistDetail> {
  const { data } = await client.get<ArtistDetail>(`/artist/${id}`)
  return {
    ...data,
    top_tracks: data.top_tracks.map(localizeResult),
    albums: data.albums.map(localizeResult),
  }
}

/** One row of the offline recommendation dataset. Not a `SearchResult`: it
 *  has no provider, no id and no URL — it is a title to search for. */
export interface SimilarSong {
  track_name: string
  artist_name: string
  genre: string
  release_date: number
  /** Cosine similarity to the song asked about; null for the matched song. */
  similarity: number | null
}

export interface Recommendations {
  query: string
  /** The dataset row the query matched — its title, not necessarily yours. */
  matched: SimilarSong
  results: SimilarSong[]
}

/** Whether the instance has the recommendation dataset installed at all.
 *  Self-hosters who skipped the Kaggle download get no dead UI. */
export async function recommendAvailable(): Promise<boolean> {
  try {
    const { data } = await client.get<{ available: boolean }>('/recommend/status')
    return data.available
  } catch {
    return false
  }
}

/** Songs similar to a title, or null when it isn't in the 28k-song dataset —
 *  the common case, and not worth an error toast. */
export async function getSimilar(title: string, limit = 10): Promise<Recommendations | null> {
  try {
    const { data } = await client.get<Recommendations>('/recommend', {
      params: { q: title, limit },
    })
    return data
  } catch (err) {
    // 404 = not in the dataset, 503 = no dataset installed. Both mean "no
    // recommendations here", which the caller renders as nothing at all.
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 503)) {
      return null
    }
    throw err
  }
}

export interface CollectionRecommendations {
  /** Dataset rows the album's own tracks matched — usually a subset. */
  matched: SimilarSong[]
  matched_count: number
  /** Titles sent, so "3 of 12 known" can be said honestly. */
  considered: number
  results: SimilarSong[]
}

/** Songs that fit a whole album or playlist, from the centroid of whichever
 *  of its tracks the dataset knows. Null when it knows none of them. */
export async function getSimilarForCollection(
  titles: string[],
  limit = 10,
): Promise<CollectionRecommendations | null> {
  try {
    const { data } = await client.post<CollectionRecommendations>('/recommend/collection', {
      titles,
      limit,
    })
    return data
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 503)) {
      return null
    }
    throw err
  }
}

export interface CatalogRecommendations {
  artist: string
  results: SimilarSong[]
}

/** "More like this" for music the offline English dataset does not cover —
 *  Persian and other non-Western tracks. Uses Deezer's related-artists graph
 *  instead of the content-based model, so it answers for the catalog the app
 *  can actually download from. Never throws: it is the fallback path, so a
 *  provider miss is an empty list, not an error. */
export async function getSimilarFromCatalog(
  artist: string,
  exclude: string[],
  limit = 8,
): Promise<CatalogRecommendations | null> {
  try {
    const { data } = await client.post<CatalogRecommendations>('/recommend/catalog', {
      artist,
      exclude,
      limit,
    })
    return data.results.length > 0 ? data : null
  } catch {
    return null
  }
}

export async function resolveUrl(url: string): Promise<Collection> {
  const { data } = await client.post<Collection>('/resolve', { url })
  return data
}

export async function startDownload(
  url: string,
  trackIds?: string[],
  quality: Quality = DEFAULT_QUALITY,
): Promise<string> {
  const { data } = await client.post<{ job_id: string }>('/download', {
    url,
    track_ids: trackIds ?? null,
    quality,
  })
  return data.job_id
}

export async function getJob(jobId: string): Promise<Job> {
  const { data } = await client.get<Job>(`/jobs/${jobId}`)
  return data
}

/** Poll every unfinished job in one request. Jobs the server no longer knows
 *  are absent from the response — callers use that gap to retire them. */
export async function getJobs(jobIds: string[]): Promise<Job[]> {
  if (jobIds.length === 0) return []
  const { data } = await client.get<{ jobs: Job[] }>('/jobs', {
    params: { ids: jobIds.join(',') },
  })
  return data.jobs
}

export const trackFileUrl = (jobId: string, trackId: string) =>
  `/api/jobs/${jobId}/tracks/${trackId}/file`

/** Full-length playback for a track that has not been downloaded.
 *
 *  The catalog's own `preview_url` is 30 seconds and cannot be longer, so
 *  this asks the server to resolve and proxy the real upload instead. It
 *  costs an extraction on first play, which is why a downloaded file is
 *  still preferred over it wherever one exists. */
export const trackStreamUrl = (track: Track) => {
  const params = new URLSearchParams({
    title: track.title,
    artist: track.artists.join(', '),
    duration_ms: String(track.duration_ms),
  })
  // A track that already lives on a page hands the server that exact URL:
  // the search step is skipped, which plays the right upload and avoids the
  // extra extraction (and bot-check surface) that a search would cost.
  if (track.source_url) params.set('source_url', track.source_url)
  // Deezer (and friends) expose only a 30s preview, but it is directly
  // playable from the server — sent as a last-resort so playback works even
  // when the full-length YouTube re-resolve is bot-blocked on a datacenter IP.
  if (track.preview_url) params.set('preview_url', track.preview_url)
  return `/api/stream?${params.toString()}`
}

export const jobZipUrl = (jobId: string) => `/api/jobs/${jobId}/zip`
