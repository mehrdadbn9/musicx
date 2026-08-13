import clsx from 'clsx'
import { QUALITIES, QUALITY_HINT, QUALITY_LABEL } from '../lib/api'
import { useDownloads } from '../lib/downloads'

/** Segmented picker for the audio the backend asks ffmpeg for: an mp3 bitrate,
 *  or the upload's own stream untouched.
 *
 *  One global preference rather than a control on every download button —
 *  it applies to every job started after it changes, and is remembered
 *  across sessions. Jobs already running keep the quality they started at.
 *
 *  Restyled for the redesign: the active segment takes the signature
 *  gradient (the one primary accent this surface ever shows), the track is
 *  a glass capsule, and the type is Inter with real hit targets.
 */
export function QualityPicker({
  className,
  compact = false,
}: {
  className?: string
  compact?: boolean
}) {
  const { quality, setQuality } = useDownloads()

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      {!compact && (
        <span className="hidden text-micro font-semibold tracking-wide text-ink-400 uppercase sm:inline">
          Quality
        </span>
      )}
      <div
        role="radiogroup"
        aria-label="Audio quality"
        className={clsx(
          'glass flex items-center gap-1 rounded-btn p-1',
          compact && 'grid w-full grid-cols-2',
        )}
      >
        {QUALITIES.map((option) => {
          const active = option === quality
          return (
            <button
              key={option}
              role="radio"
              aria-checked={active}
              title={QUALITY_HINT[option]}
              onClick={() => setQuality(option)}
              className={clsx(
                // Segments sit shoulder to shoulder, so a taller strip is what
                // makes this thumb-usable — not a hit area per segment.
                'rounded-ctl px-2.5 py-1.5 text-mini font-semibold tabular-nums transition duration-200 active:scale-95 pointer-coarse:px-3 pointer-coarse:py-2',
                compact && 'w-full text-center',
                active
                  ? 'accent-gradient text-white shadow-[0_4px_12px_-4px_rgba(192,38,211,0.6)]'
                  : 'text-ink-400 hover:text-ink-100',
              )}
            >
              {QUALITY_LABEL[option]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
