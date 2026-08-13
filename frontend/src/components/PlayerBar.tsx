import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  ListMusic,
  LoaderCircle,
  Maximize2,
  MicVocal,
  Pause,
  Play,
  Rewind,
  FastForward,
  SkipBack,
  SkipForward,
  Sparkles,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
  Shuffle,
  Repeat,
  Heart,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import clsx from 'clsx'
import {
  addSimilarAfterCurrent,
  formatTime,
  next,
  nudge,
  playQueue,
  previous,
  seek,
  setVolume,
  stop,
  toggle,
  toggleMute,
  toggleRepeat,
  shuffleQueue,
  setNowPlayingOpen,
  toggleLiked,
  isLiked,
} from '../lib/player'
import { usePlayer } from '../lib/usePlayer'

/** Fixed transport at the bottom of the screen, shown whenever something is
 *  loaded. The downloads dock lifts itself clear of this when it is present.
 *
 *  Everything plays at full length: a downloaded track off disk, anything
 *  else proxied by /api/stream. The badge on a proxied track explains the
 *  wait before it starts, not a limit on how much of it will play.
 */
export function PlayerBar() {
  const { queue, index, playing, loading, position, duration, volume, muted, shuffle, repeat, error } = usePlayer()
  const item = queue[index]

  // While dragging, the thumb follows the pointer instead of the element's
  // own timeupdate — otherwise every frame snaps it back to the real time.
  const [scrubbing, setScrubbing] = useState<number | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [addingSimilar, setAddingSimilar] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  // Lyrics state. `lyricsFor` remembers which track the loaded lyrics belong
  // to, so reopening the panel for the same song is instant and switching
  // tracks never shows the previous song's words.
  const lyricsKey = item ? `${item.artist}|${item.title}` : ''
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [lyricsLoading, setLyricsLoading] = useState(false)
  const [lyrics, setLyrics] = useState<{
    found: boolean
    synced: string | null
    plain: string | null
    source?: string
  } | null>(null)
  const [lyricsFor, setLyricsFor] = useState('')

  // A new track closes the lyrics panel — the words on screen belong to the
  // song that just ended, and refetching on every tick would be noise.
  useEffect(() => {
    setLyricsOpen(false)
  }, [item?.id])

  const openLyrics = async () => {
    if (!item) return
    setLyricsOpen(true)
    if (lyricsFor === lyricsKey && lyrics) return
    setLyricsLoading(true)
    setLyrics(null)
    try {
      const params = new URLSearchParams({ title: item.title })
      if (item.artist) params.set('artist', item.artist)
      const res = await fetch(`/api/lyrics?${params}`)
      if (!res.ok) throw new Error(`lyrics ${res.status}`)
      const data = await res.json()
      setLyrics(data)
      setLyricsFor(lyricsKey)
    } catch {
      setLyrics({ found: false, synced: null, plain: null })
    } finally {
      setLyricsLoading(false)
    }
  }

  const seekable = Number.isFinite(duration) && duration > 0
  const shown = scrubbing ?? position
  const fraction = seekable ? Math.min(1, shown / duration) : 0

  // Transport from the keyboard. Never while the user is typing, which is
  // the whole reason this checks the focused element first — otherwise Space
  // in the search box would pause the music instead of typing a space.
  //
  // Media keys (the play/pause and track keys on a keyboard) are not handled
  // here: those arrive through the Media Session handlers in lib/player.ts,
  // which is also what puts the control in Chrome's toolbar.
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          toggle()
          break
        // Shift turns a 10-second nudge into a track change: the same axis,
        // the bigger jump, which is easier to remember than a separate pair.
        case 'ArrowRight':
          e.preventDefault()
          if (e.shiftKey) next()
          else nudge(10)
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (e.shiftKey) previous()
          else nudge(-10)
          break
        case 'KeyN':
          next()
          break
        case 'KeyP':
          previous()
          break
        case 'KeyM':
          toggleMute()
          break
        case 'Escape':
          stop()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item])

  if (!item) return null

  const positionFrom = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || !seekable) return 0
    // Measured from the left edge, and the bar is forced to dir="ltr" below
    // so that is genuinely where zero is. Time is not text: it runs forwards
    // in both scripts, and the seek bar sits directly under a `/`-separated
    // clock that reads left-to-right too.
    const ratio = (clientX - rect.left) / rect.width
    return Math.max(0, Math.min(1, ratio)) * duration
  }

  // Collapsed mini-player: a slim bar with cover, title, play/pause, and an
  // expand affordance. Keeps the player out of the way while still showing
  // what's on and letting one tap resume.
  if (collapsed && item) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-950/95 backdrop-blur-md pb-[var(--safe-bottom)]">
        <div className="flex items-center gap-3 px-3 py-2">
          {item.cover ? (
            <img src={item.cover} alt="" className="size-10 rounded-ctl object-cover" />
          ) : (
            <div className="size-10 rounded-ctl bg-ink-800" />
          )}
          <div className="min-w-0 flex-1" dir="auto">
            <p className="truncate text-sm font-medium text-ink-100">{item.title}</p>
            <p className="truncate text-mini text-ink-400">{item.artist || 'Unknown artist'}</p>
          </div>
          <button
            onClick={previous}
            aria-label="Previous"
            className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 hover:text-ink-100"
          >
            <SkipBack className="size-4" />
          </button>
          <button
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="tap-target grid size-10 place-items-center rounded-full accent-gradient text-white"
          >
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
          </button>
          <button
            onClick={next}
            aria-label="Next"
            className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 hover:text-ink-100"
          >
            <SkipForward className="size-4" />
          </button>
          <button
            onClick={() => setCollapsed(false)}
            aria-label="Expand player"
            className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 hover:text-lime-flash"
          >
            <ChevronUp className="size-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-950/95 backdrop-blur-md pb-[var(--safe-bottom)]">
      {/* Seek bar spans the full width, sitting on the top edge like a
          progress line — the same shape the download rows use. */}
      <div
        ref={barRef}
        dir="ltr"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={seekable ? Math.round(duration) : 0}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
        onPointerDown={(e) => {
          if (!seekable) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setScrubbing(positionFrom(e.clientX))
        }}
        onPointerMove={(e) => {
          if (scrubbing === null) return
          setScrubbing(positionFrom(e.clientX))
        }}
        onPointerUp={(e) => {
          if (scrubbing === null) return
          e.currentTarget.releasePointerCapture(e.pointerId)
          seek(scrubbing)
          setScrubbing(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seek(position + 5)
          if (e.key === 'ArrowLeft') seek(position - 5)
        }}
        className={clsx(
          'group relative h-1.5 w-full touch-none bg-ink-800',
          seekable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        {/* left-0, not end-0: `end` resolves to the *left* edge under the
            page's RTL direction, which put the fill's origin opposite to
            where the pointer maths read it from — every click landed at the
            mirrored time. Both are anchored on the left now. */}
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#a855f7] via-[#c026d3] to-[#ec4899] transition-[width] duration-100 ease-linear"
          style={{ width: `${fraction * 100}%` }}
        />
        {seekable && (
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-[0_0_0_3px_rgba(192,38,211,0.55)] transition-opacity group-hover:opacity-100"
            style={{ left: `${fraction * 100}%` }}
          />
        )}
      </div>

      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
        {item.cover ? (
          <img src={item.cover} alt="" className="size-11 shrink-0 rounded-ctl object-cover" />
        ) : (
          <div className="size-11 shrink-0 rounded-ctl bg-ink-800" />
        )}

        <div className="min-w-0 flex-1" dir="auto">
          <p className="truncate text-sm font-medium text-ink-100">{item.title}</p>
          <p className="truncate text-mini text-ink-500">
            {item.artist}
            {error ? (
              // The stream could not be resolved (most often the upstream
              // service refusing the request). role=alert so a screen reader
              // announces the failure instead of the user staring at a bar
              // that quietly stopped. Play retries the same src; skip moves on.
              <span role="alert" className="ms-1.5 inline-flex items-center gap-1 text-danger">
                <TriangleAlert className="size-3 shrink-0" />
                Couldn't play — press play to retry or skip
              </span>
            ) : item.kind === 'stream' && (
              // Not downloaded: the server is resolving and relaying this
              // one. Full length either way — the badge explains the pause
              // before it starts, and why downloading is still worth it.
              <span className="ms-1.5 rounded-full border border-ink-700 px-1.5 py-px text-micro text-ink-400">
                Streaming — download it to make it instant and offline
              </span>
            )}
          </p>
        </div>

        {/* dir="ltr" because a clock is not RTL text: inside the page's
            right-to-left flow the bidi algorithm swaps the two sides and
            renders elapsed/total as total/elapsed. */}
        <span dir="ltr" className="hidden shrink-0 text-mini tabular-nums text-ink-500 sm:block">
          {formatTime(shown)} / {formatTime(duration)}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <TransportButton
            onClick={previous}
            label="Previous (P or Shift+←)"
            disabled={queue.length < 2 && position < 3}
          >
            <SkipBack className="size-4" />
          </TransportButton>
          <TransportButton onClick={() => nudge(-10)} label="Back 10s (←)" disabled={!seekable}>
            <Rewind className="size-4" />
          </TransportButton>

          <button
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            className="tap-target grid size-10 place-items-center rounded-full accent-gradient text-white shadow-[0_8px_24px_-8px_rgba(192,38,211,0.8)] transition duration-200 hover:brightness-110 active:scale-90"
          >
            {loading ? (
              <LoaderCircle className="size-4.5 animate-spin" />
            ) : playing ? (
              <Pause className="size-4.5" />
            ) : (
              <Play className="size-4.5 translate-x-px" />
            )}
          </button>

          <TransportButton onClick={() => nudge(10)} label="Forward 10s (→)" disabled={!seekable}>
            <FastForward className="size-4" />
          </TransportButton>
          <TransportButton
            onClick={next}
            label="Next (N or Shift+→)"
            disabled={index + 1 >= queue.length}
          >
            <SkipForward className="size-4" />
          </TransportButton>
        </div>

        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <button
            onClick={shuffleQueue}
            aria-label={`Shuffle ${shuffle ? '(on)' : ''}`}
            title={`Shuffle ${shuffle ? '(on)' : ''}`}
            className={clsx(
              'tap-target grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
              shuffle ? 'text-lime-flash' : 'text-ink-400 hover:text-lime-flash',
            )}
          >
            <Shuffle className="size-4" />
          </button>
          <button
            onClick={toggleRepeat}
            aria-label={`Repeat ${repeat === true ? '(all)' : repeat === 'one' ? '(one)' : ''}`}
            title={`Repeat ${repeat === true ? '(all)' : repeat === 'one' ? '(one)' : ''}`}
            className={clsx(
              'tap-target grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
              repeat ? 'text-lime-flash' : 'text-ink-400 hover:text-lime-flash',
            )}
          >
            <Repeat className="size-4" />
          </button>
          <TransportButton onClick={toggleMute} label={muted ? 'Unmute (M)' : 'Mute (M)'}>
            {muted || volume === 0 ? (
              <VolumeX className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </TransportButton>
          <input
            dir="ltr"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            className="h-1 w-16 cursor-pointer accent-lime-flash"
          />
        </div>

        <button
          onClick={() => item && toggleLiked(item)}
          aria-label={item && isLiked(item.id) ? 'Remove from liked' : 'Add to liked'}
          aria-pressed={item ? isLiked(item.id) : false}
          title="Like"
          className={clsx(
            'tap-target grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
            item && isLiked(item.id) ? 'text-red-400' : 'text-ink-400 hover:text-red-400',
          )}
        >
          <Heart className={clsx('size-4', item && isLiked(item.id) && 'fill-current')} />
        </button>

        <button
          onClick={() => {
            if (panelOpen) setPanelOpen(false)
            void openLyrics()
          }}
          aria-label="Lyrics"
          aria-expanded={lyricsOpen}
          title="Lyrics"
          className={clsx(
            'tap-target relative grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
            lyricsOpen ? 'text-lime-flash' : 'text-ink-400 hover:text-lime-flash',
          )}
        >
          <MicVocal className="size-4" />
        </button>

        <button
          onClick={() => {
            if (lyricsOpen) setLyricsOpen(false)
            setPanelOpen((v) => !v)
          }}
          aria-label="Up next — the song list"
          aria-expanded={panelOpen}
          title="Up next — the song list"
          className={clsx(
            'tap-target relative grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
            panelOpen ? 'text-lime-flash' : 'text-ink-400 hover:text-lime-flash',
          )}
        >
          <ListMusic className="size-4" />
          {queue.length > 0 && (
            <span className="absolute -top-0.5 -end-0.5 grid min-w-4 place-items-center rounded-full bg-fuchsia-500 px-1 text-[10px] font-semibold leading-4 text-white">
              {queue.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setNowPlayingOpen(true)}
          aria-label="Open Now Playing"
          title="Open Now Playing"
          className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 hover:text-lime-flash transition duration-200 active:scale-90"
        >
          <Maximize2 className="size-4" />
        </button>

        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? 'Expand player' : 'Collapse player'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 hover:text-lime-flash transition duration-200 active:scale-90"
        >
          <ChevronDown className={clsx('size-4 transition-transform', collapsed && 'rotate-180')} />
        </button>

        <TransportButton onClick={stop} label="Close player (Esc)">
          <X className="size-4" />
        </TransportButton>
      </div>

      {/* The song list. This is what survives leaving the playlist view: the
          queue is global and persisted, and the panel is the way to see it,
          jump around in it, and grow it with songs similar to the one being
          played — which is also how a finished playlist keeps going. */}
      {panelOpen && (
        <div className="absolute inset-x-0 bottom-full border-t border-ink-800 bg-ink-950/95 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-ink-100">
              Up next
              <span className="ms-1.5 text-mini font-normal text-ink-400">
                {queue.length} {queue.length === 1 ? 'song' : 'songs'}
              </span>
            </h2>
            <button
              onClick={() => setPanelOpen(false)}
              aria-label="Close up next"
              className="tap-target grid size-8 place-items-center rounded-ctl text-ink-400 transition duration-200 hover:text-lime-flash"
            >
              <X className="size-4" />
            </button>
          </div>

          <ol className="max-h-[38vh] overflow-y-auto px-2 py-2">
            {queue.map((q, i) => (
              <li key={`${q.id}-${i}`}>
                <button
                  onClick={() => playQueue(queue, i)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start transition duration-150',
                    i === index ? 'bg-ink-800/80' : 'hover:bg-ink-800/50',
                  )}
                >
                  <span
                    className={clsx(
                      'w-5 shrink-0 text-end text-micro tabular-nums',
                      i === index ? 'text-lime-flash' : 'text-ink-500',
                    )}
                  >
                    {i === index ? <AudioLines className="size-3.5 animate-pulse" /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={clsx(
                        'block truncate text-mini',
                        i === index ? 'text-ink-100' : 'text-ink-300',
                      )}
                    >
                      {q.title}
                    </span>
                    <span className="block truncate text-micro text-ink-500">{q.artist}</span>
                  </span>
                  {q.suggested && (
                    <Sparkles className="size-3.5 shrink-0 text-fuchsia-400" aria-label="Suggested" />
                  )}
                </button>
              </li>
            ))}
          </ol>

          <div className="border-t border-ink-800 px-4 py-2.5">
            <button
              onClick={async () => {
                setAddingSimilar(true)
                try {
                  await addSimilarAfterCurrent()
                } finally {
                  setAddingSimilar(false)
                }
              }}
              disabled={addingSimilar}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700 px-3 py-2 text-mini text-ink-200 transition duration-200 hover:border-fuchsia-500/50 hover:text-ink-100 disabled:opacity-60"
            >
              {addingSimilar ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Add similar songs near this one
            </button>
          </div>
        </div>
      )}
      {lyricsOpen && (
        <div className="absolute inset-x-0 bottom-full border-t border-ink-800 bg-ink-950/95 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2.5">
            <h2 className="flex min-w-0 items-baseline gap-1.5 text-sm font-semibold text-ink-100">
              Lyrics
              <span className="truncate text-mini font-normal text-ink-400">{item.title}</span>
            </h2>
            <button
              onClick={() => setLyricsOpen(false)}
              aria-label="Close lyrics"
              className="tap-target grid size-8 shrink-0 place-items-center rounded-ctl text-ink-400 transition duration-200 hover:text-lime-flash"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="max-h-[38vh] overflow-y-auto px-4 py-3" dir="auto">
            {lyricsLoading ? (
              <div className="flex items-center gap-2 py-6 text-mini text-ink-400">
                <LoaderCircle className="size-3.5 animate-spin" />
                Looking for lyrics…
              </div>
            ) : !lyrics?.found ? (
              <p className="py-6 text-mini text-ink-500">No lyrics found for this track.</p>
            ) : lyrics.synced ? (
              <SyncedLines text={lyrics.synced} position={position} />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-200">
                {lyrics.plain}
              </pre>
            )}
            {lyrics?.found && lyrics.source && (
              <p className="mt-3 border-t border-ink-800 pt-2 text-micro text-ink-500">
                via {lyrics.source}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Synced LRC lyrics: the current line follows the playback position and
 *  stays centered as the song moves. Lines without a timestamp are treated
 *  as never-active (instruments, metadata) and shown dimmed. */
function SyncedLines({ text, position }: { text: string; position: number }) {
  const lines = useMemo(
    () =>
      text.split('\n').map((raw) => {
        const tags = [...raw.matchAll(/\[(\d{1,2}:)?(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
        const first = tags[0]
        if (!first) return { t: Infinity, text: raw.trim() }
        const mins = first[1] ? parseInt(first[1], 10) : 0
        const secs = parseInt(first[2], 10)
        const frac = first[3] ? parseFloat(`0.${first[3].padEnd(3, '0')}`) : 0
        return {
          t: mins * 60 + secs + frac,
          text: raw.replace(/\[[^\]]*\]/g, '').trim(),
        }
      }),
    [text],
  )

  const active = useMemo(() => {
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= position + 0.5) idx = i
      else break
    }
    return idx
  }, [lines, position])

  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active >= 0) activeRef.current?.scrollIntoView({ block: 'center' })
  }, [active])

  return (
    <div className="space-y-1.5 py-1">
      {lines.map((line, i) => (
        <div
          key={i}
          ref={i === active ? activeRef : undefined}
          className={clsx(
            'text-sm leading-relaxed transition-colors duration-300',
            i === active ? 'font-medium text-lime-flash' : 'text-ink-300',
          )}
        >
          {line.text || '\u00A0'}
        </div>
      ))}
    </div>
  )
}

function TransportButton({
  onClick,
  label,
  disabled = false,
  children,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx(
        'tap-target grid size-8 place-items-center rounded-ctl transition duration-200 active:scale-90',
        disabled ? 'cursor-not-allowed text-ink-700' : 'text-ink-400 hover:text-lime-flash',
      )}
    >
      {children}
    </button>
  )
}

export { NowPlaying } from './NowPlaying'
