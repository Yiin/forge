import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useSessionsStore } from '../../stores/sessions'

export function PathSwitcher({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const sessions = useSessionsStore((state) => state.sessions)
  const current = sessions.find((item) => item.id === sessionId)
  const family = current?.parentSessionId
    ? sessions.filter(
        (item) => item.parentSessionId === current.parentSessionId,
      )
    : sessions.filter((item) => item.parentSessionId === sessionId)
  if (family.length < 2) return null
  const index = family.findIndex((item) => item.id === sessionId)
  const move = (offset: number) => {
    const target = family[index + offset]
    if (target)
      void navigate({ to: '/s/$sessionId', params: { sessionId: target.id } })
  }
  return (
    <div className="path-switcher" aria-label="Conversation path">
      <button
        aria-label="Previous path"
        disabled={index <= 0}
        onClick={() => move(-1)}
      >
        <ChevronLeft size={15} />
      </button>
      <span>
        Path {index + 1} of {family.length}
      </span>
      <button
        aria-label="Next path"
        disabled={index < 0 || index >= family.length - 1}
        onClick={() => move(1)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  )
}
