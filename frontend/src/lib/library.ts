import axios from 'axios'

const client = axios.create({ baseURL: '/api' })

/** One downloaded file, as the library knows it. Distinct from a catalog
 *  Track: it has a numeric library id and an on-disk file, no provider. */
export interface LibraryTrack {
  id: number
  title: string
  artist: string
  album: string
  ext: string
  size: number
  duration_ms: number
  cover_url: string | null
  added_at: number
}

export interface PlaylistSummary {
  id: number
  name: string
  track_count: number
}

export interface Playlist {
  id: number
  name: string
  track_count: number
  tracks: LibraryTrack[]
}

export interface LibraryStatus {
  available: boolean
  tracks: number
  playlists: number
}

/** The URL an <audio> element plays a library track from — full length, off
 *  disk, and Range-seekable (the backend serves it as a FileResponse). */
export const libraryStreamUrl = (id: number) => `/api/library/${id}/stream`

export async function getLibraryStatus(): Promise<LibraryStatus> {
  try {
    const { data } = await client.get<LibraryStatus>('/library/status')
    return data
  } catch {
    return { available: false, tracks: 0, playlists: 0 }
  }
}

export async function getLibrary(): Promise<LibraryTrack[]> {
  const { data } = await client.get<{ tracks: LibraryTrack[] }>('/library')
  return data.tracks
}

export async function deleteLibraryTrack(id: number): Promise<void> {
  await client.delete(`/library/${id}`)
}

export async function getPlaylists(): Promise<PlaylistSummary[]> {
  const { data } = await client.get<{ playlists: PlaylistSummary[] }>('/playlists')
  return data.playlists
}

export async function getPlaylist(id: number): Promise<Playlist> {
  const { data } = await client.get<Playlist>(`/playlists/${id}`)
  return data
}

export async function createPlaylist(name: string): Promise<Playlist> {
  const { data } = await client.post<Playlist>('/playlists', { name })
  return data
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  await client.patch(`/playlists/${id}`, { name })
}

export async function deletePlaylist(id: number): Promise<void> {
  await client.delete(`/playlists/${id}`)
}

export async function addToPlaylist(playlistId: number, trackId: number): Promise<void> {
  await client.post(`/playlists/${playlistId}/tracks`, { track_id: trackId })
}

export async function removeFromPlaylist(playlistId: number, trackId: number): Promise<void> {
  await client.delete(`/playlists/${playlistId}/tracks/${trackId}`)
}
