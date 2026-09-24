import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { ROUTE_SNAP_MS } from './composer-motion'
import { PillMotion } from './pill-motion'

/** zeron composer.rs sizes, in CSS px. */
export const COMPOSER_LAYOUT = {
  compactInput: 47,
  heroFloor: 76,
  threadFloor: 60,
  maxInput: 260,
  minCompactInputWidth: 200,
  collapseHysteresis: 32,
  resizeSettleMs: 150,
  fadeBand: 12,
  /** attach inset + button, then send inset + button + inset (compact row). */
  compactChrome: 8 + 28 + 8 + 28 + 8,
  /** Horizontal padding of the input in compact mode. */
  compactInputPadding: 16,
} as const

const coarsePointer = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches

/**
 * Compact/expanded layout for the composer pill, with zeron's flip rules:
 * any newline or overflow expands at once; collapsing needs 32px of slack,
 * and waits for the width to settle while the pane is being resized.
 * The hero (new-thread) composer is always expanded. A flip morphs the pill
 * (see pill-motion.ts) unless it lands right after a route change.
 */
export function useComposerLayout(
  text: string,
  hero: boolean,
  /** A change of session counts as a navigation: flips snap for a moment. */
  routeKey: string,
) {
  const root = useRef<HTMLFormElement>(null)
  const pill = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const attach = useRef<HTMLLabelElement>(null)
  const chip = useRef<HTMLDivElement>(null)
  const send = useRef<HTMLButtonElement>(null)
  const footer = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLTextAreaElement>(null)
  const [initialExpanded] = useState(
    () => hero || text.includes('\n') || coarsePointer(),
  )
  const [expanded, setExpandedState] = useState(initialExpanded)
  const expandedRef = useRef(initialExpanded)
  const [motion] = useState(
    () =>
      new PillMotion(() => {
        const parts = {
          root: root.current,
          pill: pill.current,
          content: content.current,
          attach: attach.current,
          textarea: textarea.current,
          chip: chip.current,
          send: send.current,
          footer: footer.current,
        }
        return Object.values(parts).every(Boolean)
          ? (parts as {
              [key in keyof typeof parts]: NonNullable<(typeof parts)[key]>
            })
          : undefined
      }),
  )
  const routeChangedAt = useRef(0)
  useLayoutEffect(() => {
    routeChangedAt.current = performance.now()
  }, [routeKey])
  useLayoutEffect(() => () => motion.dispose(), [motion])
  const textRef = useRef(text)
  const heroRef = useRef(hero)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const canvas = useRef<CanvasRenderingContext2D | null | undefined>(undefined)
  textRef.current = text
  heroRef.current = hero

  const setExpanded = useCallback(
    (next: boolean) => {
      motion.beforeFlip()
      expandedRef.current = next
      setExpandedState(next)
    },
    [motion],
  )

  const updateFade = useCallback(() => {
    const input = textarea.current
    if (!input) return
    const band = `${COMPOSER_LAYOUT.fadeBand}px`
    const top = input.scrollTop > 0
    const bottom = input.scrollTop + input.clientHeight < input.scrollHeight - 1
    input.style.setProperty('--fade-top', top ? band : '0px')
    input.style.setProperty('--fade-bottom', bottom ? band : '0px')
  }, [])

  const sizedExpanded = useRef<boolean | undefined>(undefined)
  const sizeInput = useCallback(
    (isExpanded: boolean) => {
      const input = textarea.current
      if (!input) return
      // A flip sizes the input at once; the pill morph carries the motion.
      // Only growth within one layout eases the input's own height.
      const flipped = sizedExpanded.current !== isExpanded
      sizedExpanded.current = isExpanded
      if (flipped) input.style.transition = 'none'
      if (!isExpanded) {
        input.style.height = `${COMPOSER_LAYOUT.compactInput}px`
      } else {
        const probe = mirror.current
        if (probe) probe.value = textRef.current
        const content = probe?.scrollHeight ?? input.scrollHeight
        const floor = heroRef.current
          ? COMPOSER_LAYOUT.heroFloor
          : COMPOSER_LAYOUT.threadFloor
        input.style.height = `${Math.min(COMPOSER_LAYOUT.maxInput, Math.max(floor, content))}px`
      }
      if (flipped) {
        void input.offsetHeight
        input.style.transition = ''
      }
      updateFade()
    },
    [updateFade],
  )

  const measure = useCallback(
    (reason: 'text' | 'resize') => {
      const root = pill.current
      const input = textarea.current
      if (!root || !input) return
      const value = textRef.current
      const coarse = coarsePointer()
      if (canvas.current === undefined)
        canvas.current = document.createElement('canvas').getContext('2d')
      const context = canvas.current
      if (context) context.font = getComputedStyle(input).font
      const textWidth = context?.measureText(value).width ?? 0
      const chipWidth = chip.current?.offsetWidth ?? 0
      const compactInputWidth =
        root.clientWidth - COMPOSER_LAYOUT.compactChrome - chipWidth
      const capacity =
        compactInputWidth - COMPOSER_LAYOUT.compactInputPadding - 8
      const mustExpand =
        heroRef.current ||
        coarse ||
        value.includes('\n') ||
        compactInputWidth < COMPOSER_LAYOUT.minCompactInputWidth ||
        textWidth > capacity
      clearTimeout(collapseTimer.current)
      if (mustExpand) {
        if (!expandedRef.current) setExpanded(true)
      } else if (
        expandedRef.current &&
        textWidth < capacity - COMPOSER_LAYOUT.collapseHysteresis
      ) {
        if (reason === 'text') setExpanded(false)
        else
          collapseTimer.current = setTimeout(
            () => measure('text'),
            COMPOSER_LAYOUT.resizeSettleMs,
          )
      }
      sizeInput(expandedRef.current)
    },
    [setExpanded, sizeInput],
  )

  useLayoutEffect(() => {
    measure('text')
  }, [text, hero, expanded, measure])

  // After the measure above has sized the input for the new layout.
  const committed = useRef(initialExpanded)
  useLayoutEffect(() => {
    if (committed.current === expanded) return
    committed.current = expanded
    motion.afterFlip(
      expanded,
      performance.now() - routeChangedAt.current < ROUTE_SNAP_MS,
    )
  }, [expanded, motion])

  useLayoutEffect(() => {
    const root = pill.current
    const input = textarea.current
    if (!root || !input) return
    const onResize = () => measure('resize')
    // The pill's height changes every frame of a morph; only its width and
    // the chip's size move the layout.
    let width = root.clientWidth
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver((entries) => {
            const widened = root.clientWidth !== width
            width = root.clientWidth
            if (widened || entries.some((entry) => entry.target !== root))
              onResize()
          })
    observer?.observe(root)
    if (chip.current) observer?.observe(chip.current)
    input.addEventListener('scroll', updateFade)
    const pointer =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)')
        : undefined
    pointer?.addEventListener?.('change', onResize)
    return () => {
      clearTimeout(collapseTimer.current)
      observer?.disconnect()
      input.removeEventListener('scroll', updateFade)
      pointer?.removeEventListener?.('change', onResize)
    }
  }, [measure, updateFade])

  return {
    root,
    pill,
    content,
    attach,
    chip,
    send,
    footer,
    textarea,
    mirror,
    expanded,
    motion,
  }
}
