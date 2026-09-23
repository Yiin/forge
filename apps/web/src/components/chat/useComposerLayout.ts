import { useCallback, useLayoutEffect, useRef, useState } from 'react'

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

/**
 * Compact/expanded layout for the composer pill, with zeron's flip rules:
 * any newline or overflow expands at once; collapsing needs 32px of slack,
 * and waits for the width to settle while the pane is being resized.
 * The hero (new-thread) composer is always expanded.
 */
export function useComposerLayout(text: string, hero: boolean) {
  const pill = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpandedState] = useState(true)
  const expandedRef = useRef(true)
  const textRef = useRef(text)
  const heroRef = useRef(hero)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const canvas = useRef<CanvasRenderingContext2D | null | undefined>(undefined)
  textRef.current = text
  heroRef.current = hero

  const setExpanded = useCallback((next: boolean) => {
    expandedRef.current = next
    setExpandedState(next)
  }, [])

  const updateFade = useCallback(() => {
    const input = textarea.current
    if (!input) return
    const band = `${COMPOSER_LAYOUT.fadeBand}px`
    const top = input.scrollTop > 0
    const bottom = input.scrollTop + input.clientHeight < input.scrollHeight - 1
    input.style.setProperty('--fade-top', top ? band : '0px')
    input.style.setProperty('--fade-bottom', bottom ? band : '0px')
  }, [])

  const sizeInput = useCallback(
    (isExpanded: boolean) => {
      const input = textarea.current
      if (!input) return
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
      const coarse =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches
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

  useLayoutEffect(() => {
    const root = pill.current
    const input = textarea.current
    if (!root || !input) return
    const onResize = () => measure('resize')
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(onResize)
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

  return { pill, chip, textarea, mirror, expanded }
}
