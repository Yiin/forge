import { Paperclip, Send, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useMessagesStore } from '../../stores/messages'
import { CommandMenu, type ComposerCommand } from './CommandMenu'
import { detectComposerTrigger, replaceComposerTrigger, type ComposerTrigger } from './composer-triggers'

type Attachment = { id: string; name: string; size: number; progress: number; state: 'uploading' | 'complete' | 'failed' }
const commandDefaults: ComposerCommand[] = [
  { id: 'help', label: '/help', group: 'Built-in', value: '/help' },
  { id: 'clear', label: '/clear', group: 'Built-in', value: '/clear' },
]

export function Composer({ sessionId, harness, onSend, sending = false }: { sessionId: string; harness?: string; onSend: (text: string, attachmentIds: string[]) => Promise<void>; sending?: boolean }) {
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [commands, setCommands] = useState(commandDefaults)
  const [selectedHarness, setSelectedHarness] = useState(harness ?? '')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const volatile = useMessagesStore((state) => state.volatile)
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(140, Math.max(44, node.scrollHeight))}px`
  }, [text])
  useEffect(() => {
    const events = volatile.filter((event): event is Extract<typeof event, { type: 'availableCommands' }> => event.type === 'availableCommands' && event.sessionId === sessionId)
    const latest = events.at(-1)
    if (latest) setCommands([...commandDefaults, ...latest.commands.flatMap((value, index) => typeof value === 'string' ? [{ id: `h-${index}`, label: value, group: 'Harness' as const, value }] : [])])
  }, [volatile, sessionId])
  useEffect(() => {
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`).then((response) => response.ok ? response.json() : null).then((session: { projectId?: string } | null) => {
      if (!session?.projectId) return
      return fetch(`/api/projects/${encodeURIComponent(session.projectId)}/files`).then((response) => response.ok ? response.json() : []).then((files: Array<{ name: string; type: string }>) => setCommands((items) => [...items, ...files.filter((file) => file.type === 'file').map((file) => ({ id: `file-${file.name}`, label: `@${file.name}`, group: 'Files' as const, value: file.name }))]))
    }).catch(() => undefined)
  }, [sessionId])
  const [harnesses, setHarnesses] = useState<string[]>(harness ? [harness] : [])
  useEffect(() => { void fetch('/api/status').then((response) => response.ok ? response.json() : null).then((status: { harnesses?: Array<{ key: string }> } | null) => { if (status?.harnesses) setHarnesses(status.harnesses.map((item) => item.key)) }).catch(() => undefined) }, [])
  const update = (value: string, cursor = textarea.current?.selectionStart ?? value.length) => {
    setText(value)
    setTrigger(detectComposerTrigger(value, cursor))
  }
  const select = (command: ComposerCommand) => {
    if (!trigger) return
    const result = replaceComposerTrigger(text, trigger, command.value ?? command.label)
    update(result.text, result.cursor)
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(result.cursor, result.cursor) })
  }
  const upload = async (file: File) => {
    const temp = `local-${crypto.randomUUID()}`
    setAttachments((items) => [...items, { id: temp, name: file.name, size: file.size, progress: 0, state: 'uploading' }])
    try {
      const result = await api.upload(sessionId, file, (progress) => setAttachments((items) => items.map((item) => item.id === temp ? { ...item, progress } : item)))
      setAttachments((items) => items.map((item) => item.id === temp ? { ...item, id: result.attachmentId, progress: 1, state: 'complete' } : item))
    } catch { setAttachments((items) => items.map((item) => item.id === temp ? { ...item, state: 'failed' } : item)) }
  }
  const submit = async () => {
    const value = text.trim()
    if (!value || attachments.some((item) => item.state === 'uploading')) return
    await onSend(value, attachments.filter((item) => item.state === 'complete').map((item) => item.id))
    setText(''); setTrigger(null); setAttachments([])
  }
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit() }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); for (const file of event.dataTransfer.files) void upload(file) }}>
    {attachments.length > 0 && <div className="composer-attachments">{attachments.map((item) => <span className="attachment-chip" key={item.id}><Paperclip size={13} />{item.name} {item.state === 'uploading' ? `${Math.round(item.progress * 100)}%` : item.state === 'failed' ? 'failed' : ''}<button type="button" aria-label={`Remove ${item.name}`} onClick={() => setAttachments((items) => items.filter((value) => value.id !== item.id))}><X size={13} /></button></span>)}</div>}
    {trigger && <CommandMenu commands={commands} kind={trigger.kind} query={trigger.query} onSelect={select} />}
    <label className="composer-file"><Paperclip size={17} /><input type="file" multiple onChange={(event) => { for (const file of event.target.files ?? []) void upload(file); event.target.value = '' }} /></label>
    {harnesses.length > 0 && <select className="composer-harness" aria-label="Harness" value={selectedHarness} onChange={(event) => setSelectedHarness(event.target.value)}>{harnesses.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select>}
    <textarea ref={textarea} aria-label="Message composer" placeholder={harness ? `Message ${harness}…` : 'Send a message…'} value={text} rows={1} onChange={(event) => update(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} />
    <button type="submit" disabled={sending || !text.trim()} aria-label="Send"><Send size={17} /><span className="composer-send-label">{sending ? 'Sending…' : 'Send'}</span></button>
  </form>
}
