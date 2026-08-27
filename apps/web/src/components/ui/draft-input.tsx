import { useEffect, useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'

export function DraftInput({
  value,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'onChange'> & {
  value: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => onCommit(draft)
  return (
    <Input
      {...props}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
    />
  )
}
