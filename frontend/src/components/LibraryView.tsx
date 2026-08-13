import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  Heart,
  ListMusic,
  Music2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import {
  addToPlaylist,
  createPlaylist,
  deleteLibraryTrack,
  deletePlaylist,
  getLibrary,
  getPlaylist,
  getPlaylists,
  libraryStreamUrl,
  removeFromPlaylist,
  renamePlaylist,
  type LibraryTrack,
} from '../lib/library'
import { playQueue, toggleLiked, isLiked, type PlayableItem } from '../lib/player'
import { useIsCurrent, usePlayer } from '../lib/usePlayer'
import { useToast } from '../lib/toast'

/** A library track as a player item — full-length file off disk, seekable. */
const toItem = (t: LibraryTrack): PlayableItem => ({
  id: `lib-${t.id}`,
  title: t.title,
  artist: t.artist,
  cover: t.cover_url,
  src: libraryStreamUrl(t.id),
  kind: 'file',
})

/** The library screen: everything downloaded, plus playlists over it. Three
 *  tabs — tracks, playlists, and liked — because "all my music", "my
 *  playlists", and "songs I hearted" are different questions. The active tab
 *  can be driven from outside (the sidebar's Liked shortcut) via props. */
export function LibraryView({
  initialTab = 'tracks',
  onTabChange,
}: {
  initialTab?: 'tracks' | 'playlists' | 'liked'
  onTabChange?: (tab: 'tracks' | 'playlists' | 'liked') => void
} = {}) {
  const [tab, setTab] = useState<'tracks' | 'playlists' | 'liked'>(initialTab)
  const [openPlaylist, setOpenPlaylist] = useState<number | null>(null)

  const selectTab = (next: 'tracks' | 'playlists' | 'liked') => {
    setTab(next)
    onTabChange?.(next)
  }

  // Keep in step with the sidebar shortcut: if the parent changes
  // `initialTab` (e.g. the user clicks "Liked" in the nav while the library
  // is already open), follow it even though this component is already mounted.
  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  if (openPlaylist !== null) {
    return <PlaylistDetail id={openPlaylist} onBack={() => setOpenPlaylist(null)} />
  }

  return (
    <section className="animate-fade-up">
      <div className="mb-4 flex items-center gap-1 rounded-ctl border border-ink-800 bg-ink-900 p-1">
        <TabButton active={tab === 'tracks'} onClick={() => selectTab('tracks')}>
          <Music2 className="size-3.5" />
          Library
        </TabButton>
        <TabButton active={tab === 'playlists'} onClick={() => selectTab('playlists')}>
          <ListMusic className="size-3.5" />
          Playlists
        </TabButton>
        <TabButton active={tab === 'liked'} onClick={() => selectTab('liked')}>
          <Heart className="size-3.5" />
          Liked
        </TabButton>
      </div>

      {tab === 'tracks' ? <TracksTab /> : tab === 'playlists' ? <PlaylistsTab onOpen={setOpenPlaylist} /> : <LikedTab />}
    </section>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'tap-target flex flex-1 items-center justify-center gap-1.5 rounded-btn px-3 py-2 text-mini font-medium transition',
        active ? 'bg-lime-flash text-lime-ink' : 'text-ink-400 hover:text-ink-100',
      )}
    >
      {children}
    </button>
  )
}

function TracksTab() {
  const { data: tracks, isPending } = useQuery({
    queryKey: ['library'],
    queryFn: getLibrary,
  })

  if (isPending) return <Muted>Loading…</Muted>
  if (!tracks || tracks.length === 0) {
    return (
      <Muted>
        No downloads yet. Everything you download lands here — and stays, even after a restart.
      </Muted>
    )
  }

  const items = tracks.map(toItem)

  return (
    <ul className="flex flex-col gap-1.5">
      {tracks.map((track, index) => (
        <TrackRow key={track.id} track={track} onPlay={() => playQueue(items, index)} />
      ))}
    </ul>
  )
}

/** Liked tracks — the hearted songs kept in the player store (and persisted
 *  to localStorage). Unlike the downloaded library, these can be stream or
 *  file items, so each plays through the normal queue. */
