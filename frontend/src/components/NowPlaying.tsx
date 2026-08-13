import { useEffect, useRef, useState } from 'react'
import { ListMusic, Mic, Repeat, Shuffle, Volume2, VolumeX, Heart } from 'lucide-react'
import clsx from 'clsx'
import {
  seek,
  toggleMute,
  next,
  previous,
  toggle,
  shuffleQueue,
  toggleRepeat,
  formatTime,
  toggleLiked,
  isLiked,
  reorderQueue,
  moveToFirst,
} from '../lib/player'
import { usePlayer } from '../lib/usePlayer'
import { useLyrics } from '../lib/lyrics'

/** Full-screen Now Playing overlay — the "Spotify" expanded view.
 *  Opens when clicking the player bar, closes on drag-down or backdrop click. */
export function NowPlaying({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = usePlayer()
  const [dragging, setDragging] = useState(false)
  const [dragY, setDragY] = useState(0)
  const [lyricsOpen, setLyricsOpen] = useState(true)
  const [queueOpen, setQueueOpen] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const lyrics = useLyrics(state.queue[state.index]?.title || '', state.queue[state.index]?.artist || '')
  const progressRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)

  const current = state.queue[state.index]

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    setDragging(true)
    setDragY('touches' in e ? e.touches[0].clientY : e.clientY)
    e.preventDefault()
  }

  const handleDragMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging) return
    const y = 'touches' in e ? e.touches[0].clientY : e.clientY
    const delta = y - dragY
    if (delta > 0) setDragY(y)
  }

  const handleDragEnd = (e: React.MouseEvent | React.TouchEvent) => {
    if (!dragging) return
    const y = 'touches' in e ? e.changedTouches[0].clientY : e.clientY
    if (y - dragY > 100) onClose()
    setDragging(false)
    setDragY(0)
  }

  const handleProgressClick = (e: React.MouseEvent) => {
    if (!progressRef.current || !Number.isFinite(state.duration)) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seek(pct * state.duration)
  }

  if (!open || !current) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-950 animate-slide-up" role="dialog" aria-modal="true">
      {/* Drag handle */}
      <div
        ref={handleRef}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        className="mx-auto mt-4 w-10 h-1 rounded-full bg-ink-700 cursor-ns-resize touch-none"
        aria-hidden="true"
      />

      {/* Backdrop close */}
      <div
        onClick={onClose}
        className="flex-1"
        onMouseMove={handleDragMove}
        onMouseUp={handleDragEnd}
        onTouchMove={handleDragMove}
        onTouchEnd={handleDragEnd}
      >
        <div className="flex flex-col h-full overflow-hidden">
          {/* Cover art — large, centered */}
          <div className="flex flex-col items-center pt-6 pb-4 px-4">
            {current.cover ? (
              <img
                src={current.cover}
                alt=""
                className="w-64 h-64 sm:w-80 sm:h-80 rounded-xl shadow-2xl object-cover animate-scale-in"
              />
            ) : (
              <div className="w-64 h-64 sm:w-80 sm:h-80 rounded-xl shadow-2xl bg-ink-800 flex items-center justify-center">
                <Mic className="size-16 text-ink-600" />
              </div>
            )}

            <div className="mt-6 text-center px-4">
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-ink-100 truncate max-w-xs mx-auto" dir="auto">
                {current.title}
              </h1>
              <p className="mt-1 text-sm text-ink-400 truncate max-w-xs mx-auto" dir="auto">
                {current.artist || 'Unknown artist'}
              </p>
              {current.kind === 'stream' && (
                <span className="mt-2 inline-flex items-center gap-1 text-mini text-lime-flash/80 px-2 py-0.5 rounded-full bg-lime-flash/10">
                  <span className="size-1.5 rounded-full bg-lime-flash animate-pulse" />
                  Live stream
                </span>
              )}
            </div>
          </div>

          {/* Lyrics / Queue tabs */}
          <div className="flex px-4 border-t border-ink-800">
            <button
              onClick={() => { setLyricsOpen(true); setQueueOpen(false) }}
              className={clsx('flex-1 py-3 text-mini font-medium border-b-2 transition', lyricsOpen ? 'border-lime-flash text-lime-flash' : 'border-transparent text-ink-400 hover:text-ink-100')}
            >
              <Mic className="size-4 inline mr-1" /> Lyrics
            </button>
            <button
              onClick={() => { setQueueOpen(true); setLyricsOpen(false) }}
              className={clsx('flex-1 py-3 text-mini font-medium border-b-2 transition', queueOpen ? 'border-lime-flash text-lime-flash' : 'border-transparent text-ink-400 hover:text-ink-100')}
            >
              <ListMusic className="size-4 inline mr-1" /> Queue ({state.queue.length})
            </button>
          </div>

          {/* Content panel */}
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {lyricsOpen && (
              <div className="mt-4 max-w-md mx-auto">
                {lyrics.loading ? (
                  <div className="text-center text-ink-500 py-8">Loading lyrics…</div>
                ) : lyrics.error ? (
                  <div className="text-center text-ink-500 py-8">
                    <Mic className="size-12 mx-auto mb-2 text-ink-600" />
                    <p>No lyrics found for this track</p>
                    <p className="text-mini mt-1">Try a different version or check spelling</p>
                  </div>
                ) : (
                  <div className="space-y-1 text-center leading-relaxed">
                    {lyrics.text && lyrics.synced ? (
                      lyrics.text.split('\n').map((line: string, i: number) => {
                        const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/)
                        if (!match) return <p key={i} className="text-sm text-ink-400">{line}</p>
                        const [, min, sec, , text] = match
                        const lineTime = parseInt(min) * 60 + parseInt(sec)
                        const isCurrent = Math.abs(state.position - lineTime) < 1.5
                        return (
                          <p
                            key={i}
                            className={clsx(
                              'text-base cursor-pointer transition select-none',
                              isCurrent ? 'text-lime-flash font-medium' : 'text-ink-300 hover:text-ink-100'
                            )}
                            onClick={() => seek(lineTime)}
                          >
                            {text || '♪'}
                          </p>
                        )
                      })
                    ) : lyrics.text ? (
                      lyrics.text.split('\n').map((line: string, i: number) => (
                        <p key={i} className="text-sm text-ink-400">{line || '♪'}</p>
                      ))
                    ) : (
                      <p className="text-ink-400">No lyrics text available</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {queueOpen && (
              <div className="mt-4 max-w-md mx-auto">
                {state.queue.length === 0 ? (
                  <div className="text-center text-ink-500 py-8">
                    <ListMusic className="size-12 mx-auto mb-2 text-ink-600" />
                    <p>Queue is empty</p>
                    <p className="text-mini mt-1">Play more music to build your queue</p>
                  </div>
                ) : (
                  <>
                    <p className="text-micro text-ink-500 mb-2 text-center">
                      Drag to reorder · “Play first” sends a track to the top of what's next
                    </p>
                    <ul className="space-y-2">
                      {state.queue.map((item, i) => {
                        const isCurrent = i === state.index
                        return (
                          <li
                            key={item.id}
                            onDragOver={(e) => {
                              e.preventDefault()
                              setOverIndex(i)
                            }}
                            onDrop={(e) => {
                              if (dragIndex !== null && dragIndex !== i) reorderQueue(dragIndex, i)
                              setDragIndex(null)
                              setOverIndex(null)
                              e.preventDefault()
                            }}
                            onDragEnd={() => {
                              setDragIndex(null)
                              setOverIndex(null)
                            }}
                            className={clsx(
                              'flex items-center gap-3 rounded-btn border p-2 transition',
                              isCurrent
                                ? 'border-lime-flash/60 bg-lime-flash/10'
                                : item.suggested
                                  ? 'border-lime-flash/30 bg-lime-flash/5'
                                  : 'border-ink-800 bg-ink-900 hover:border-ink-700',
                              dragIndex === i && 'opacity-40',
                              overIndex === i && dragIndex !== null && 'border-lime-flash'
                            )}
                          >
                            <span
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move'
                                e.dataTransfer.setData('text/plain', String(i))
                                setDragIndex(i)
                              }}
                              className="cursor-grab active:cursor-grabbing text-ink-600 hover:text-ink-300 select-none px-1"
                              title="Drag to reorder"
                              aria-label="Drag to reorder"
                            >
                              ⠿
                            </span>
                            <span className="text-mini text-ink-500 w-6 text-right font-mono tabular-nums">
                              {isCurrent ? '▶' : i + 1}
                            </span>
                            {item.cover ? (
                              <img src={item.cover} alt="" className="size-10 rounded-ctl object-cover" />
                            ) : (
                              <div className="size-10 rounded-ctl bg-ink-800 flex items-center justify-center">
                                <Mic className="size-4 text-ink-600" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1" dir="auto">
                              <p className="truncate text-sm font-medium text-ink-100">{item.title}</p>
                              <p className="truncate text-mini text-ink-500">{item.artist}</p>
                            </div>
                            {item.suggested && (
                              <span className="text-micro text-lime-flash px-1.5 py-0.5 rounded-full bg-lime-flash/10">
                                Suggested
                              </span>
                            )}
                            {!isCurrent && (
                              <button
                                onClick={() => moveToFirst(item.id)}
                                className="tap-target text-micro rounded-ctl px-2 py-1 text-ink-400 transition hover:bg-ink-800 hover:text-lime-flash"
                                title="Play this next"
                                aria-label={`Play ${item.title} next`}
                              >
                                Play first
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div className="px-4 pb-2">
            <div className="flex items-center gap-3 text-mini text-ink-400">
              <span className="w-10 text-right">{formatTime(state.position)}</span>
              <div
                ref={progressRef}
                onClick={handleProgressClick}
                className="flex-1 h-1.5 rounded-full bg-ink-800 cursor-pointer relative"
                role="slider"
                aria-label="Playback progress"
                aria-valuemin={0}
                aria-valuemax={Number.isFinite(state.duration) ? Math.floor(state.duration) : 100}
                aria-valuenow={Math.floor(state.position)}
              >
                {Number.isFinite(state.duration) && state.duration > 0 && (
                  <div
                    className="absolute top-0 left-0 h-full rounded-full bg-lime-flash transition-all duration-75"
                    style={{ width: `${(state.position / state.duration) * 100}%` }}
                  />
                )}
              </div>
              <span className="w-10">{formatTime(state.duration)}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="px-4 pb-6 flex flex-col items-center gap-4">
            <div className="flex items-center gap-6">
              <button
                onClick={toggleMute}
                className={clsx('tap-target grid size-10 place-items-center rounded-full transition', state.muted || state.volume === 0 ? 'text-ink-400' : 'text-ink-100 hover:text-lime-flash')}
                aria-label={state.muted || state.volume === 0 ? 'Unmute' : 'Mute'}
              >
                {state.muted || state.volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
              </button>

              <button onClick={previous} className="tap-target grid size-12 place-items-center rounded-full text-ink-100 hover:text-lime-flash transition" aria-label="Previous">
                <svg className="size-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
              </button>

              <button
                onClick={toggle}
                className="tap-target grid size-18 place-items-center rounded-full bg-lime-flash text-lime-ink shadow-lg shadow-lime-flash/30 transition active:scale-95 hover:shadow-lime-flash/50"
                aria-label={state.playing ? 'Pause' : 'Play'}
              >
                {state.playing ? <svg className="size-7" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> : <svg className="size-7 translate-x-px" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
              </button>

              <button onClick={next} className="tap-target grid size-12 place-items-center rounded-full text-ink-100 hover:text-lime-flash transition" aria-label="Next">
                <svg className="size-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
              </button>

              <button
                onClick={toggleMute}
                className={clsx('tap-target grid size-10 place-items-center rounded-full transition', state.muted || state.volume === 0 ? 'text-ink-400' : 'text-ink-100 hover:text-lime-flash')}
                aria-label={state.muted || state.volume === 0 ? 'Unmute' : 'Mute'}
              >
                {state.muted || state.volume === 0 ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
              </button>
            </div>

            {/* Shuffle / Repeat row */}
            <div className="flex items-center gap-4 text-mini">
              <button
                onClick={shuffleQueue}
                className={clsx('tap-target flex items-center gap-1.5 rounded-ctl px-2 py-1 transition', state.shuffle ? 'text-lime-flash' : 'text-ink-400 hover:text-ink-100')}
                aria-label="Shuffle"
                aria-pressed={state.shuffle}
              >
                <Shuffle className="size-4" />
              </button>

              <button
                onClick={toggleRepeat}
                className={clsx('tap-target flex items-center gap-1.5 rounded-ctl px-2 py-1 transition', state.repeat ? 'text-lime-flash' : 'text-ink-400 hover:text-ink-100')}
                aria-label="Repeat"
                aria-pressed={state.repeat !== false}
              >
                <Repeat className="size-4" />
                {state.repeat === 'one' && <span className="text-[8px] align-top">1</span>}
              </button>

              <button
                onClick={() => current && toggleLiked(current)}
                className={clsx('tap-target flex items-center gap-1.5 rounded-ctl px-2 py-1 transition ml-auto', current && isLiked(current.id) ? 'text-red-400' : 'text-ink-400 hover:text-red-400')}
                aria-label={current && isLiked(current.id) ? 'Remove from liked' : 'Add to liked'}
                aria-pressed={current ? isLiked(current.id) : false}
              >
                <Heart className={clsx('size-4', current && isLiked(current.id) && 'fill-current')} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}