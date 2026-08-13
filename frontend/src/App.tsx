import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Library, Link2 as LinkIcon, Search, Heart } from 'lucide-react'
import clsx from 'clsx'
import {
  apiError,
  getArtist,
  isCatalogUrl,
  mergeResults,
  resolveUrl,
  searchCatalog,
  type ArtistDetail,
  type Collection,
  type SearchResult,
} from './lib/api'
import { UrlForm } from './components/UrlForm'
import { CollectionView } from './components/CollectionView'
import { CollectionSkeleton } from './components/CollectionSkeleton'
import { SearchResults } from './components/SearchResults'
import { ArtistView } from './components/ArtistView'
import { DownloadsDock } from './components/DownloadsDock'
import { PlayerBar, NowPlaying } from './components/PlayerBar'
import { usePlayer } from './lib/usePlayer'
import { setNowPlayingOpen, playQueue } from './lib/player'
import { LibraryView } from './components/LibraryView'
import { getLibraryStatus } from './lib/library'
import { QualityPicker } from './components/QualityPicker'
import { RecentSearches } from './components/RecentSearches'
import { DownloadsProvider, useDownloads } from './lib/downloads'
import { clearRecentSearches, recentSearches, rememberSearch } from './lib/recent'
import { ToastProvider, useToast } from './lib/toast'

/** What's on screen. A stack, so "back" walks search → artist → album. */
type View =
  | {
      type: 'search'
      query: string
      results: SearchResult[]
      /** Highest page fetched so far; infinite scroll asks for page + 1. */
      page: number
      hasMore: boolean
    }
  | { type: 'artist'; artist: ArtistDetail }
  | { type: 'collection'; url: string; collection: Collection }

const BACK_LABEL: Record<View['type'], string> = {
  search: 'Back to results',
  artist: 'Back to artist',
  collection: 'Back',
}

/** Animates its children to and from zero height. `grid-template-rows`
 *  1fr→0fr is the only way to transition to `height: auto`; the inner div does
 *  the clipping. `visibility` is in the transition list on purpose — it keeps
 *  collapsed copy out of the tab order and away from screen readers, but flips
 *  only at the end of the duration, so the content fades rather than vanishing
 *  the instant the collapse starts. */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={clsx(
        'grid transition-[grid-template-rows] duration-300 ease-out-expo',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div
        className={clsx(
          'overflow-hidden transition-[opacity,visibility] duration-300 ease-out-expo',
          open ? 'opacity-100' : 'invisible opacity-0',
        )}
      >
        {children}
      </div>
    </div>
  )
}

const isTypingTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

/** One cell of the landing features grid. An emoji tile on the brand
 *  gradient, a name, and one honest sentence about what the app does. */
