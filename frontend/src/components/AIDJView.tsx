import { useState } from 'react'
import { AudioLines, Play, Sparkles, Wand2 } from 'lucide-react'
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
  'Heavy gym phonk 150 bpm',
  'Lo-fi beats to study',
  'Late night coding drive',
  'Sunset afro house party',
  'Calm piano to sleep',
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
    <div className="mx-auto max-w-2xl pt-6">
      {/* Gemini-style AI hero */}
      <div className="dj-hero rounded-2xl p-6">
        <div className="flex items-center gap-2 text-gradient text-lg font-bold">
          <Wand2 className="size-5" /> AI Vibe DJ
        </div>
        <p className="mt-1 text-sm text-ink-300">
          Describe a mood or moment. A free AI model reads the vibe and builds a real mix from the catalog — instantly, or enhanced by a free LLM.
        </p>
        <div className="mt-4 flex items-end gap-2">
          <textarea
            value={vibe}
            onChange={(e) => setVibe(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate() } }}
            rows={2}
            placeholder="e.g. heavy gym phonk 150 bpm"
            className="dj-input flex-1 resize-none rounded-xl bg-ink-900/70 p-3 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent"
          />
          <button
            onClick={() => generate()}
            disabled={loading || enhancing || !vibe.trim()}
            className="dj-go flex items-center gap-1.5 rounded-xl bg-accent px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            <Sparkles className="size-4" /> {loading ? 'Mixing…' : 'Generate mix'}
          </button>
          <button
            onClick={enhance}
            disabled={loading || enhancing || !vibe.trim()}
            title="Wait for the free LLM to craft a smarter mix (takes ~15-20s)"
            className="dj-go flex items-center gap-1.5 rounded-xl bg-ink-800 px-4 py-3 text-sm font-bold text-ink-100 ring-1 ring-ink-700 hover:ring-accent disabled:opacity-50"
          >
            <Wand2 className="size-4" /> {enhancing ? 'Thinking…' : '✨ Enhance with AI'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s}
              onClick={() => generate(s)}
              className="rounded-full bg-ink-800/80 px-3 py-1 text-xs text-ink-200 ring-1 ring-ink-700 hover:ring-accent"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      )}

      {loading && (
        <div className="mt-6 flex items-center justify-center gap-2 text-ink-300">
          <AudioLines className="size-5 animate-pulse" /> Reading the vibe…
        </div>
      )}
      {enhancing && (
        <div className="mt-6 flex items-center justify-center gap-2 text-ink-300">
          <Wand2 className="size-5 animate-pulse" /> Thinking with the free AI model… (~15-20s)
        </div>
      )}

      {profile && !loading && (
        <div className="mt-6">
          {/* Mix card — Gemini glass style */}
          <div className="dj-mix-card rounded-2xl p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-bold capitalize">{profile.energy} energy mix</h2>
              {model && (
                <span className="rounded-full bg-lime-flash/15 px-2 py-0.5 text-[11px] font-semibold text-lime-flash">
                  {model.includes('offline') ? 'offline' : 'free LLM'}
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Energy" value={profile.energy} />
              <Stat label="Genres" value={(profile.genres ?? []).join(', ')} />
              <Stat label="Tempo" value={profile.bpm} />
              <Stat label="Query" value={profile.query} />
            </div>
            {profile.eq && <p className="mt-3 text-xs text-ink-300">EQ · {profile.eq}</p>}
            <button
              onClick={playMix}
              disabled={!tracks.length}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-bold text-white disabled:opacity-50"
            >
              <Play className="size-4" /> Play mix ({tracks.length})
            </button>
          </div>

          {/* Track list */}
          <ul className="mt-4 space-y-2">
            {tracks.map((t, i) => (
              <li
                key={t.dedup_key}
                className="flex items-center gap-3 rounded-xl bg-ink-800/60 p-3 ring-1 ring-ink-700"
              >
                <span className="w-5 text-center text-xs tabular-nums text-ink-400">{i + 1}</span>
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
                  className="rounded-lg bg-ink-700 p-2 text-ink-100 hover:bg-accent"
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

function Stat({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-lg bg-ink-900/60 p-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className="truncate font-semibold text-ink-100">{value || '—'}</div>
    </div>
  )
}
