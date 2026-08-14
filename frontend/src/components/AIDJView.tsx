import { useState } from 'react'
import { AudioLines, Play, Sparkles, Wand2 } from 'lucide-react'
import clsx from 'clsx'
import { searchCatalog, type SearchResult } from '../lib/api'
import { playQueue, type PlayableItem } from '../lib/player'

/**
 * AI Vibe DJ.
 *
 * Inspired by the musicx.zip "AI DJ" — but that one was a mock (it filtered a
 * fixed playlist by genre/BPM with no real model). Ours is wired to the real
 * catalog: you describe a vibe in plain words, we classify it into a mood
 * profile entirely on-device (no API key, always works), then run an actual
 * search and let you play the resulting mix.
 *
 * The classifier is a transparent keyword -> mood map. If a GEMINI key is ever
 * provided we can swap classifyVibe() for an LLM call; the rest of the flow
 * (search + play) stays identical.
 */

type Energy = 'low' | 'mid' | 'high'

interface MoodProfile {
  title: string
  vibe: string
  energy: Energy
  genres: string[]
  /** Search terms seeded from the vibe + matched genres. */
  query: string
  /** Target tempo hint shown to the user (not strictly enforced). */
  bpm: string
  eq: string
  emoji: string
}

// Activity / scene -> energy + genre lean.
const SCENES: { match: RegExp; energy: Energy; genres: string[]; bpm: string; eq: string }[] = [
  { match: /gym|workout|lift|run|sprint|cardio|train|exercise|phonk/i, energy: 'high', genres: ['phonk', 'edm', 'hip hop', 'dubstep'], bpm: '150–180', eq: 'Punchy low-end, boosted 2–5 kHz' },
  { match: /party|club|dance|rave|night out|disco/i, energy: 'high', genres: ['dance', 'house', 'edm', 'pop'], bpm: '120–130', eq: 'Wide, bright mids' },
  { match: /study|focus|concentrat|read|work|code|coding|deep work/i, energy: 'low', genres: ['lo-fi', 'ambient', 'chill', 'jazz'], bpm: '60–90', eq: 'Soft, rolled-off highs' },
  { match: /sleep|bed|night|calm|relax|chill|uneasy|anx|wind down/i, energy: 'low', genres: ['ambient', 'sleep', 'piano', 'lo-fi'], bpm: '50–70', eq: 'Warm, very soft highs' },
  { match: /happy|uplift|summer|good mood|vibe|vibrant/i, energy: 'mid', genres: ['pop', 'afrobeat', 'funk', 'disco'], bpm: '100–115', eq: 'Balanced, gentle lift' },
  { match: /sad|breakup|cry|melancholy|blue|down/i, energy: 'low', genres: ['indie', 'piano', 'acoustic', 'soul'], bpm: '60–85', eq: 'Intimate, mid-focused' },
  { match: /drive|road|car|travel|journey|trip/i, energy: 'mid', genres: ['rock', 'synthwave', 'indie', 'pop'], bpm: '100–120', eq: 'Open, driving mids' },
  { match: /afro|amapiano|azonto|afrobeats/i, energy: 'mid', genres: ['afrobeat', 'amapiano', 'afro house'], bpm: '110–125', eq: 'Deep, round low-mids' },
  { match: /rock|metal|grunge|punk/i, energy: 'high', genres: ['rock', 'alt', 'metal'], bpm: '130–170', eq: 'Aggressive mids, tight bass' },
]

const GENRE_TERMS: Record<string, RegExp> = {
  'lo-fi': /lo[-\s]?fi|lofi/,
  phonk: /phonk/,
  house: /house/,
  'afro house': /afro\s*house/,
  amapiano: /amapiano/,
  edm: /edm|electronic|techno/,
  rock: /rock/,
  jazz: /jazz/,
  piano: /piano|neoclassical/,
  pop: /pop/,
  hiphop: /hip[-\s]?hop|rap/,
  ambient: /ambient|atmospheric/,
  chill: /chill/,
  'r&b': /r\s*&\s*b|rnb/,
  latin: /latin|reggaeton|salsa/,
}

