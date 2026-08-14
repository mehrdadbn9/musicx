import { useState } from 'react'
import { Disc, Play, Sparkles, Wand2 } from 'lucide-react'
import { apiDJ, type DJProfile, type SearchResult } from '../lib/api'
import { playQueue, type PlayableItem } from '../lib/player'

/** Map a SearchResult (track) to a PlayableItem the player can queue.
 *  preview_url (when present) lets the stream fall back to a 30s clip, so
 *  playback never hard-fails the way full-length extraction can on some IPs. */
function resultToItem(r: SearchResult): PlayableItem {
  const track = {
    id: r.id,
    title: r.name,
    artists: [r.subtitle].filter(Boolean),
    album: '',
    duration_ms: 0,
    cover_url: r.cover_url,
    track_number: 0,
    release_date: '',
    preview_url: r.preview_url ?? null,
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
    artist: r.subtitle,
    cover: r.cover_url,
    src: `/api/stream?${params.toString()}`,
    kind: 'stream',
  }
}

const SAMPLES = [
  'Late night high-speed coding session in Neo-Tokyo (130+ BPM)',
  'Heavy deadlift PR workout with drift phonk and explosive 808s',
  'Rainy afternoon coffee shop lo-fi study with mellow Rhodes chords',
  'Sunset ocean drive with melodic deep house and vocal warmth',
  'Weightless space meditation and deep delta wave ambient sleep',
]

export function AIDJView() {
  const [vibe, setVibe] = useState('')
  const [loading, setLoading] = useState(false)
  const [profile, setProfile] = useState<DJProfile | null>(null)
  const [tracks, setTracks] = useState<SearchResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [enhancing, setEnhancing] = useState(false)

  const generate = async (text?: string, enhance = false) => {
    const q = (text ?? vibe).trim()
    if (!q) return
    setVibe(q)
    if (enhance) setEnhancing(true)
    else {
      setLoading(true)
      setEnhancing(false)
      setProfile(null)
      setTracks([])
    }
    setError(null)
    try {
      const res = await apiDJ(q, enhance)
      setProfile(res.profile)
      setTracks(res.results.filter((r) => r.kind === 'track').slice(0, 24))
      setModel((res.profile.model as string) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate a mix')
    } finally {
      setLoading(false)
      setEnhancing(false)
    }
  }

  const enhance = () => generate(vibe, true)

  const playMix = () => {
    const items = tracks.map(resultToItem)
    if (items.length) playQueue(items, 0)
  }

  return (
    <div className="flex flex-col gap-8 pb-32 pt-2">
      {/* Header Banner — Gemini / AI Studio "Smart DJ Studio" look */}
      <div className="dj-banner relative overflow-hidden rounded-3xl border border-white/10 p-6 sm:p-8 shadow-2xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex max-w-xl flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="dj-badge">
                <Sparkles className="size-3.5 text-dj-cyan" /> MusicX Smart DJ Studio
              </span>
              <span className="font-mono text-xs text-indigo-200">Real-Time Vibe Synthesizer</span>
            </div>
            <h1 className="font-black text-white">
              AI-Curated DJ Mixes &amp; BPM Transition Engine
            </h1>
            <p className="text-sm text-indigo-100/90">
              Describe your current vibe, activity, or environment. Our AI DJ reads the mood and
              builds a real mix from the catalog — instantly, or enhanced by a free LLM.
            </p>
          </div>
          <div className="dj-disc shrink-0">
            <Disc className="size-14 animate-spin-slow text-dj-cyan" />
          </div>
        </div>
      </div>

      {/* Prompt Input Box */}
      <div className="dj-prompt rounded-3xl border border-white/10 p-5 shadow-xl sm:p-6">
        <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
          <Wand2 className="size-4 text-dj-indigo" /> Generate Custom Set From Vibe Prompt
        </label>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={vibe}
            onChange={(e) => setVibe(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') generate() }}
            placeholder="e.g. Neon cyberpunk midnight drive or Lo-fi rain with warm piano..."
            className="dj-input flex-1 rounded-2xl border border-white/15 bg-white/[0.06] px-4 py-3.5 text-sm font-medium text-white placeholder-slate-500 outline-none focus:border-dj-indigo"
          />
          <button
            onClick={() => generate()}
            disabled={loading || enhancing || !vibe.trim()}
            className="dj-btn flex shrink-0 items-center justify-center gap-2 rounded-2xl px-6 py-3.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
          >
            {loading ? (
              <><Sparkles className="size-4 animate-spin" /> Mixing Set…</>
            ) : (
              <><Sparkles className="size-4 text-dj-cyan" /> Synthesize Mix</>
            )}
          </button>
          <button
            onClick={enhance}
            disabled={loading || enhancing || !vibe.trim()}
            title="Wait for the free LLM to craft a smarter mix (~15-20s)"
            className="dj-btn-ghost flex shrink-0 items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-bold text-white transition-all disabled:opacity-50"
          >
            <Wand2 className="size-4" /> {enhancing ? 'Thinking…' : '✨ Enhance with AI'}
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Quick Inspo Prompts:
          </span>
          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((p) => (
              <button
                key={p}
                onClick={() => generate(p)}
                className="dj-chip rounded-xl border border-white/10 px-3 py-1.5 text-left text-xs text-slate-300 transition-all hover:border-dj-indigo hover:text-white"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      )}

      {profile && !loading && (
        <div className="dj-mix-card flex flex-col gap-4 rounded-3xl border border-dj-indigo/30 p-6 shadow-2xl">
          <div className="flex flex-col gap-4 border-b border-white/10 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="dj-ai-mastered">AI Mastered</span>
                <span className="font-mono text-xs font-bold text-dj-cyan">
                  {profile.bpm || '—'} BPM Target
                </span>
                {model && (
                  <span className="rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-300">
                    {model.includes('offline') ? 'offline' : 'free LLM'}
                  </span>
                )}
              </div>
              <h2 className="font-black text-white">
                AI Mix: {profile.energy} energy · {(profile.genres ?? []).join(', ')}
              </h2>
              <p className="text-xs text-slate-400">
                Generated for “{vibe}”. Curated tempo sequencing from the live catalog.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={playMix}
                disabled={!tracks.length}
                className="dj-btn flex items-center gap-2 rounded-2xl px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/40 transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
              >
                <Play className="size-4 fill-white" /> Play Mix Now
              </button>
            </div>
          </div>

          <ul className="flex flex-col gap-1">
            {tracks.map((t, i) => (
              <li
                key={t.dedup_key}
                className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5"
              >
                <span className="w-5 text-center text-xs tabular-nums text-slate-400">{i + 1}</span>
                {t.cover_url ? (
                  <img src={t.cover_url} alt="" className="size-10 rounded-md object-cover" />
                ) : (
                  <div className="size-10 rounded-md bg-ink-700" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink-100">{t.name}</div>
                  <div className="truncate text-xs text-ink-400">{t.subtitle}</div>
                </div>
                <button
                  onClick={() => playQueue([resultToItem(t)], 0)}
                  className="rounded-lg bg-white/10 p-2 text-ink-100 transition-all hover:bg-dj-indigo"
                  aria-label="Play"
                >
                  <Play className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
