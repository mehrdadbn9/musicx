import { useState, useEffect } from 'react'

export interface LyricsResult {
  text: string
  synced: boolean
  loading: boolean
  error: string | null
}

/** Fetch lyrics for a track. Uses the backend /api/lyrics endpoint. */
export async function fetchLyrics(title: string, artist: string): Promise<{ text: string; synced: boolean }> {
  const params = new URLSearchParams({ title, artist })
  const res = await fetch(`/api/lyrics?${params.toString()}`)
  if (!res.ok) throw new Error('Lyrics not found')
  return res.json()
}

/** React hook for lyrics with loading/error states. */
export function useLyrics(title: string, artist: string): LyricsResult {
  const [result, setResult] = useState<LyricsResult>({
    text: '',
    synced: false,
    loading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    if (!title || !artist) {
      setResult({ text: '', synced: false, loading: false, error: 'No track info' })
      return
    }
    setResult({ text: '', synced: false, loading: true, error: null })
    fetchLyrics(title, artist)
      .then((data) => {
        if (!cancelled) setResult({ text: data.text, synced: data.synced, loading: false, error: null })
      })
      .catch((err) => {
        if (!cancelled) setResult({ text: '', synced: false, loading: false, error: err.message })
      })
    return () => { cancelled = true }
  }, [title, artist])

  return result
}