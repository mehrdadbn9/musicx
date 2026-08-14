import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowRight, LoaderCircle, Search } from 'lucide-react'
import clsx from 'clsx'
import { isCatalogUrl } from '../lib/api'

interface Props {
  loading: boolean
  onSubmit: (input: string) => void
  className?: string
  inputRef?: RefObject<HTMLInputElement | null>
  /** Bumped by the parent each time a keyboard shortcut focuses this form —
   *  the value is meaningless, the change is the signal. */
  focusPulse?: number
}

/** The landing search bar, 2026 edition: a gradient ring around a glass core,
 *  with the signature gradient on both the icon tile and the action. It is
 *  the hero control, so it gets the strongest light in the room — the ring
 *  brightens to full brand colours and throws a halo while focused. */
export function UrlForm({ loading, onSubmit, className, inputRef, focusPulse = 0 }: Props) {
  const [input, setInput] = useState('')
  const isUrl = isCatalogUrl(input)

  // Focus on arrival is a desktop courtesy and a mobile ambush — on a phone it
  // summons the keyboard over the hero. `autoFocus` has no way to ask, so it's
  // done here instead.
  const ownInputRef = useRef<HTMLInputElement | null>(null)
  const inputEl = inputRef ?? ownInputRef
  useEffect(() => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      inputEl.current?.focus()
    }
    // Mount-only: later focus goes through `focusPulse` and the / shortcut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [pulsing, setPulsing] = useState(false)
  useEffect(() => {
    if (focusPulse === 0) return
    setPulsing(true)
    const timer = setTimeout(() => setPulsing(false), 600)
    return () => clearTimeout(timer)
  }, [focusPulse])

  return (
    <form
      className={clsx('group relative', className)}
      onSubmit={(e) => {
        e.preventDefault()
        if (input.trim() && !loading) onSubmit(input.trim())
      }}
    >
      {/* The pulse gets its own element: `animate-*` sets the `animation`
          shorthand, so sharing a node with the caller's entrance animation
          would clobber it — and replay it once the pulse finished. */}
      {pulsing && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-1 animate-focus-pulse rounded-[1.8rem]"
        />
      )}
      {/* Gradient ring: a 1px brand gradient that reads dim at rest and snaps
          to full colour on focus. The inner core carries the glass. */}
      <div className="search-bar-ring relative rounded-[1.8rem] p-px">
        <div className="search-bar-inner relative flex items-center gap-2.5 rounded-[calc(1.8rem-1px)] py-2 pe-2 ps-2 sm:gap-3 sm:ps-2.5">
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-[1.1rem] accent-gradient shadow-lg shadow-indigo-950/40 transition-transform duration-300 group-focus-within:scale-105"
          >
            <Search className="size-5 text-white" />
          </span>
          <input
            ref={inputEl}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            dir="auto"
            placeholder="Search any song, album or artist — or paste a link"
            spellCheck={false}
            // `dir="auto"` shapes a Latin query left-to-right (or "fadaei"
            // comes out reversed) but also flips where the line starts,
            // dragging it to the far side of an RTL form. `text-left` keeps
            // the alignment.
            className="min-w-0 flex-1 bg-transparent py-3 text-body text-ink-100 placeholder:text-ink-600 focus:outline-none sm:text-lg"
          />
          {/* The shortcut is a discovery aid, not a control — decorative on
              small screens where the keyboard is already up. */}
          <kbd
            aria-hidden
            className="hidden shrink-0 rounded-md border border-ink-700/80 bg-ink-800/80 px-2 py-1 font-sans text-micro text-ink-400 sm:block"
          >
            /
          </kbd>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className={clsx(
              'flex shrink-0 items-center gap-1.5 rounded-full px-5 py-3 font-semibold text-white',
              'text-mini sm:px-6 sm:py-3.5 sm:text-sm',
              'accent-gradient shadow-[0_8px_24px_-8px_rgba(192,38,211,0.6)]',
              'transition duration-200 hover:brightness-110 active:scale-[0.97]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {loading ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {isUrl ? 'Opening…' : 'Searching…'}
              </>
            ) : (
              <>
                {isUrl ? 'Open' : 'Search'}
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  )
}
