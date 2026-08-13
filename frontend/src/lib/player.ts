/** The audio player: one `<audio>` element, a queue, and transport controls.
 *
 *  Both source kinds play the whole song; they differ in what it costs:
 *
 *  - `file` — a track this instance downloaded, served off disk from
 *    `/api/jobs/<job>/tracks/<track>/file`. Instant, and seeking is free.
 *  - `stream` — resolved and proxied on demand by `/api/stream`. Takes a
 *    second or two to start, because the server has to find the upload
 *    first, and every seek is a fresh range request over the network.
 *
 *  Note that the catalog's own `preview_url` is deliberately *not* used: it
 *  is 30 seconds long and cannot be made longer, which is a worse answer
 *  than waiting a moment for the real thing.
 *
 *  A store rather than React state: the element must survive navigation
 *  between views, and two components (the row and the player bar) drive the
 *  same playback. Subscribers read it through `useSyncExternalStore`.
 */

import { getSimilar, getSimilarFromCatalog, type SimilarSong } from './api'

export type SourceKind = 'stream' | 'file'

export interface PlayableItem {
  /** Track id — the same one the rows and job states use. */
  id: string
  title: string
  artist: string
  cover: string | null
  src: string
  kind: SourceKind
  /** Appended by "similar songs" (manual or at the end of the queue), not
   *  part of the user's original selection. The up-next panel marks these
   *  with a sparkle so recommendations stay honest. */
  suggested?: boolean
}

interface State {
  queue: PlayableItem[]
  index: number
  playing: boolean
  loading: boolean
  /** Seconds. `duration` is NaN until metadata arrives, and Infinity for a
   *  stream of unknown length — both render as "--:--" rather than a lie. */
  position: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: boolean | 'one'
  /** Whether the full-screen "Now Playing" overlay is open. Lifted into the
   *  store so any component (the player bar's expand button, the overlay's
   *  own close affordance) can drive it without prop-drilling. */
  nowPlayingOpen: boolean
  /** Tracks the user has hearted. Stored as full items so any surface — the
   *  bar, the overlay, a row — can render and play them back without a
   *  second lookup, and "is this liked?" is a cheap id check. */
  liked: PlayableItem[]
  /** Why the current track is not playing, when it isn't. Set on a load
   *  failure (e.g. the server could not resolve the stream) and cleared on
   *  the next load, retry, or stop — never left to poison a later track. */
  error: string | null
}

let state: State = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  position: 0,
  duration: NaN,
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: false,
  nowPlayingOpen: false,
  liked: [],
  error: null,
}

/** The one reason a track fails to load from here: the src could not be
 *  fetched. `el.error.code` only distinguishes network vs format, and the
 *  HTTP status of the proxied stream never reaches the element, so the
 *  honest, useful message is the same for every failure. */
const LOAD_ERROR = "Couldn't play — the stream couldn't be resolved. Press play to retry, or skip to the next track."

const listeners = new Set<() => void>()
let audio: HTMLAudioElement | null = null

/** A new object every time: useSyncExternalStore compares snapshots by
 *  identity, so mutating in place would never notify anyone. */
function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
  persist()
}

const VOLUME_KEY = 'musicx:volume'
const SESSION_KEY = 'musicx:player'

/** What survives a reload: the queue, which track, and how far into it — so
 *  the bar comes back exactly where it was, paused, ready to resume. Playback
 *  itself does not auto-start: browsers block that, and a page silently
 *  resuming audio on load is hostile anyway. Only the fields that matter are
 *  written, so the blob stays small and has no DOM or function in it.
 *
 *  Throttled: `set` runs on every timeupdate (~4x/second), and writing
 *  localStorage that often is wasteful. Position is flushed at most once a
 *  second; a queue or track change writes immediately, because losing which
 *  song is playing matters and losing two seconds of elapsed time does not. */
let lastPersist = 0
let lastPersistedIndex = -1

