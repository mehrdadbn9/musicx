import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  ChevronLeft,
  Disc3,
  ListMusic,
  LoaderCircle,
  MicVocal,
  Music2,
  SearchX,
  Sparkles,
} from 'lucide-react'
import clsx from 'clsx'
import type { ResultKind, SearchResult, Source } from '../lib/api'
import { usePointerDrag } from '../lib/usePointerDrag'
import { QuickDownload } from './QuickDownload'
import { SimilarSongs } from './SimilarSongs'

interface Props {
  query: string
  results: SearchResult[]
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onPick: (result: SearchResult) => void
  /** Search a bare query — what a recommendation row becomes when clicked. */
  onSearchQuery: (query: string) => void
}

const SOURCE_META: Record<Source, { label: string; dot: string }> = {
  deezer: { label: 'Deezer', dot: 'bg-[#a238ff]' },
  itunes: { label: 'Apple', dot: 'bg-[#fa5c73]' },
  youtube: { label: 'YouTube', dot: 'bg-[#ff4e45]' },
  soundcloud: { label: 'SoundCloud', dot: 'bg-[#ff7700]' },
}

/** `noun` is the singular — "More tracks", "3 albums" need it, and it can't
 *  be reliably derived from the plural label. */
const KINDS = [
  { kind: 'track', label: 'Tracks', noun: 'track', icon: Music2, preview: 6 },
  { kind: 'artist', label: 'Artists', noun: 'artist', icon: MicVocal, preview: 6 },
  { kind: 'album', label: 'Albums', noun: 'album', icon: Disc3, preview: 8 },
  { kind: 'playlist', label: 'Playlists', noun: 'playlist', icon: ListMusic, preview: 4 },
] as const

type Tab = 'all' | ResultKind

/** Index handed to the CSS stagger (`.stagger > *` reads --i). */
const stagger = (i: number) => ({ '--i': i }) as CSSProperties

