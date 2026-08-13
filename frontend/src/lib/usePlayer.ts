import { useSyncExternalStore } from 'react'
import { snapshot, subscribe } from './player'

/** The player store as React state. Split from player.ts so the store stays
 *  importable from non-component code (and testable without React). */
export function usePlayer() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** What the row needs: is this specific track the one playing right now. */
export function useIsCurrent(trackId: string): { current: boolean; playing: boolean } {
  const state = usePlayer()
  const item = state.queue[state.index]
  const current = item?.id === trackId
  return { current, playing: current && state.playing }
}