function persist() {
  try {
    if (state.index < 0 || !state.queue[state.index]) {
      localStorage.removeItem(SESSION_KEY)
      lastPersistedIndex = -1
      return
    }
    const now = Date.now()
    const trackChanged = state.index !== lastPersistedIndex
    if (!trackChanged && now - lastPersist < 1000) return
    lastPersist = now
    lastPersistedIndex = state.index
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ queue: state.queue, index: state.index, position: state.position }),
    )
  } catch {
    // A full or disabled localStorage must never take playback down.
  }
}

/** Position to seek to once the restored track reports its duration. Zero
 *  means "no pending restore". */
let pendingSeek = 0

function restore() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { queue?: PlayableItem[]; index?: number; position?: number }
    const queue = saved.queue ?? []
    const index = saved.index ?? -1
    if (index < 0 || !queue[index]) return
    const el = ensureAudio()
    state = { ...state, queue, index, position: saved.position ?? 0, playing: false }
    pendingSeek = saved.position ?? 0
    el.src = queue[index].src
    publishSession(queue[index])
  } catch {
    // Corrupt or partial state is simply ignored — the player starts empty.
  }
}

/** The level to come back to when unmuting. Kept separate from `volume` so
 *  that a volume of zero — however it got there, including a value persisted
 *  by an earlier session — is always recoverable in one press. */
let lastAudible = 1

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio
  const el = new Audio()
  el.preload = 'metadata'

  const stored = Number(localStorage.getItem(VOLUME_KEY))
  if (Number.isFinite(stored) && stored > 0 && stored <= 1) {
    el.volume = stored
    lastAudible = stored
    state = { ...state, volume: stored }
  } else if (stored === 0) {
    // Silent from a previous session. Restored as such, but `lastAudible`
    // stays at full so the speaker button is a working unmute rather than a
    // no-op on an already-zero volume.
    el.volume = 0
    state = { ...state, volume: 0, muted: true }
    el.muted = true
  }

  el.addEventListener('loadedmetadata', () => {
    set({ duration: el.duration })
    // A restored track seeks to where it was left, once, as soon as the
    // duration it can seek within is known.
    if (pendingSeek > 0 && Number.isFinite(el.duration)) {
      el.currentTime = Math.min(pendingSeek, el.duration)
      pendingSeek = 0
    }
  })
  el.addEventListener('durationchange', () => set({ duration: el.duration }))
  el.addEventListener('timeupdate', () => {
    set({ position: el.currentTime })
    // Drives the scrubber inside Chrome's own media control. Rejected for a
    // stream of unknown length, which is why it is guarded rather than sent
    // unconditionally.
    if (navigator.mediaSession?.setPositionState && Number.isFinite(el.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: el.duration,
          position: Math.min(el.currentTime, el.duration),
          playbackRate: el.playbackRate,
        })
      } catch {
        // Ignored: a position state the browser rejects is cosmetic only.
      }
    }
  })
  el.addEventListener('play', () => {
    set({ playing: true })
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
  })
  el.addEventListener('pause', () => {
    set({ playing: false })
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'
  })
  el.addEventListener('waiting', () => set({ loading: true }))
  el.addEventListener('playing', () => set({ playing: true, loading: false }))
  el.addEventListener('ended', () => next())
  el.addEventListener('error', () =>
    set({ playing: false, loading: false, error: LOAD_ERROR }),
  )
  audio = el
  return el
}

/** Hand the track to the OS: Chrome's media control in the toolbar, the
 *  media keys on a keyboard, the lock screen on a phone. Without this the
 *  hardware play/pause key does nothing and the toolbar shows no session.
 *
 *  Guarded because Media Session is not in every browser, and a missing API
 *  must not take playback down with it. */