export function SourceBadge({ source }: { source: Source }) {
  const meta = SOURCE_META[source]
  if (!meta) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-ink-700 px-2 py-0.5 text-micro font-medium tracking-wide text-ink-400">
      <span className={clsx('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}

function TrackList({
  items,
  downloadable,
  onPick,
  onSearchQuery,
  onReorder,
}: {
  items: SearchResult[]
  downloadable?: boolean
  onPick: Props['onPick']
  onSearchQuery: Props['onSearchQuery']
  onReorder?: (from: number, to: number) => void
}) {
  // Which track's "more like this" panel is open, keyed by dedup_key.
  const [expanded, setExpanded] = useState<string | null>(null)
  const drag = usePointerDrag(items.length, (from, to) => onReorder?.(from, to))
  return (
    <ul className="stagger">
      {items.map((item, i) => (
        <li
          key={item.dedup_key}
          ref={drag.setRowRef(i)}
          {...drag.rowProps(i)}
          style={stagger(i)}
          className={clsx(
            'group transition-colors hover:bg-ink-800/60 focus-within:bg-ink-800/60',
            drag.dragIndex === i && 'opacity-40',
            drag.overIndex === i && drag.dragIndex !== null && 'outline-1 outline-lime-flash',
          )}
        >
          <div className="flex items-center gap-3 pe-5">
            {onReorder && (
              <span
                {...drag.handleProps(i)}
                className="cursor-grab select-none px-1 text-ink-600 hover:text-ink-300 active:cursor-grabbing touch-none"
                title="Drag to reorder"
                aria-label="Drag to reorder"
              >
                ⠿
              </span>
            )}
            <button
              onClick={() => onPick(item)}
              className="flex min-w-0 flex-1 items-center gap-4 py-2.5 ps-5 text-start focus-visible:outline-none"
            >
              {item.cover_url ? (
                <img
                  src={item.cover_url}
                  alt=""
                  loading="lazy"
                  className="size-10 shrink-0 rounded-ctl object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="grid size-10 shrink-0 place-items-center rounded-ctl bg-ink-800">
                  <Music2 className="size-4 text-ink-400" />
                </div>
              )}
              {/* dir on the wrapper, not the lines: the title picks the
                  direction and the subtitle follows it, so a Persian track
                  doesn't sit right-aligned above a left-aligned artist. */}
              <div className="min-w-0 flex-1" dir="auto">
                <p className="truncate text-body font-medium text-ink-100">{item.name}</p>
                {item.subtitle && <p className="truncate text-mini text-ink-400">{item.subtitle}</p>}
              </div>
              <SourceBadge source={item.source} />
            </button>
            {downloadable && (
              <button
                onClick={() => setExpanded(expanded === item.dedup_key ? null : item.dedup_key)}
                aria-expanded={expanded === item.dedup_key}
                aria-label="More like this track"
                title="More like this"
                className={clsx(
                  'shrink-0 rounded-full p-2 transition duration-200 active:scale-95',
                  expanded === item.dedup_key
                    ? 'bg-ink-800 text-lime-flash'
                    : 'text-ink-500 hover:bg-ink-800 hover:text-ink-200',
                )}
              >
                <Sparkles className="size-4" />
              </button>
            )}
            {downloadable && <QuickDownload result={item} />}
          </div>
          {expanded === item.dedup_key && (
            <div className="border-t border-ink-800/70 bg-ink-950/40 px-5 pb-4">
              <SimilarSongs
                titles={[item.name]}
                kind="track"
                artist={item.subtitle?.split('·')[0]?.trim()}
                onPick={onSearchQuery}
                className="mt-4"
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function CardGrid({
  items,
  round,
  onPick,
}: {
  items: SearchResult[]
  round?: boolean
  onPick: Props['onPick']
}) {
  return (
    <ul
      className={clsx(
        'stagger grid gap-x-4 gap-y-5 px-5 pb-4',
        round
          ? 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6'
          : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4',
      )}
    >
      {items.map((item, i) => (
        <li key={item.dedup_key} style={stagger(i)}>
          <button
            onClick={() => onPick(item)}
            className="group w-full text-start focus-visible:outline-none"
            dir="auto"
          >
            <div
              className={clsx(
                'relative overflow-hidden bg-ink-800 ring-1 ring-ink-700/60 transition duration-300',
                'group-hover:-translate-y-1 group-hover:ring-ink-600',
                'group-focus-visible:ring-2 group-focus-visible:ring-lime-flash',
                round ? 'aspect-square rounded-full' : 'aspect-square rounded-btn',
              )}
            >
              {item.cover_url ? (
                <img
                  src={item.cover_url}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
              ) : (
                <div className="grid size-full place-items-center">
                  {round ? (
                    <MicVocal className="size-6 text-ink-400" />
                  ) : (
                    <Disc3 className="size-6 text-ink-400" />
                  )}
                </div>
              )}
            </div>
            <p
              className={clsx(
                'mt-2 truncate text-mini font-medium text-ink-100 transition-colors group-hover:text-lime-flash',
                round && 'text-center',
              )}
            >
              {item.name}
            </p>
            {item.subtitle && (
              <p className={clsx('truncate text-xs text-ink-400', round && 'text-center')}>
                {item.subtitle}
              </p>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function SearchResults({
  query,
  results,
  hasMore,
  loadingMore,
  onLoadMore,
  onPick,
  onSearchQuery,
}: Props) {
  const [tab, setTab] = useState<Tab>('all')
  // Local drag-reorder of the track list. Stored as an ordered list of
  // dedup_keys; null means "use the provider order". Reset whenever the
  // underlying results change so a fresh search starts un-reordered.
  const [trackOrder, setTrackOrder] = useState<string[] | null>(null)
  useEffect(() => setTrackOrder(null), [results])

  const grouped = useMemo(() => {
    const map = new Map<ResultKind, SearchResult[]>()
    for (const r of results) {
      const list = map.get(r.kind) ?? []
      list.push(r)
      map.set(r.kind, list)
    }
    return map
  }, [results])

  if (results.length === 0) {
    return (
      <section className="rounded-panel border border-ink-700 bg-ink-900/70 px-5 py-14 text-center backdrop-blur-md">
        <SearchX className="mx-auto size-7 text-ink-600" />
        <p className="mt-3 text-body font-medium text-ink-100">
          Nothing found for <span dir="auto">“{query}”</span>
        </p>
        <p className="mx-auto mt-1.5 max-w-xs text-mini text-ink-400">
          Try just the artist name, check the spelling, or paste an album link instead.
        </p>
      </section>
    )
  }

  const sections = KINDS.filter(({ kind }) => (grouped.get(kind) ?? []).length > 0)
  // Null on the "All" tab — that view doesn't page.
  const activeKind = KINDS.find(({ kind }) => kind === tab) ?? null

  return (
    <section className="overflow-hidden rounded-panel border border-ink-700 bg-ink-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4">
        <h2 className="truncate text-body font-medium text-ink-100">
          Results for{' '}
          <span className="text-lime-flash" dir="auto">
            {query}
          </span>
        </h2>
        <p aria-live="polite" className="text-mini text-ink-400 tabular-nums">
          {results.length} result{results.length === 1 ? '' : 's'}
          {hasMore && ' so far'}
        </p>
      </div>

      <nav
        aria-label="Filter results"
        className="flex flex-wrap items-center gap-1.5 border-b border-ink-800 px-4 py-3"
      >
        {(
          [
            { kind: 'all', label: 'All', count: results.length },
            ...sections.map(({ kind, label }) => ({
              kind,
              label,
              count: grouped.get(kind)!.length,
            })),
          ] as { kind: Tab; label: string; count: number }[]
        ).map(({ kind, label, count }) => (
          <button
            key={kind}
            onClick={() => setTab(kind)}
            aria-pressed={tab === kind}
            className={clsx(
              'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-mini font-medium transition duration-200 active:scale-[0.97]',
              tab === kind
                ? 'bg-lime-flash text-lime-ink'
                : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
            )}
          >
            {label}
            <span
              className={clsx(
                'text-micro tabular-nums',
                tab === kind ? 'text-lime-ink/70' : 'text-ink-400',
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </nav>

      {sections
        .filter(({ kind }) => tab === 'all' || tab === kind)
        .map(({ kind, label, icon: Icon, preview }) => {
          const items = grouped.get(kind)!
          const shown = tab === 'all' ? items.slice(0, preview) : items
          // Apply the user's drag order to the track list (others stay as-is).
          const ordered =
            kind === 'track' && trackOrder
              ? [...shown].sort(
                  (a, b) =>
                    trackOrder.indexOf(a.dedup_key) - trackOrder.indexOf(b.dedup_key),
                )
              : shown
          const hidden = items.length - shown.length
          return (
            <div key={kind} className="border-b border-ink-800 last:border-b-0">
              <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
                <h3 className="flex items-center gap-2 text-micro font-semibold text-ink-400">
                  <Icon className="size-3.5" />
                  {label}
                  {kind === 'track' && trackOrder && (
                    <button
                      onClick={() => setTrackOrder(null)}
                      className="ms-2 rounded-full px-2 py-0.5 text-[10px] font-medium text-ink-500 transition hover:bg-ink-800 hover:text-ink-200"
                      title="Reset to default order"
                    >
                      reset
                    </button>
                  )}
                </h3>
                {hidden > 0 && (
                  <button
                    onClick={() => setTab(kind)}
                    className="group flex items-center gap-0.5 text-xs font-medium text-lime-flash transition hover:text-lime-soft"
                  >
                    Show all {items.length}
                    <ChevronLeft className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
                  </button>
                )}
              </div>
              {kind === 'track' || kind === 'playlist' ? (
                <div className="pb-2">
                  <TrackList
                    items={ordered}
                    downloadable={kind === 'track'}
                    onPick={onPick}
                    onSearchQuery={onSearchQuery}
                    onReorder={
                      kind === 'track'
                        ? (from, to) => {
                            const base = shown.map((t) => t.dedup_key)
                            const next = [...base]
                            const [moved] = next.splice(from, 1)
                            next.splice(to, 0, moved)
                            setTrackOrder(next)
                          }
                        : undefined
                    }
                  />
                </div>
              ) : (
                <CardGrid items={shown} round={kind === 'artist'} onPick={onPick} />
              )}
            </div>
          )
        })}

      {/* Paging is deliberately manual: one page is a fan-out across four
          providers, so it only runs when the user asks. "All" is a summary of
          what's already loaded — you go deeper from inside a category. */}
      {activeKind && (
        <div className="flex items-center justify-center px-5 py-4">
          {loadingMore ? (
            <span className="flex items-center gap-2 text-mini text-ink-400">
              <LoaderCircle className="size-3.5 animate-spin text-lime-flash" />
              Searching deeper…
            </span>
          ) : hasMore ? (
            <button
              onClick={onLoadMore}
              className="rounded-full border border-ink-700 px-4 py-1.5 text-mini font-medium text-ink-300 transition duration-200 hover:border-ink-600 hover:text-ink-100 active:scale-[0.97]"
            >
              More {activeKind.noun}s
            </button>
          ) : (
            <span className="text-mini text-ink-400">
              That's all — {grouped.get(activeKind.kind)?.length ?? 0} {activeKind.noun}s across all
              sources.
            </span>
          )}
        </div>
      )}
    </section>
  )
}
