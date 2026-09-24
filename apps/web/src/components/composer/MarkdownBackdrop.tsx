import { useLayoutEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { cn } from '@/lib/utils'
import { parseDraft, type Mark, type Mentions } from '../chat/composer-markdown'
import { EDGE_FADE_CLASS } from './useEdgeFade'

const MARK_CLASS: Partial<Record<Mark, string>> = {
  // Weight would change glyph widths and pull the text away from the caret,
  // so bold is a hairline stroke over the same glyphs.
  strong: 'composer-md-strong',
  heading: 'composer-md-strong',
  em: 'italic',
  strike: 'line-through decoration-1',
  code: 'rounded-[5px] bg-code-wash text-primary',
  mention: 'rounded-[5px] bg-code-wash text-primary',
  list: 'text-muted-foreground',
}

/**
 * The painted draft under the composer's textarea. The textarea keeps the
 * text, caret, selection, IME and undo, with its own glyphs transparent;
 * this layer draws the same text in the same box with zeron's live
 * Markdown (composer_markdown.rs): bold, italic, strike, code, fenced
 * blocks and mention chips. Every style keeps glyph widths, so the two
 * layers never drift. Delimiters stay in place, dim off the caret's line.
 */
export function MarkdownBackdrop({
  text,
  caret,
  mentions,
  textarea,
  className,
}: {
  text: string
  /** The caret's offset in the draft; its line shows the delimiters. */
  caret: number
  mentions: Mentions
  textarea: RefObject<HTMLTextAreaElement | null>
  /** The textarea's padding and type, so both lay out the same. */
  className?: string
}) {
  const layer = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => parseDraft(text, mentions), [text, mentions])

  // Follow the textarea's scroll and its scrollbar, which narrows the text.
  useLayoutEffect(() => {
    const input = textarea.current
    const node = layer.current
    if (!input || !node) return
    const sync = () => {
      node.style.right = `${input.offsetWidth - input.clientWidth}px`
      node.scrollTop = input.scrollTop
    }
    sync()
    input.addEventListener('scroll', sync, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(sync)
    observer?.observe(input)
    return () => {
      input.removeEventListener('scroll', sync)
      observer?.disconnect()
    }
  }, [textarea])
  useLayoutEffect(() => {
    const input = textarea.current
    if (input && layer.current) layer.current.scrollTop = input.scrollTop
  })

  return (
    <div
      ref={layer}
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 left-0 overflow-hidden break-words whitespace-pre-wrap text-foreground',
        EDGE_FADE_CLASS,
        className,
      )}
    >
      {lines.map((line) => {
        const active = caret >= line.start && caret <= line.end
        return (
          <div
            key={line.start}
            className={cn(line.fence && '-mx-1 bg-code-wash px-1')}
          >
            {line.segments.length === 0
              ? '​'
              : line.segments.map((segment) => (
                  <span
                    key={segment.start}
                    className={cn(
                      segment.marks.map((mark) => MARK_CLASS[mark]),
                      segment.marks.includes('delim') &&
                        (active
                          ? 'text-muted-foreground'
                          : 'text-faint-foreground/60'),
                    )}
                  >
                    {text.slice(segment.start, segment.end)}
                  </span>
                ))}
          </div>
        )
      })}
    </div>
  )
}