function publishSession(item: PlayableItem) {
  const media = navigator.mediaSession
  if (!media) return
  try {
    media.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist,
      artwork: item.cover ? [{ src: item.cover, sizes: '512x512' }] : [],
    })
    media.setActionHandler('play', () => toggle())
    media.setActionHandler('pause', () => toggle())
    media.setActionHandler('previoustrack', () => previous())
    media.setActionHandler('nexttrack', () => next())
    media.setActionHandler('seekbackward', () => nudge(-10))
    media.setActionHandler('seekforward', () => nudge(10))
    media.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) seek(details.seekTime)
    })
    media.setActionHandler('stop', () => stop())
  } catch {
    // An unsupported action throws rather than returning; the rest stand.
  }
}

/** Load `index` of the queue and start it. */
function load(index: number) {
  const item = state.queue[index]
  if (!item) return
  const el = ensureAudio()
  set({ index, loading: true, position: 0, duration: NaN, error: null })
  el.src = item.src
  publishSession(item)
  el.play().catch(() => set({ playing: false, loading: false, error: LOAD_ERROR }))
}

/** Play a queue from `startIndex`. Re-pressing play on the track already
 *  loaded toggles it instead of restarting from zero. */
export function playQueue(queue: PlayableItem[], startIndex = 0) {
  const current = state.queue[state.index]
  const wanted = queue[startIndex]
  if (current && wanted && current.id === wanted.id && current.src === wanted.src) {
    // Same track and same source — treat as a transport toggle. A track that
    // has since been downloaded arrives with a different src and reloads,
    // which is how a 30-second preview upgrades to the full file.
    set({ queue })
    toggle()
    return
  }
  set({ queue })
  load(startIndex)
}

/** A stream item for a recommendation row: there is no page and no duration
 *  yet — the server finds the upload by title when it is played, the same
 *  way a search result plays. */
