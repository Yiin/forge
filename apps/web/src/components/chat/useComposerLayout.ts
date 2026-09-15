import { useLayoutEffect, useRef, useState } from 'react'

/** Comet composer.rs: compact input floor, collapse slack, and resize settle. */
export function useComposerLayout(text: string, forceExpanded: boolean) {
  const form = useRef<HTMLFormElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const send = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(true)

  useLayoutEffect(() => {
    const root = form.current
    const input = textarea.current
    const choices = controls.current
    const actions = send.current
    if (!root || !input || !choices || !actions) return
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const pointer = window.matchMedia('(pointer: coarse)')
    let collapse: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      clearTimeout(collapse)
      input.style.height = 'auto'
      input.style.height = `${expanded ? Math.min(260, Math.max(76, input.scrollHeight)) : 47}px`
      const style = getComputedStyle(input)
      if (context) context.font = style.font
      const textWidth = context?.measureText(text).width ?? input.scrollWidth
      const choiceStyle = getComputedStyle(choices)
      const children = [...choices.children].filter(
        (child) => getComputedStyle(child).display !== 'none',
      )
      const choicesWidth = children.reduce(
        (width, child) => {
          const css = getComputedStyle(child)
          return (
            width +
            child.getBoundingClientRect().width +
            (parseFloat(css.marginLeft) || 0) +
            (parseFloat(css.marginRight) || 0)
          )
        },
        Math.max(0, children.length - 1) *
          (parseFloat(choiceStyle.columnGap) || 0),
      )
      // Pill border, input inset, actions inset, and gap between input/actions.
      const capacity =
        root.clientWidth - choicesWidth - actions.offsetWidth - 46
      if (
        forceExpanded ||
        pointer.matches ||
        text.includes('\n') ||
        capacity < 200 ||
        textWidth > capacity
      ) {
        setExpanded(true)
      } else if (textWidth <= capacity - 32) {
        collapse = setTimeout(() => setExpanded(false), 150)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(choices)
    observer.observe(actions)
    const mutation = new MutationObserver(measure)
    mutation.observe(choices, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    pointer.addEventListener('change', measure)
    measure()
    return () => {
      clearTimeout(collapse)
      observer.disconnect()
      mutation.disconnect()
      pointer.removeEventListener('change', measure)
    }
  }, [text, forceExpanded, expanded])

  return { form, controls, send, textarea, expanded }
}