const TITLE_TEMPLATES = [
  (v: string, g: string) => `${v} — ${g} set`,
  (v: string) => `Late-night ${v}`,
  (v: string, g: string) => `${g} for ${v}`,
  (v: string) => `${v} mix`,
]

function classifyVibe(input: string): MoodProfile {
  const text = input.trim()
  const lower = text.toLowerCase()

  // Energy + scene genres.
  let energy: Energy = 'mid'
  let genres: string[] = []
  let bpm = '90–110'
  let eq = 'Balanced, slight low-end lift'
  for (const s of SCENES) {
    if (s.match.test(lower)) {
      energy = s.energy
      genres = s.genres
      bpm = s.bpm
      eq = s.eq
      break
    }
  }

  // Explicit genre mentions override / extend.
  const mentioned = Object.entries(GENRE_TERMS)
    .filter(([, re]) => re.test(lower))
    .map(([g]) => g)
  if (mentioned.length) genres = Array.from(new Set([...mentioned, ...genres]))

  // Energy words.
  if (/\b(chill|calm|slow|soft|quiet|sleep|relax)\b/.test(lower)) energy = 'low'
  if (/\b(hype|intense|aggressive|heavy|fast|energetic|workout|pump)\b/.test(lower)) energy = 'high'

  // Build the search query: prefer an explicit genre, else the user's words.
  const query = genres.length ? genres[0] : text.split(/\s+/).slice(0, 4).join(' ')

  const vibe = text || 'a balanced everyday mix'
  const g0 = genres[0] ?? 'mixed'
  const title = (TITLE_TEMPLATES[Math.floor(Math.random() * TITLE_TEMPLATES.length)])(vibe, g0)

  const emoji = energy === 'high' ? '🔥' : energy === 'low' ? '🌙' : '✨'

  return { title, vibe, energy, genres, query, bpm, eq, emoji }
}

const SAMPLES = [
  'Heavy gym phonk 150 BPM',
  'Lo-fi beats to study and focus',
  'Afro house for a sunset party',
  'Calm piano to fall asleep',
  'Upbeat pop for a summer drive',
  'Melancholic indie for a rainy night',
]

function resultToItem(r: SearchResult): PlayableItem | null {
  if (r.kind !== 'track') return null
  const track = {
    id: r.id,
    title: r.name,
    artists: r.subtitle ? [r.subtitle] : [],
    album: '',
    duration_ms: 0,
    cover_url: r.cover_url,
    track_number: 0,
    release_date: '',
    preview_url: null,
    source_url: r.url,
  }
  const params = new URLSearchParams({
    title: track.title,
    artist: track.artists.join(', '),
    duration_ms: '0',
  })
  if (track.source_url) params.set('source_url', track.source_url)
  if (track.preview_url) params.set('preview_url', track.preview_url)
  return {
    id: r.id,
    title: r.name,
    artist: r.subtitle ?? '',
    cover: r.cover_url,
    src: `/api/stream?${params.toString()}`,
    kind: 'stream',
  }
}

