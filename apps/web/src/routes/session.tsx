import { Timeline } from '../components/chat/Timeline'
import { SessionHeader } from '../components/chat/SessionHeader'
import { useParams } from '@tanstack/react-router'

export function SessionRoute() {
  const { sessionId } = useParams({ from: '/s/$sessionId' })
  return (
    <div className="session-view">
      <SessionHeader sessionId={sessionId} />
      <Timeline />
    </div>
  )
}