function LikedTab() {
  const { liked } = usePlayer()

  if (liked.length === 0) {
    return (
      <Muted>
        No liked songs yet. Tap the heart on any track — in the player bar, the
        Now Playing view, or a row — to save it here.
      </Muted>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {liked.map((item, index) => (
        <LikedRow key={item.id} item={item} onPlay={() => playQueue(liked, index)} />
      ))}
    </ul>
  )
}

function LikedRow({ item, onPlay }: { item: PlayableItem; onPlay: () => void }) {
  const { current, playing } = useIsCurrent(item.id)
  const liked = isLiked(item.id)
  return (
    <li className="group relative flex items-center gap-3 rounded-btn border border-ink-800 bg-ink-900 px-3 py-2.5">
      <button
        onClick={onPlay}
        aria-label={playing ? `Pause ${item.title}` : `Play ${item.title}`}
        className={clsx(
          'tap-target grid size-9 shrink-0 place-items-center rounded-ctl border transition active:scale-90',
          current
            ? 'border-lime-flash/50 bg-lime-flash/10 text-lime-flash'
            : 'border-ink-700 text-ink-300 hover:border-lime-flash/50 hover:text-lime-flash',
        )}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      {item.cover ? (
        <img src={item.cover} alt="" className="size-10 shrink-0 rounded-ctl object-cover" />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-ctl bg-ink-800">
          <Music2 className="size-4 text-ink-600" />
        </div>
      )}

      <div className="min-w-0 flex-1" dir="auto">
        <p
          className={clsx(
            'truncate text-sm font-medium',
            current ? 'text-lime-flash' : 'text-ink-100',
          )}
        >
          {item.title}
        </p>
        <p className="truncate text-mini text-ink-500">
          {item.artist || '—'}
          {item.kind === 'stream' && ' · stream'}
        </p>
      </div>

      <button
        onClick={() => toggleLiked(item)}
        aria-label={liked ? 'Remove from liked' : 'Add to liked'}
        aria-pressed={liked}
        title={liked ? 'Remove from liked' : 'Add to liked'}
        className={clsx(
          'tap-target grid size-8 shrink-0 place-items-center rounded-ctl transition',
          liked ? 'text-red-400' : 'text-ink-500 hover:text-red-400',
        )}
      >
        <Heart className={clsx('size-4', liked && 'fill-current')} />
      </button>
    </li>
  )
}

function TrackRow({ track, onPlay }: { track: LibraryTrack; onPlay: () => void }) {
  const { current, playing } = useIsCurrent(`lib-${track.id}`)
  const [adding, setAdding] = useState(false)
  const queryClient = useQueryClient()
  const { push } = useToast()

  const remove = useMutation({
    mutationFn: () => deleteLibraryTrack(track.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['library-status'] })
      push('Removed from library', 'success')
    },
    onError: () => push('Delete failed', 'error'),
  })

  return (
    <li className="group relative flex items-center gap-3 rounded-btn border border-ink-800 bg-ink-900 px-3 py-2.5">
      <button
        onClick={onPlay}
        aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        className={clsx(
          'tap-target grid size-9 shrink-0 place-items-center rounded-ctl border transition active:scale-90',
          current
            ? 'border-lime-flash/50 bg-lime-flash/10 text-lime-flash'
            : 'border-ink-700 text-ink-300 hover:border-lime-flash/50 hover:text-lime-flash',
        )}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>

      {track.cover_url ? (
        <img src={track.cover_url} alt="" className="size-10 shrink-0 rounded-ctl object-cover" />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-ctl bg-ink-800">
          <Music2 className="size-4 text-ink-600" />
        </div>
      )}

      <div className="min-w-0 flex-1" dir="auto">
        <p
          className={clsx(
            'truncate text-sm font-medium',
            current ? 'text-lime-flash' : 'text-ink-100',
          )}
        >
          {track.title}
        </p>
        <p className="truncate text-mini text-ink-500">
          {track.artist || '—'} · {track.ext}
        </p>
      </div>

      <button
        onClick={() => setAdding(true)}
        aria-label="Add to playlist"
        title="Add to playlist"
        className="tap-target grid size-8 shrink-0 place-items-center rounded-ctl text-ink-500 transition hover:text-lime-flash"
      >
        <Plus className="size-4" />
      </button>
      <button
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
        aria-label="Remove from library"
        title="Remove from library"
        className="tap-target grid size-8 shrink-0 place-items-center rounded-ctl text-ink-500 transition hover:text-danger"
      >
        <Trash2 className="size-4" />
      </button>

      {adding && <AddToPlaylist trackId={track.id} onClose={() => setAdding(false)} />}
    </li>
  )
}

