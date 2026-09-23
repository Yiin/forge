import type { RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { VirtualizerHandle } from 'virtua'
import {
  activePrompt,
  easeInOut,
  GLIDE_MS,
  previewText,
  PROMPT_PREVIEW_CHARS,
  railBuckets,
  railCapacity,
  READING_LINE_PX,
  REPLY_PREVIEW_CHARS,
  showRail,
  type RailPrompt,
} from './prompt-rail'
import { cn } from '../../lib/utils'

/**
 * zeron's prompt rail: one short tick per prompt at the transcript's left
 * edge, at most 12, bucketed when there are more. The tick for the prompt
 * being read is lit. Hover or focus previews a prompt; a click glides it to
 * the top of the view.
 */
export function PromptRail({
  scroller,
  handle,
  prompts,
  onNavigate,
}: {
  scroller: HTMLDivElement | null
  handle: RefObject<VirtualizerHandle | null>
  prompts: RailPrompt[]
  /** Called before a jump, so the transcript stops following the bottom. */
  onNavigate: () => void
}) {
  const [size, setSize] = useState({ width: 0, height: 600 })
  const [active, setActive] = useState(0)
  const [preview, setPreview] = useState<number>()
  const glide = useRef<{ cancel: () => void }>(undefined)
  const promptsRef = useRef(prompts)
  promptsRef.current = prompts

  useEffect(() => {
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() =>
      setSize({ width: scroller.clientWidth, height: scroller.clientHeight }),
    )
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  const visible = showRail(size.width, prompts.length)

  useEffect(() => {
    if (!scroller || !visible) return
    let frame = 0
    const update = () => {
      frame = 0
      const list = handle.current
      if (!list) return
      const offsets = promptsRef.current.map((prompt) =>
        list.getItemOffset(prompt.index),
      )
      setActive(activePrompt(offsets, scroller.scrollTop + READING_LINE_PX))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', schedule)
      cancelAnimationFrame(frame)
    }
  }, [scroller, handle, visible, prompts.length])

  useEffect(() => () => glide.current?.cancel(), [])

  if (!visible || !scroller) return null

  const buckets = railBuckets(prompts.length, railCapacity(size.height))
  const representative = (bucket: { start: number; end: number }) =>
    active >= bucket.start && active < bucket.end ? active : bucket.start

  const jump = (promptIndex: number) => {
    const list = handle.current
    const prompt = prompts[promptIndex]
    if (!list || !prompt) return
    onNavigate()
    glide.current?.cancel()
    const target = () =>
      Math.min(
        list.getItemOffset(prompt.index),
        scroller.scrollHeight - scroller.clientHeight,
      )
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      scroller.scrollTop = target()
      return
    }
    glide.current = glideScroll(scroller, target)
  }

  return (
    <nav
      aria-label="Prompts"
      className="pointer-events-none absolute inset-y-0 left-4 z-20 flex w-[26px] flex-col items-start justify-center gap-[3px]"
    >
      {buckets.map((bucket, bucketIndex) => {
        const promptIndex = representative(bucket)
        const prompt = prompts[promptIndex]
        const lit = active >= bucket.start && active < bucket.end
        const hovered = preview === bucketIndex
        const count = bucket.end - bucket.start
        return (
          <div key={bucket.start} className="relative h-[10px] w-full">
            <button
              type="button"
              aria-label={`Prompt ${promptIndex + 1}: ${previewText(prompt.text, 80)}`}
              aria-current={lit ? 'location' : undefined}
              className="group/tick pointer-events-auto flex h-full w-full cursor-pointer items-center rounded-[2px] focus-visible:outline-none active:!scale-100"
              onPointerEnter={() => setPreview(bucketIndex)}
              onPointerLeave={() => setPreview(undefined)}
              onFocus={() => setPreview(bucketIndex)}
              onBlur={() => setPreview(undefined)}
              onClick={() => jump(promptIndex)}
            >
              <span
                className={cn(
                  'h-[2px] rounded-[1px] transition-[width,background-color] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-ring/70',
                  hovered ? 'w-5' : 'w-3',
                  lit || hovered ? 'bg-foreground/80' : 'bg-ink/16',
                )}
              />
            </button>
            {hovered && (
              <div
                className="pointer-events-none absolute top-1/2 left-[26px] z-30 flex w-[280px] -translate-y-1/2 flex-col gap-1.5 overflow-hidden rounded-[12px] border border-border bg-popover/85 p-2 shadow-lg backdrop-blur-[16px]"
                aria-hidden
              >
                <p className="text-xs leading-4 break-words text-foreground">
                  {previewText(prompt.text, PROMPT_PREVIEW_CHARS) ||
                    'Attached files'}
                </p>
                {prompt.reply && (
                  <p className="text-[11px] leading-[14px] break-words text-muted-foreground">
                    {previewText(prompt.reply, REPLY_PREVIEW_CHARS)}
                  </p>
                )}
                {count > 1 && (
                  <p className="text-[10px] leading-3 text-muted-foreground">
                    {count} prompts
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

/**
 * A fixed 500ms ease-in-out glide of `scrollTop`. The target is read every
 * frame, because rows measured mid-flight move it. User input cancels it.
 */
function glideScroll(scroller: HTMLElement, target: () => number) {
  const from = scroller.scrollTop
  const started = performance.now()
  let frame = 0
  const cancel = () => {
    cancelAnimationFrame(frame)
    scroller.removeEventListener('wheel', cancel)
    scroller.removeEventListener('touchstart', cancel)
  }
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / GLIDE_MS)
    scroller.scrollTop = from + (target() - from) * easeInOut(progress)
    if (progress < 1) frame = requestAnimationFrame(step)
    else cancel()
  }
  scroller.addEventListener('wheel', cancel, { passive: true })
  scroller.addEventListener('touchstart', cancel, { passive: true })
  frame = requestAnimationFrame(step)
  return { cancel }
}