export function suggestedItem(song: SimilarSong): PlayableItem {
  const params = new URLSearchParams({ title: song.track_name, artist: song.artist_name })
  return {
    id: `sim-${song.artist_name}-${song.track_name}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    title: song.track_name,
    artist: song.artist_name,
    cover: null,
    src: `/api/stream?${params.toString()}`,
    kind: 'stream',
    suggested: true,
  }
}

/** Songs near a track: the offline English dataset first, Deezer's
 *  related-artists graph when the dataset does not know it — the path that
 *  answers for the Persian and other non-Western music this instance plays.
 *  Empty when there is nothing similar, never throws. */
export async function similarTo(item: PlayableItem): Promise<PlayableItem[]> {
  if (!item.title.trim()) return []
  const key = `${item.artist} - ${item.title}`.toLowerCase()
  if (suggestedFor.has(key)) return []
  const recs = await getSimilar(item.title, 8).catch(() => null)
  const source =
    recs?.results ??
    (await getSimilarFromCatalog(item.artist, [item.title], 8).catch(() => null))?.results ??
    []
  if (source.length === 0) return []
  suggestedFor.add(key)
  const known = new Set(state.queue.map((q) => `${q.artist} - ${q.title}`.toLowerCase()))
  return source.map(suggestedItem).filter((s) => !known.has(`${s.artist} - ${s.title}`.toLowerCase()))
}

/** Fetch songs similar to the current track and insert them right after it,
 *  so the queue literally shows what is "near" the song being played.
 *  Returns how many were added. */
export async function addSimilarAfterCurrent(): Promise<number> {
  const item = state.queue[state.index]
  if (!item) return 0
  const items = await similarTo(item)
  if (items.length === 0) return 0
  const at = state.index + 1
  const queue = [...state.queue.slice(0, at), ...items, ...state.queue.slice(at)]
  set({ queue })
  return items.length
}

/** Tracks we have already pulled suggestions for this session — one batch
 *  per track, so "add similar" is idempotent but a radio chain (each
 *  suggested track's own neighbours) still flows. Cleared on stop. */
const suggestedFor = new Set<string>()

export function toggle() {
  const el = ensureAudio()
  if (state.index < 0) return
  if (el.paused) {
    // After a failure the element still holds the dead src; load() resets it
    // and re-fetches, which is what turns "retry" into an actual retry. The
    // server only caches successful resolves, so a transient failure (e.g.
    // YouTube bot-checking the request) has a real chance on the second go.
    if (state.error) {
      set({ error: null, loading: true })
      el.load()
    }
    el.play().catch(() => set({ playing: false, loading: false, error: LOAD_ERROR }))
  } else {
    el.pause()
  }
}

export function next() {
  if (state.repeat === 'one') {
    seek(0)
    return
  }
  let nextIndex = state.index + 1
  if (state.shuffle && state.queue.length > 1) {
    // Shuffle: pick a random track that isn't the current one
    const candidates = state.queue.map((_, i) => i).filter(i => i !== state.index)
    nextIndex = candidates[Math.floor(Math.random() * candidates.length)]
  }
  if (nextIndex < state.queue.length) {
    load(nextIndex)
  } else if (state.repeat === true) {
    load(0)
  } else {
    // End of the queue: rather than stopping, pull songs similar to the
    // track that just finished and keep playing (radio), so a finished song
    // is followed by songs near it. Falls back to the old stop when nothing
    // similar is found or the fetch fails — never crash playback.
    continueWithSimilar(state.queue[state.index])
  }
}

async function continueWithSimilar(finished: PlayableItem | undefined) {
  const stopAtEnd = () => {
    ensureAudio().pause()
    set({ playing: false, position: 0 })
  }
  if (!finished) return stopAtEnd()
  try {
    const items = await similarTo(finished)
    if (items.length === 0) return stopAtEnd()
    const queue = [...state.queue, ...items]
    set({ queue })
    load(state.queue.length - 1)
  } catch {
    stopAtEnd()
  }
}

/** Previous track, or restart this one — the convention every player uses. */
export function previous() {
  if (state.position > 3 || state.index <= 0) {
    seek(0)
    return
  }
  if (state.shuffle && state.queue.length > 1) {
    // In shuffle, "previous" goes to a random track (like Spotify)
    const candidates = state.queue.map((_, i) => i).filter(i => i !== state.index)
    load(candidates[Math.floor(Math.random() * candidates.length)])
    return
  }
  load(state.index - 1)
}

export function seek(seconds: number) {
  const el = ensureAudio()
  if (!Number.isFinite(el.duration)) return
  el.currentTime = Math.max(0, Math.min(seconds, el.duration))
  set({ position: el.currentTime })
}

/** Seconds forward (negative to go back) — the arrow-key and skip buttons. */
export function nudge(seconds: number) {
  seek(state.position + seconds)
}

export function setVolume(volume: number) {
  const el = ensureAudio()
  const clamped = Math.max(0, Math.min(1, volume))
  el.volume = clamped
  // Dragging the slider is itself an unmute; dragging it to zero is a mute
  // that the speaker button must still be able to undo, which is what
  // `lastAudible` is for.
  el.muted = false
  if (clamped > 0) lastAudible = clamped
  localStorage.setItem(VOLUME_KEY, String(clamped))
  set({ volume: clamped, muted: clamped === 0 })
}

/** Silence, or come back from it — whichever the player is not already.
 *
 *  Both `muted` and a volume of zero are silence as far as anyone listening
 *  is concerned, so both have to be undone here. Flipping only the `muted`
 *  flag left a zero-volume player just as silent, with a button that
 *  appeared to do nothing.
 */
export function toggleMute() {
  const el = ensureAudio()
  const silent = el.muted || el.volume === 0
  if (silent) {
    const restored = lastAudible > 0 ? lastAudible : 1
    el.muted = false
    el.volume = restored
    localStorage.setItem(VOLUME_KEY, String(restored))
    set({ muted: false, volume: restored })
  } else {
    lastAudible = el.volume
    el.muted = true
    set({ muted: true })
  }
}

/** Open/close the full-screen Now Playing overlay. */
export function setNowPlayingOpen(open: boolean) {
  set({ nowPlayingOpen: open })
}

/** Heart / un-heart a track. The full item is kept (not just the id) so the
 *  liked list can be rendered and played back from any surface without a
 *  second lookup; "is this liked?" stays a cheap id check. */
export function toggleLiked(item: PlayableItem) {
  if (!item?.id) return
  const liked = state.liked.some((x) => x.id === item.id)
    ? state.liked.filter((x) => x.id !== item.id)
    : [item, ...state.liked]
  set({ liked })
  persistLiked(liked)
}

/** Is a given track currently liked. */
export function isLiked(id: string): boolean {
  return state.liked.some((x) => x.id === id)
}

const LIKED_KEY = 'musicx:liked'

function persistLiked(liked: PlayableItem[]) {
  try {
    // Persist only the fields needed to render + replay; never the live
    // audio element or anything circular.
    localStorage.setItem(LIKED_KEY, JSON.stringify(liked))
  } catch {
    // A full localStorage must never take playback down.
  }
}

function restoreLiked() {
  try {
    const raw = localStorage.getItem(LIKED_KEY)
    if (!raw) return
    const liked = JSON.parse(raw)
    if (Array.isArray(liked)) {
      state = {
        ...state,
        liked: liked.filter(
          (x): x is PlayableItem =>
            x && typeof x.id === 'string' && typeof x.title === 'string',
        ),
      }
    }
  } catch {
    // Corrupt liked list is simply ignored.
  }
}

/** Toggle shuffle mode. */
export function shuffleQueue() {
  set({ shuffle: !state.shuffle })
}

/** Toggle repeat: off -> all -> one -> off. */
export function toggleRepeat() {
  const next = state.repeat === false ? true : state.repeat === true ? 'one' : false
  set({ repeat: next })
}

/** Reorder the queue by moving the item at `from` to position `to`.
 *
 *  Both indices are absolute queue positions (including the currently
 *  playing track at `state.index`). Used by drag-and-drop in the Now Playing
 *  queue so the user can build and edit their own playback order. */
export function reorderQueue(from: number, to: number) {
  if (
    from < 0 ||
    to < 0 ||
    from >= state.queue.length ||
    to >= state.queue.length ||
    from === to
  )
    return
  const queue = [...state.queue]
  const [moved] = queue.splice(from, 1)
  queue.splice(to, 0, moved)
  // Keep the currently playing track pinned: its position may have shifted,
  // so track which item that was and restore its index.
  const playingId = state.queue[state.index]?.id
  const newIndex = queue.findIndex((q) => q.id === playingId)
  set({ queue, index: newIndex >= 0 ? newIndex : state.index })
  persist()
}

/** Move a track to the front of the queue (becomes the next played track
 *  once the current one ends). `id` is a queue item id. */
export function moveToFirst(id: string) {
  const from = state.queue.findIndex((q) => q.id === id)
  if (from < 0) return
  reorderQueue(from, state.index + 1)
}

/** Stop and clear — the bar's close button. */
export function stop() {
  const el = ensureAudio()
  el.pause()
  el.removeAttribute('src')
  el.load()
  if (navigator.mediaSession) {
    // Otherwise Chrome keeps the toolbar control alive with the metadata of
    // a track that is no longer loaded.
    navigator.mediaSession.metadata = null
    navigator.mediaSession.playbackState = 'none'
  }
  suggestedFor.clear()
  set({ queue: [], index: -1, playing: false, loading: false, position: 0, duration: NaN, shuffle: false, repeat: false, nowPlayingOpen: false, error: null })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => state

export { subscribe, snapshot }

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Bring back the last session's bar as soon as this module loads — in the
// browser only, and guarded so it can never keep the app from starting.
if (typeof window !== 'undefined') {
  restore()
  restoreLiked()
  // Persist the exact position on the way out; timeupdate only fires while
  // playing, so a paused tab closing would otherwise save a stale position.
  window.addEventListener('pagehide', persist)
}