/** A small sheet listing playlists to add a track to, with an inline "new". */
function AddToPlaylist({ trackId, onClose }: { trackId: number; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { push } = useToast()
  const [newName, setNewName] = useState('')
  const { data: playlists } = useQuery({ queryKey: ['playlists'], queryFn: getPlaylists })

  const add = useMutation({
    mutationFn: (playlistId: number) => addToPlaylist(playlistId, trackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      push('Added to playlist', 'success')
      onClose()
    },
    onError: () => push('Could not add', 'error'),
  })

  const createAndAdd = useMutation({
    mutationFn: async () => {
      const pl = await createPlaylist(newName.trim())
      await addToPlaylist(pl.id, trackId)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['library-status'] })
      push('Playlist created and track added', 'success')
      onClose()
    },
    onError: () => push('Could not create', 'error'),
  })

  return (
    <>
      {/* Click-away scrim; stops the row underneath from also reacting. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-transparent"
      />
      <div className="absolute end-2 top-full z-50 mt-1 w-60 animate-fade-up rounded-panel border border-ink-700 bg-ink-900 p-2 shadow-2xl shadow-black/60">
        <p className="px-2 py-1 text-micro font-semibold text-ink-400">Add to playlist</p>
        <ul className="max-h-48 overflow-y-auto">
          {(playlists ?? []).map((pl) => (
            <li key={pl.id}>
              <button
                onClick={() => add.mutate(pl.id)}
                className="flex w-full items-center gap-2 rounded-btn px-2 py-2 text-start text-sm text-ink-100 transition hover:bg-ink-800"
              >
                <ListMusic className="size-3.5 shrink-0 text-ink-500" />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {pl.name}
                </span>
                <span className="shrink-0 text-mini text-ink-600">{pl.track_count}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-1 flex items-center gap-1.5 border-t border-ink-800 pt-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && createAndAdd.mutate()}
            placeholder="New playlist…"
            dir="auto"
            className="min-w-0 flex-1 rounded-btn border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-lime-flash/50"
          />
          <button
            onClick={() => newName.trim() && createAndAdd.mutate()}
            disabled={!newName.trim() || createAndAdd.isPending}
            aria-label="Create and add"
            className="tap-target grid size-8 shrink-0 place-items-center rounded-btn bg-lime-flash text-lime-ink transition active:scale-90 disabled:opacity-40"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>
    </>
  )
}

function PlaylistsTab({ onOpen }: { onOpen: (id: number) => void }) {
  const queryClient = useQueryClient()
  const { push } = useToast()
  const [newName, setNewName] = useState('')
  const { data: playlists, isPending } = useQuery({
    queryKey: ['playlists'],
    queryFn: getPlaylists,
  })

  const create = useMutation({
    mutationFn: () => createPlaylist(newName.trim()),
    onSuccess: () => {
      setNewName('')
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['library-status'] })
      push('Playlist created', 'success')
    },
    onError: () => push('Could not create', 'error'),
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && newName.trim() && create.mutate()}
          placeholder="New playlist name…"
          dir="auto"
          className="min-w-0 flex-1 rounded-btn border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-lime-flash/50"
        />
        <button
          onClick={() => newName.trim() && create.mutate()}
          disabled={!newName.trim() || create.isPending}
          className="tap-target flex shrink-0 items-center gap-1.5 rounded-btn bg-lime-flash px-3.5 py-2.5 text-mini font-semibold text-lime-ink transition active:scale-95 disabled:opacity-40"
        >
          <Plus className="size-4" />
          Create
        </button>
      </div>

      {isPending ? (
        <Muted>Loading…</Muted>
      ) : !playlists || playlists.length === 0 ? (
        <Muted>No playlists yet. Create one, then add tracks to it from your library.</Muted>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {playlists.map((pl) => (
            <li key={pl.id}>
              <button
                onClick={() => onOpen(pl.id)}
                className="group flex w-full items-center gap-3 rounded-btn border border-ink-800 bg-ink-900 px-3 py-3 text-start transition hover:border-ink-600"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-ctl bg-ink-800">
                  <ListMusic className="size-4 text-ink-500" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-100" dir="auto">
                    {pl.name}
                  </span>
                  <span className="block text-mini text-ink-500">{pl.track_count} tracks</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-ink-600 transition group-hover:translate-x-0.5 group-hover:text-ink-300" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlaylistDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const queryClient = useQueryClient()
  const { push } = useToast()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const { data: playlist, isPending } = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => getPlaylist(id),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['playlist', id] })
    queryClient.invalidateQueries({ queryKey: ['playlists'] })
  }

  const rename = useMutation({
    mutationFn: () => renamePlaylist(id, name.trim()),
    onSuccess: () => {
      setRenaming(false)
      invalidate()
      push('Renamed', 'success')
    },
    onError: () => push('Rename failed', 'error'),
  })

  const destroy = useMutation({
    mutationFn: () => deletePlaylist(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      queryClient.invalidateQueries({ queryKey: ['library-status'] })
      push('Playlist deleted', 'success')
      onBack()
    },
    onError: () => push('Could not remove', 'error'),
  })

  const removeTrack = useMutation({
    mutationFn: (trackId: number) => removeFromPlaylist(id, trackId),
    onSuccess: invalidate,
    onError: () => push('Could not remove', 'error'),
  })

  if (isPending) return <Muted>Loading…</Muted>
  if (!playlist) return <Muted>Playlist not found.</Muted>

  const items = playlist.tracks.map(toItem)

  return (
    <section className="animate-fade-up">
      <button
        onClick={onBack}
        className="group mb-3 flex items-center gap-1.5 rounded-ctl px-2 py-1.5 text-mini font-medium text-ink-300 transition hover:bg-ink-800 hover:text-ink-100"
      >
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        Back to playlists
      </button>

      <div className="mb-4 flex items-center gap-3">
        {renaming ? (
          <div className="flex flex-1 items-center gap-1.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && rename.mutate()}
              dir="auto"
              className="min-w-0 flex-1 rounded-btn border border-ink-700 bg-ink-950 px-3 py-2 text-lg font-bold text-ink-100 outline-none focus:border-lime-flash/50"
            />
            <button
              onClick={() => name.trim() && rename.mutate()}
              aria-label="Save"
              className="tap-target grid size-9 place-items-center rounded-ctl bg-lime-flash text-lime-ink active:scale-90"
            >
              <Check className="size-4" />
            </button>
            <button
              onClick={() => setRenaming(false)}
              aria-label="Cancel"
              className="tap-target grid size-9 place-items-center rounded-ctl text-ink-400 hover:text-ink-100"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <>
            <h1 className="min-w-0 flex-1 truncate font-display text-2xl font-bold" dir="auto">
              {playlist.name}
            </h1>
            <button
              onClick={() => {
                setName(playlist.name)
                setRenaming(true)
              }}
              aria-label="Rename"
              title="Rename"
              className="tap-target grid size-9 place-items-center rounded-ctl text-ink-500 transition hover:text-ink-100"
            >
              <Pencil className="size-4" />
            </button>
            <button
              onClick={() => destroy.mutate()}
              aria-label="Delete playlist"
              title="Delete playlist"
              className="tap-target grid size-9 place-items-center rounded-ctl text-ink-500 transition hover:text-danger"
            >
              <Trash2 className="size-4" />
            </button>
          </>
        )}
      </div>

      {items.length > 0 && (
        <button
          onClick={() => playQueue(items, 0)}
          className="mb-4 flex items-center gap-2 rounded-btn bg-lime-flash px-4 py-2.5 text-mini font-semibold text-lime-ink transition active:scale-95"
        >
          <Play className="size-4 translate-x-px" />
          Play all
        </button>
      )}

      {playlist.tracks.length === 0 ? (
        <Muted>This playlist is empty. Add tracks to it from your library.</Muted>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {playlist.tracks.map((track, index) => (
            <PlaylistRow
              key={track.id}
              track={track}
              onPlay={() => playQueue(items, index)}
              onRemove={() => removeTrack.mutate(track.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function PlaylistRow({
  track,
  onPlay,
  onRemove,
}: {
  track: LibraryTrack
  onPlay: () => void
  onRemove: () => void
}) {
  const { current, playing } = useIsCurrent(`lib-${track.id}`)
  return (
    <li className="flex items-center gap-3 rounded-btn border border-ink-800 bg-ink-900 px-3 py-2.5">
      <button
        onClick={onPlay}
        aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        className={clsx(
          'tap-target grid size-9 shrink-0 place-items-center rounded-ctl border transition active:scale-90',
          current
            ? 'border-lime-flash/50 bg-lime-flash/10 text-lime-flash'
            : 'border-ink-700 text-ink-300 hover:border-lime-flash/50 hover:text-lime-flash',
        )}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>
      <div className="min-w-0 flex-1" dir="auto">
        <p
          className={clsx(
            'truncate text-sm font-medium',
            current ? 'text-lime-flash' : 'text-ink-100',
          )}
        >
          {track.title}
        </p>
        <p className="truncate text-mini text-ink-500">{track.artist || '—'}</p>
      </div>
      <button
        onClick={onRemove}
        aria-label="Remove from playlist"
        title="Remove from playlist"
        className="tap-target grid size-8 shrink-0 place-items-center rounded-ctl text-ink-500 transition hover:text-danger"
      >
        <X className="size-4" />
      </button>
    </li>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-panel border border-ink-800 bg-ink-900/50 px-4 py-8 text-center text-mini text-ink-500">
      {children}
    </p>
  )
}
