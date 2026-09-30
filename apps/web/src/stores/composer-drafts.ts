import { create } from 'zustand'
import {
  initialAttachmentUploads,
  type AttachmentUploads,
} from '../components/composer/attachmentUploads'

// Unsent composer input, keyed by session or draft id. The composer unmounts
// whenever the user leaves the session (settings, another session), so its
// text and attachments live here instead of in component state. Uploads keep
// their File objects, which cannot be serialized, so only text reaches
// localStorage and survives a reload.
type ComposerDraft = { text: string; uploads: AttachmentUploads }
type ComposerDraftsState = {
  entries: Record<string, ComposerDraft>
  setText: (key: string, text: string) => void
  updateUploads: (
    key: string,
    update: (uploads: AttachmentUploads) => AttachmentUploads,
  ) => void
}

const STORAGE_KEY = 'forge.composer-text.v1'
let writeTimer: ReturnType<typeof setTimeout> | undefined

function readText(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) return {}
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}',
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(([, text]) => typeof text === 'string'),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

function writeText(entries: Record<string, ComposerDraft>) {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    const texts = Object.fromEntries(
      Object.entries(entries)
        .filter(([, entry]) => entry.text)
        .map(([key, entry]) => [key, entry.text]),
    )
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(texts))
    writeTimer = undefined
  }, 150)
}

export const useComposerDraftsStore = create<ComposerDraftsState>((set) => ({
  entries: Object.fromEntries(
    Object.entries(readText()).map(([key, text]) => [
      key,
      { text, uploads: initialAttachmentUploads },
    ]),
  ),
  setText: (key, text) =>
    set((state) => {
      const entries = {
        ...state.entries,
        [key]: {
          uploads: state.entries[key]?.uploads ?? initialAttachmentUploads,
          text,
        },
      }
      writeText(entries)
      return { entries }
    }),
  updateUploads: (key, update) =>
    set((state) => {
      const current = state.entries[key]
      return {
        entries: {
          ...state.entries,
          [key]: {
            text: current?.text ?? '',
            uploads: update(current?.uploads ?? initialAttachmentUploads),
          },
        },
      }
    }),
}))