function FeatureCard({
  emoji,
  title,
  body,
}: {
  emoji: string
  title: string
  body: string
}) {
  return (
    <div className="rounded-panel border border-ink-700 bg-ink-900/70 p-4 backdrop-blur-md transition duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:bg-ink-900/90">
      <div className="flex items-center gap-3">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-btn bg-gradient-to-br from-[#a855f7] via-[#c026d3] to-[#ec4899] text-xl leading-none shadow-lg shadow-fuchsia-950/40"
          aria-hidden
        >
          {emoji}
        </span>
        <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      </div>
      <p className="mt-2.5 text-mini leading-relaxed text-ink-400">{body}</p>
    </div>
  )
}

/** Toasts when a download job flips to finished, wherever the user is. */
function DownloadNotifier() {
  const { entries } = useDownloads()
  const { push } = useToast()
  const finishedState = useRef<Map<string, boolean>>(new Map())

  useEffect(() => {
    for (const entry of entries) {
      const finished = entry.job?.finished ?? false
      // First sighting records, never announces: a restored job is first seen
      // already finished and must not be toasted twice. A job started here is
      // always first seen unfinished, so nothing is lost.
      const was = finishedState.current.get(entry.jobId)
      if (finished && was === false) {
        const done = entry.job!.done
        const failed = entry.job!.failed
        if (done > 0 && failed === 0) {
          push(`${entry.name} — ${done} track${done > 1 ? 's' : ''} ready to save`, 'success')
        } else if (done > 0) {
          push(`${entry.name} — ${done} ready, ${failed} failed`, 'info')
        } else {
          push(`${entry.name} — download failed`, 'error')
        }
      }
      finishedState.current.set(entry.jobId, finished)
    }
  }, [entries, push])

  return null
}

function Shell() {
  const [stack, setStack] = useState<View[]>([])
  // The library is a separate surface, not a node in the search stack: it is
  // reached from the header and returned from with the same button, so it is
  // a boolean over the top of everything rather than another View.
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryTab, setLibraryTab] = useState<'tracks' | 'playlists' | 'liked'>('tracks')
  // Deep link in the address bar (?url= / ?artist= / ?q=), captured before
  // any effect rewrites the query string.
  const [initialParams] = useState(() => new URLSearchParams(window.location.search))
  const inputRef = useRef<HTMLInputElement | null>(null)

  const { push } = useToast()

  const resolve = useMutation({ mutationFn: resolveUrl })
  const search = useMutation({
    mutationFn: ({ query, page }: { query: string; page?: number }) => searchCatalog(query, page),
  })
  const artist = useMutation({ mutationFn: getArtist })

  // Drives the header library button: its count, and whether to show it at all
  // (a lean/unwritable instance reports unavailable). Refetched on focus so a
  // finished download bumps the badge without a reload.
  const { data: libraryStatus } = useQuery({
    queryKey: ['library-status'],
    queryFn: getLibraryStatus,
    refetchOnWindowFocus: true,
  })

  // Infinite scroll: appended pages must not blank the results already on
  // screen, so they never go through the `search` mutation's pending state.
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)

  // Bumped whenever a shortcut focuses the search box, to flash the form.
  const [focusPulse, setFocusPulse] = useState(0)

  const [recent, setRecent] = useState(recentSearches)

  // Set when this page load came from a shared link. Landing straight in a
  // loading collection with the marketing hero above it reads as the app
  // searching on its own, so that arrival gets its own framing instead.
  const [sharedArrival, setSharedArrival] = useState<
    null | { kind: 'url' | 'artist' } | { kind: 'q'; query: string }
  >(null)

  const leaveSharedArrival = () => {
    setSharedArrival(null)
    setStack([])
    resetErrors()
  }

  // Shared mode hides the search form, so a shortcut pressed there has to
  // leave the mode first and focus once the form has actually mounted.
  const wantsFocusRef = useRef(false)
  useEffect(() => {
    if (sharedArrival || !wantsFocusRef.current) return
    wantsFocusRef.current = false
    inputRef.current?.focus()
  }, [sharedArrival])

  const resetErrors = () => {
    resolve.reset()
    search.reset()
    artist.reset()
  }

  const openCollection = (url: string, pushView: boolean) => {
    resolve.mutate(url, {
      onSuccess: (collection) => {
        const view: View = { type: 'collection', url, collection }
        setStack((s) => (pushView ? [...s, view] : [view]))
      },
    })
  }

  const handleSubmit = (input: string) => {
    resetErrors()
    setSharedArrival(null) // the user is driving now, not the link
    setLibraryOpen(false) // a search takes over the main surface
    setRecent(rememberSearch(input))

    if (isCatalogUrl(input)) {
      openCollection(input, false)
    } else {
      search.mutate(
        { query: input },
        {
          onSuccess: (page) =>
            setStack([
              {
                type: 'search',
                query: input,
                results: page.results,
                page: page.page,
                hasMore: page.has_more,
              },
            ]),
        },
      )
    }
  }

  const handlePick = (result: SearchResult) => {
    resetErrors()
    if (result.kind === 'artist' && result.source === 'deezer') {
      artist.mutate(result.id, {
        onSuccess: (data) => setStack((s) => [...s, { type: 'artist', artist: data }]),
      })
    } else {
      // SoundCloud artists resolve their profile page — yt-dlp turns it
      // into a playlist of everything they've uploaded.
      openCollection(result.url, true)
    }
  }

  const goBack = useCallback(() => setStack((s) => s.slice(0, -1)), [])

  // Refs keep global listeners on a [] dep array without going stale.
  const openCollectionRef = useRef(openCollection)
  openCollectionRef.current = openCollection
  const stackRef = useRef(stack)
  stackRef.current = stack
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  const pushRef = useRef(push)
  pushRef.current = push

  /** Fetch the next page and append it to the search view on top of the stack. */
  const loadMore = useCallback(async () => {
    const top = stackRef.current.at(-1)
    if (top?.type !== 'search' || !top.hasMore || loadingMoreRef.current) return

    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const next = await searchCatalog(top.query, top.page + 1)
      setStack((s) => {
        const current = s.at(-1)
        // The user navigated (or searched again) mid-flight — drop the page.
        if (current?.type !== 'search' || current.query !== top.query) return s
        return [
          ...s.slice(0, -1),
          {
            ...current,
            results: mergeResults(current.results, next.results),
            page: next.page,
            hasMore: next.has_more,
          },
        ]
      })
    } catch (err) {
      pushRef.current(apiError(err), 'error')
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [])

  // Deep link restore: ?url=… / ?artist=… / ?q=…
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    const url = initialParams.get('url')
    const artistId = initialParams.get('artist')
    const q = initialParams.get('q')
    if (url && isCatalogUrl(url)) {
      setSharedArrival({ kind: 'url' })
      openCollection(url, false)
    } else if (artistId) {
      setSharedArrival({ kind: 'artist' })
      artist.mutate(artistId, {
        onSuccess: (data) => setStack([{ type: 'artist', artist: data }]),
      })
    } else if (q) {
      setSharedArrival({ kind: 'q', query: q })
      search.mutate(
        { query: q },
        {
          onSuccess: (page) =>
            setStack([
              {
                type: 'search',
                query: q,
                results: page.results,
                page: page.page,
                hasMore: page.has_more,
              },
            ]),
        },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the address bar shareable: it always mirrors the top view.
  useEffect(() => {
    const view = stack.at(-1)
    const params = new URLSearchParams()
    if (view?.type === 'collection') params.set('url', view.url)
    else if (view?.type === 'artist') params.set('artist', view.artist.id)
    else if (view?.type === 'search') params.set('q', view.query)
    const qs = params.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  }, [stack])

  // A new release's service worker took over — offer a reload. (Hidden tabs
  // already reload themselves; see main.tsx.)
  useEffect(() => {
    const onUpdate = () =>
      pushRef.current('A new version of MusicX is available', 'info', {
        label: 'Refresh',
        onClick: () => window.location.reload(),
      })
    window.addEventListener('musicx:update', onUpdate)
    return () => window.removeEventListener('musicx:update', onUpdate)
  }, [])

  // Smart paste + keyboard shortcuts.
  useEffect(() => {
    // Focus alone is easy to miss — pulse the form so the shortcut lands.
    const focusSearch = (select: boolean) => {
      setFocusPulse((n) => n + 1)
      // The library covers the search form; '/' should bring it back.
      setLibraryOpen(false)
      if (!inputRef.current) {
        // Shared-link mode: swap in the search UI, then focus (see effect).
        wantsFocusRef.current = true
        setSharedArrival(null)
        return
      }
      inputRef.current.focus()
      if (select) inputRef.current.select()
    }

    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return
      const text = e.clipboardData?.getData('text')?.trim()
      if (text && isCatalogUrl(text)) {
        e.preventDefault()
        setSharedArrival(null)
        setRecent(rememberSearch(text))
        pushRef.current('Link detected — opening…', 'info')
        openCollectionRef.current(text, false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        focusSearch(true)
        return
      }
      if (e.key === 'Escape') {
        if (isTypingTarget(e.target)) {
          ;(e.target as HTMLElement).blur()
          return
        }
        goBackRef.current()
        return
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        focusSearch(false)
      }
    }
    document.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const busy = resolve.isPending || search.isPending || artist.isPending
  const error = resolve.error ?? search.error ?? artist.error
  const view = stack.at(-1)
  const previous = stack.at(-2)
  // Nothing asked for yet: the only time the hero earns its screen space.
  // `busy` counts as landed — the skeleton is already below, and holding the
  // hero up through the first search then dropping it reads as a jump. An
  // error counts too: re-expanding would push the message the user needs to
  // read down below a screen of copy they don't.
  const landing = stack.length === 0 && !busy && !error

  const goHome = () => {
    setStack([])
    setSharedArrival(null)
    setLibraryOpen(false)
    resetErrors()
  }

  const viewKey = !view
    ? 'home'
    : view.type === 'collection'
      ? `collection:${view.url}`
      : view.type === 'artist'
        ? `artist:${view.artist.id}`
        : `search:${view.query}`

  return (
    <div className="app-aurora safe-x flex min-h-screen flex-col lg:flex-row">
      <Sidebar
        landing={landing}
        libraryOpen={libraryOpen}
        count={libraryStatus?.tracks ?? 0}
        onHome={goHome}
        onLibrary={() => { setLibraryTab('tracks'); setLibraryOpen((v) => !v); }}
        onLiked={() => { setLibraryTab('liked'); setLibraryOpen(true); }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-5 pt-[calc(2rem+var(--safe-top))] lg:hidden">
        {/* With the hero collapsed, the wordmark is the only way back to it —
            and the first thing anyone tries. */}
        <button
          onClick={goHome}
          disabled={landing}
          aria-label="Home"
          className="group flex items-center gap-2.5 rounded-ctl transition disabled:cursor-default"
        >
          <span className="font-display text-lg font-bold tracking-tight text-ink-100">
            Music<span className="text-gradient">X</span>
          </span>
        </button>
        <LibraryButton
          open={libraryOpen}
          count={libraryStatus?.tracks ?? 0}
          onClick={() => setLibraryOpen((v) => !v)}
        />
        <QualityPicker />
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-24 lg:mx-0 lg:px-10 lg:pt-8">
        {libraryOpen ? (
          <div className="pt-6">
            <LibraryView initialTab={libraryTab} onTabChange={setLibraryTab} />
          </div>
        ) : sharedArrival ? (
          <section className="pt-10 pb-8">
            <div className="animate-fade-up rounded-panel border border-lime-flash/25 bg-lime-flash/[0.06] p-4 sm:p-5">
              <p className="flex items-center gap-2 text-micro font-semibold text-lime-flash">
                <LinkIcon className="size-3.5" />
                Shared link
              </p>
              <h1 className="mt-2 font-display text-2xl font-bold text-balance">
                {error
                  ? "This shared link wouldn't open"
                  : sharedArrival.kind === 'q'
                    ? 'Someone shared a search with you'
                    : busy
                      ? 'Opening what was shared with you…'
                      : 'Someone shared this with you'}
              </h1>
              <p className="mt-2 text-mini text-ink-300">
                {error ? (
                  "The link may be broken or private, or from a source MusicX can't read."
                ) : sharedArrival.kind === 'q' ? (
                  <>
                    Results for{' '}
                    <span className="text-lime-flash" dir="auto">
                      “{sharedArrival.query}”
                    </span>{' '}
                    — opened automatically from the link you followed.
                  </>
                ) : (
                  'MusicX opened this from your link. Pick the tracks you want, or start a new search.'
                )}
              </p>
              <button
                onClick={leaveSharedArrival}
                className="group mt-4 flex items-center gap-1.5 rounded-btn border border-ink-600 px-3.5 py-2 text-mini font-medium text-ink-100 transition duration-200 hover:border-ink-400 active:scale-[0.98]"
              >
                <Search className="size-3.5" />
                Search for something else
                <ArrowLeft className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
              </button>
            </div>
            {error && (
              <p
                role="alert"
                className="mt-4 animate-fade-up rounded-btn border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger"
              >
                {apiError(error)}
              </p>
            )}
          </section>
        ) : (
          // The hero is a landing state. Its copy answers questions someone has
          // *before* they try the app ("no account needed"), so once they have
          // searched it is a screen of read-once marketing between them and
          // every result. It collapses; the form stays and rises to the top.
          <section
            className={clsx(
              'transition-[padding] duration-300 ease-out-expo',
              landing ? 'pt-14 pb-10 sm:pt-16 sm:pb-12' : 'pt-6 pb-5',
            )}
          >
            {/* grid-rows 1fr→0fr is the one way to transition to height:auto;
                the inner wrapper does the clipping. */}
            <Collapsible open={landing}>
              <p className="hero-badge animate-fade-up">
                <span className="badge-mark" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6.6 6.6 17.4 17.4 M17.4 6.6 6.6 17.4"
                      stroke="white"
                      strokeWidth="3.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                Your music, your rules
              </p>
              <h1 className="mt-3 animate-fade-up font-display text-[clamp(2.75rem,8vw,5rem)] leading-[1.05] font-bold tracking-tight text-balance [animation-delay:40ms]">
                Every song,
                <br />
                <span className="text-gradient">one search</span>
              </h1>
            </Collapsible>

            <UrlForm
              className={clsx(
                'max-w-2xl animate-fade-up transition-[margin] duration-300 ease-out-expo [animation-delay:100ms]',
                landing && 'mt-8',
              )}
              loading={busy}
              onSubmit={handleSubmit}
              inputRef={inputRef}
              focusPulse={focusPulse}
            />

            {/* The shortcut hint is a discovery aid and the chips are a
                cold-start affordance — both belong to the empty page only. */}
            <Collapsible open={landing}>
              <p className="mt-6 max-w-lg animate-fade-up text-body leading-relaxed text-ink-300 [animation-delay:180ms]">
                Paste a link or search once — Spotify, YouTube, SoundCloud, Deezer and Apple Music
                answer together. Pick the quality you want, from 128 to the original file, and
                download or stream it live. Smart recommendations find the next song for you.
                No account, no sign-up.
              </p>
              <ul
                className="mt-5 flex animate-fade-up flex-wrap gap-2 [animation-delay:220ms]"
                aria-label="Why MusicX"
              >
                {['No account needed', 'No sign-up', 'Best quality'].map((point) => (
                  <li key={point} className="chip">
                    {point}
                  </li>
                ))}
              </ul>

              {/* The landing features grid: real capabilities, named plainly.
                  Every card maps to a working surface in this app — search,
                  downloads, streaming, recommendations, library. */}
              <div className="mt-8 grid animate-fade-up gap-3 sm:grid-cols-2 [animation-delay:240ms]">
                <FeatureCard
                  emoji="🔍"
                  title="Search every catalog"
                  body="One query covers Spotify, YouTube, SoundCloud, Deezer and Apple Music — plus artist pages and full discographies."
                />
                <FeatureCard
                  emoji="⬇️"
                  title="Download at the quality you pick"
                  body="Tagged MP3s with cover art, from 128 kbps up to the source's original file. Your music, saved locally."
                />
                <FeatureCard
                  emoji="📻"
                  title="Stream it live"
                  body="Play any track straight from the source, no download required. Your queue, your pace."
                />
                <FeatureCard
                  emoji="✨"
                  title="Smart recommendations"
                  body="Based on the music you look at, MusicX suggests the next song — from its dataset and the catalogs themselves."
                />
              </div>

              <p className="mt-6 animate-fade-up text-mini text-ink-400 [animation-delay:280ms]">
                Press{' '}
                <kbd className="rounded-[5px] border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-sans text-micro text-ink-300">
                  /
                </kbd>{' '}
                to search, or paste a link anywhere on the page.
              </p>
              <RecentSearches
                items={recent}
                onPick={handleSubmit}
                onClear={() => setRecent(clearRecentSearches())}
              />
            </Collapsible>

            {error && (
              <p
                role="alert"
                className="mt-4 animate-fade-up rounded-btn border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger"
              >
                {apiError(error)}
              </p>
            )}
          </section>
        )}

        {!libraryOpen && busy && <CollectionSkeleton />}
        {!libraryOpen && !busy && view && (
          <div key={viewKey} className="animate-fade-up">
            {previous && (
              <button
                onClick={goBack}
                className="group mb-3 flex items-center gap-1.5 rounded-ctl px-2 py-1.5 text-mini font-medium text-ink-300 transition hover:bg-ink-800 hover:text-ink-100 active:scale-[0.98]"
              >
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                {BACK_LABEL[previous.type]}
              </button>
            )}
            {view.type === 'search' && (
              <SearchResults
                query={view.query}
                results={view.results}
                hasMore={view.hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
                onPick={handlePick}
                onSearchQuery={handleSubmit}
              />
            )}
            {view.type === 'artist' && (
              <ArtistView artist={view.artist} onPick={handlePick} onSearchQuery={handleSubmit} />
            )}
            {view.type === 'collection' && (
              <CollectionView
                key={view.url}
                url={view.url}
                collection={view.collection}
                onSearch={handleSubmit}
              />
            )}
          </div>
        )}
      </main>
      </div>

      <RightRail tracks={libraryStatus?.tracks ?? 0} playlists={libraryStatus?.playlists ?? 0} />

    <DownloadNotifier />
      <DownloadsDock />
      <PlayerBar />
      <NowPlaying open={usePlayer().nowPlayingOpen} onClose={() => setNowPlayingOpen(false)} />
    </div>
  )
}

/** Supported catalogs with their brand glyphs. The sidebar's Sources list
 *  renders these as quiet badges — glyph + name — so the supported platforms
 *  read at a glance instead of as bare text chips. */
const SOURCES = [
  {
    name: 'Spotify',
    icon: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M7.6 9.4c3.2-.8 6.9-.3 9.3 1M8.3 12.3c2.6-.6 5.6-.2 7.6 1M8.9 15.1c1.9-.4 4 .1 5.6.8" />
      </svg>
    ),
  },
  {
    name: 'YouTube',
    icon: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
        <rect x="2.8" y="5.8" width="18.4" height="12.4" rx="3.6" />
        <path d="M10.4 9.6v4.8l4.4-2.4z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    name: 'SoundCloud',
    icon: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.8 15h11.6a2.4 2.4 0 0 0 .4-4.8 5.8 5.8 0 0 0-11-1.5 3.3 3.3 0 0 0-1 6.3Z" />
        <path d="M8.8 14.8V9.6M11.3 14.8V8.4M13.8 14.8v-4.6M16.3 14.8v-3" />
      </svg>
    ),
  },
  {
    name: 'Deezer',
    icon: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M6.5 17.5 17.5 6.5M6.5 13.5 13.5 6.5M6.5 9.5 9.5 6.5M14.5 17.5 17.5 14.5" />
      </svg>
    ),
  },
  {
    name: 'Apple Music',
    icon: (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="currentColor">
        <path d="M16.7 12.9c0-2.9 2.4-4.3 2.5-4.4-1.4-2-3.5-2.3-4.2-2.3-1.8-.2-3.5 1-4.4 1-.9 0-2.3-1-3.8-1-2 0-3.8 1.1-4.8 2.9-2.1 3.6-.5 8.9 1.5 11.8 1 1.4 2.1 3 3.7 3 1.5 0 2-1 3.8-1s2.3 1 3.9 1c1.6 0 2.6-1.5 3.6-2.9 1.1-1.6 1.6-3.2 1.6-3.3 0 0-3.1-1.2-3.2-4.8ZM14.3 4.4c.8-1 1.4-2.4 1.2-3.8-1.2 0-2.6.8-3.4 1.8-.8.9-1.4 2.2-1.2 3.5 1.3.1 2.6-.6 3.4-1.5Z" />
      </svg>
    ),
  },
]

/** Desktop app shell: a persistent left rail (logo, nav, quality, sources,
 *  credit) so the landing page is a two-column surface instead of a centered
 *  card. Hidden below `lg`; the compact header carries the same controls. */
function Sidebar({
  landing,
  libraryOpen,
  count,
  onHome,
  onLibrary,
  onLiked,
}: {
  landing: boolean
  libraryOpen: boolean
  count: number
  onHome: () => void
  onLibrary: () => void
  onLiked: () => void
}) {
  return (
    <aside className="sidebar-surface sticky top-0 hidden h-screen w-64 shrink-0 flex-col px-4 py-6 lg:flex">
      <button
        onClick={onHome}
        disabled={landing}
        aria-label="MusicX home"
        className="group flex items-center gap-2.5 rounded-ctl px-2 py-1.5 transition disabled:cursor-default"
      >
        <span className="font-display text-lg font-bold tracking-tight text-ink-100">
          Music<span className="text-gradient">X</span>
        </span>
      </button>

      <nav aria-label="Main" className="mt-8 flex flex-col gap-1">
        <button
          onClick={onHome}
          aria-current={landing ? 'page' : undefined}
          className={clsx('nav-item', landing && 'nav-item-active')}
        >
          <Search className="size-4" aria-hidden />
          Home
        </button>
        <button
          onClick={onLibrary}
          aria-pressed={libraryOpen}
          className={clsx('nav-item', libraryOpen && 'nav-item-active')}
        >
          <Library className="size-4" aria-hidden />
          Library
          {count > 0 && (
            <span className="ms-auto rounded-full bg-ink-800 px-1.5 py-px text-micro tabular-nums text-ink-300">
              {count}
            </span>
          )}
        </button>
        <button
          onClick={onLiked}
          className={clsx('nav-item', libraryOpen && 'nav-item-active')}
        >
          <Heart className="size-4" aria-hidden />
          Liked
        </button>
      </nav>

      <div className="mt-8">
        <p className="px-2 text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          Quality
        </p>
        <div className="mt-2">
          <QualityPicker compact />
        </div>
      </div>

      <div className="mt-8">
        <p className="px-2 text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          Sources
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5 px-2">
          {SOURCES.map((s) => (
            <li key={s.name} className="source-badge">
              {s.icon}
              <span>{s.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <NowPlayingWidget />
    </aside>
  )
}

/** Compact "Now Playing" widget pinned to the bottom of the left sidebar.
 *  Only shows once something is loaded; clicking it opens the full-screen
 *  overlay. A quiet, always-visible anchor for the current track. */
function NowPlayingWidget() {
  const { queue, index, playing } = usePlayer()
  const item = queue[index]
  if (!item) return null
  return (
    <div className="mt-auto pt-8">
      <button
        onClick={() => setNowPlayingOpen(true)}
        className="group flex w-full items-center gap-3 rounded-panel border border-ink-700 bg-ink-900/70 p-2.5 text-start transition hover:border-ink-600 hover:bg-ink-800"
        aria-label="Open Now Playing"
      >
        {item.cover ? (
          <img src={item.cover} alt="" className="size-11 shrink-0 rounded-ctl object-cover" />
        ) : (
          <div className="size-11 shrink-0 rounded-ctl bg-ink-800" />
        )}
        <span className="min-w-0 flex-1" dir="auto">
          <span className="block truncate text-mini font-semibold text-ink-100">{item.title}</span>
          <span className="block truncate text-[10px] text-ink-400">{item.artist || 'Unknown artist'}</span>
        </span>
        {playing && (
          <span className="size-1.5 shrink-0 rounded-full bg-lime-flash animate-pulse" aria-hidden />
        )}
      </button>
    </div>
  )
}

/** Desktop-only right rail: quiet, always-true context panels — quality
 *  guide, library stats and the real keyboard shortcuts — that fill the
 *  wide-screen space beside the left-aligned main column. Hidden below
 *  `xl`; purely informational, no duplicated controls. */
function RightRail({ tracks, playlists }: { tracks: number; playlists: number }) {
  const kbd =
    'rounded-md border border-ink-700 bg-ink-800 px-1.5 py-0.5 font-mono text-micro text-ink-200'
  const { liked } = usePlayer()
  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col gap-4 overflow-y-auto px-6 py-6 xl:flex">
      <section className="rounded-panel border border-ink-700 bg-ink-900/70 p-4 backdrop-blur-md">
        <p className="text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          🎚️ Quality
        </p>
        <ul className="mt-3 space-y-2 text-mini leading-relaxed text-ink-300">
          <li className="flex gap-2">
            <span className="font-medium text-ink-200">128 / 192 / 320</span>
            <span>— tagged MP3 bitrates, cover art included</span>
          </li>
          <li className="flex gap-2">
            <span className="font-medium text-ink-200">Original</span>
            <span>— the source&apos;s best file, tags included</span>
          </li>
        </ul>
      </section>

      <section className="rounded-panel border border-ink-700 bg-ink-900/70 p-4 backdrop-blur-md">
        <p className="flex items-center gap-2 text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          <Heart className="size-3.5 text-red-400" /> Liked
          <span className="ms-auto font-normal normal-case tracking-normal text-ink-500">
            {liked.length}
          </span>
        </p>
        {liked.length === 0 ? (
          <p className="mt-3 text-mini leading-relaxed text-ink-400">
            Tap the heart on any track to save it here.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {liked.slice(0, 8).map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => playQueue([t], 0)}
                  className="flex w-full items-center gap-2 rounded-ctl px-1.5 py-1 text-start transition hover:bg-ink-800"
                >
                  {t.cover ? (
                    <img src={t.cover} alt="" className="size-8 shrink-0 rounded-ctl object-cover" />
                  ) : (
                    <div className="size-8 shrink-0 rounded-ctl bg-ink-800" />
                  )}
                  <span className="min-w-0 flex-1" dir="auto">
                    <span className="block truncate text-mini font-medium text-ink-100">{t.title}</span>
                    <span className="block truncate text-[10px] text-ink-400">{t.artist || 'Unknown'}</span>
                  </span>
                </button>
              </li>
            ))}
            {liked.length > 8 && (
              <li className="px-1.5 pt-1 text-[10px] text-ink-500">
                +{liked.length - 8} more
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="rounded-panel border border-ink-700 bg-ink-900/70 p-4 backdrop-blur-md">
        <p className="text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          🎵 Your library
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-btn bg-ink-800/60 px-2 py-2.5">
            <p className="text-lg font-semibold tabular-nums text-ink-100">{tracks}</p>
            <p className="text-micro text-ink-400">tracks</p>
          </div>
          <div className="rounded-btn bg-ink-800/60 px-2 py-2.5">
            <p className="text-lg font-semibold tabular-nums text-ink-100">{playlists}</p>
            <p className="text-micro text-ink-400">playlists</p>
          </div>
        </div>
      </section>

      <section className="rounded-panel border border-ink-700 bg-ink-900/70 p-4 backdrop-blur-md">
        <p className="text-micro font-semibold tracking-[0.18em] text-ink-400 uppercase">
          ⌨️ Shortcuts
        </p>
        <dl className="mt-3 space-y-2 text-mini">
          {[
            ['Play / pause', 'Space'],
            ['Seek ±10s', '← / →'],
            ['Next / previous', 'Shift + ← / →'],
            ['Mute', 'M'],
            ['Stop', 'Esc'],
          ].map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <dt className="text-ink-300">{label}</dt>
              <dd className={kbd}>{keys}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="px-1 text-mini leading-relaxed text-ink-400">
        🖥️ Self-hosted — downloads and your library stay on your own server.
      </p>
    </aside>
  )
}

/** Header toggle into the library. Shows a count so a full library reads as
 *  worth opening; the same button closes it (it is a surface, not a page in
 *  the stack). */
function LibraryButton({
  open,
  count,
  onClick,
}: {
  open: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-label="Library"
      aria-pressed={open}
      title="Library & playlists"
      className={clsx(
        'tap-target ms-auto flex items-center gap-1.5 rounded-ctl border px-3 py-2 text-mini font-medium transition active:scale-95',
        open
          ? 'border-lime-flash/50 bg-lime-flash/10 text-lime-flash'
          : 'border-ink-800 text-ink-300 hover:border-ink-600 hover:text-ink-100',
      )}
    >
      <Library className="size-4" />
      <span className="hidden sm:inline">Library</span>
      {count > 0 && (
        <span className="rounded-full bg-ink-800 px-1.5 py-px text-micro tabular-nums text-ink-300">
          {count}
        </span>
      )}
    </button>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <DownloadsProvider>
        <Shell />
      </DownloadsProvider>
    </ToastProvider>
  )
}