export function AIDJView() {
  const [prompt, setPrompt] = useState('')
  const [profile, setProfile] = useState<MoodProfile | null>(null)
  const [tracks, setTracks] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (text: string) => {
    const p = classifyVibe(text)
    setProfile(p)
    setError(null)
    setLoading(true)
    setTracks([])
    try {
      const page = await searchCatalog(p.query, 0)
      const onlyTracks = page.results.filter((r) => r.kind === 'track').slice(0, 20)
      setTracks(onlyTracks)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed — try another vibe.')
    } finally {
      setLoading(false)
    }
  }

  const playMix = () => {
    const items = tracks.map(resultToItem).filter((x): x is PlayableItem => x !== null)
    if (items.length) playQueue(items, 0)
  }

  const energyColor =
    profile?.energy === 'high' ? 'text-rose-300' : profile?.energy === 'low' ? 'text-sky-300' : 'text-lime-flash'

  return (
    <div className="pt-6">
      <div className="flex items-center gap-2">
        <Wand2 className="size-5 text-lime-flash" />
        <h1 className="font-display text-2xl font-bold text-ink-100">AI Vibe DJ</h1>
      </div>
      <p className="mt-1 text-sm text-ink-400">
        Describe a mood or moment — we read it on-device and build a real mix from the catalog.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && prompt.trim() && run(prompt)}
          placeholder="e.g. heavy gym phonk, rainy night jazz, lo-fi to focus…"
          className="flex-1 rounded-btn border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-lime-flash/50"
        />
        <button
          onClick={() => prompt.trim() && run(prompt)}
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-btn bg-lime-flash px-5 py-3 text-sm font-semibold text-lime-ink transition active:scale-[0.98] disabled:opacity-60"
        >
          <Sparkles className="size-4" />
          {loading ? 'Mixing…' : 'Generate mix'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {SAMPLES.map((s) => (
          <button
            key={s}
            onClick={() => {
              setPrompt(s)
              run(s)
            }}
            className="rounded-full border border-ink-700 px-3 py-1 text-xs text-ink-300 transition hover:border-lime-flash/40 hover:text-ink-100"
          >
            {s}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}

      {profile && (
        <div className="mt-6 rounded-panel border border-ink-700 bg-ink-900 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-micro font-semibold uppercase tracking-[0.18em] text-ink-400">
                {profile.emoji} Your mix
              </p>
              <h2 className="mt-1 font-display text-xl font-bold text-ink-100">{profile.title}</h2>
              <p className="mt-1 text-sm text-ink-400">“{profile.vibe}”</p>
            </div>
            <button
              onClick={playMix}
              disabled={!tracks.length}
              className="flex shrink-0 items-center gap-2 rounded-btn bg-lime-flash px-4 py-2.5 text-sm font-semibold text-lime-ink transition active:scale-[0.98] disabled:opacity-50"
            >
              <Play className="size-4" />
              Play mix
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Energy" value={profile.energy} className={energyColor} />
            <Stat label="Tempo" value={profile.bpm} />
            <Stat label="Genre" value={profile.genres[0] ?? 'mixed'} />
            <Stat label="Tracks" value={String(tracks.length)} />
          </div>
          <div className="mt-3 rounded-btn bg-ink-800/60 px-3 py-2 text-xs text-ink-400">
            <span className="font-semibold text-ink-300">EQ hint:</span> {profile.eq}
          </div>
        </div>
      )}

      {tracks.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {tracks.map((t, i) => (
            <li
              key={t.dedup_key}
              className="flex items-center gap-3 rounded-btn px-3 py-2.5 transition hover:bg-ink-800/60"
            >
              <span className="w-5 text-right text-xs tabular-nums text-ink-500">{i + 1}</span>
              {t.cover_url ? (
                <img src={t.cover_url} alt="" className="size-9 rounded-md object-cover" />
              ) : (
                <div className="flex size-9 items-center justify-center rounded-md bg-ink-800 text-ink-500">
                  <AudioLines className="size-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-100">{t.name}</p>
                <p className="truncate text-xs text-ink-400">{t.subtitle}</p>
              </div>
              <button
                onClick={() => {
                  const item = resultToItem(t)
                  if (item) playQueue([item], 0)
                }}
                className="rounded-full p-2 text-ink-300 transition hover:bg-ink-700 hover:text-lime-flash"
                aria-label={`Play ${t.name}`}
              >
                <Play className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {profile && !loading && tracks.length === 0 && !error && (
        <p className="mt-4 text-sm text-ink-400">No tracks matched that vibe — try a broader genre.</p>
      )}
    </div>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-btn bg-ink-800/60 px-3 py-2">
      <p className="text-micro uppercase tracking-wide text-ink-500">{label}</p>
      <p className={clsx('mt-0.5 truncate text-sm font-semibold capitalize', className ?? 'text-ink-100')}>
        {value}
      </p>
    </div>
  )
}
