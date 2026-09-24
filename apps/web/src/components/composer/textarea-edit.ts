import type { DraftEdit } from '../chat/composer-markdown'

/**
 * Apply a Markdown edit to the composer's textarea as if it were typed, so
 * it lands on the browser's undo stack and fires the usual input event.
 * `execCommand('insertText')` is the one path that keeps native undo;
 * where it is missing (jsdom), `setRangeText` plus an input event stands in.
 */
export function applyTextareaEdit(
  input: HTMLTextAreaElement,
  edit: DraftEdit & { selection?: [number, number] },
) {
  input.focus()
  input.setSelectionRange(edit.start, edit.end)
  const typed =
    typeof document.execCommand === 'function' &&
    (edit.text
      ? document.execCommand('insertText', false, edit.text)
      : edit.start === edit.end || document.execCommand('delete'))
  if (!typed) {
    input.setRangeText(edit.text, edit.start, edit.end, 'end')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const [start, end] = edit.selection ?? [edit.caret, edit.caret]
  input.setSelectionRange(start, end)
}
