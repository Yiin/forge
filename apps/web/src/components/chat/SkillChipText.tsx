import type { ReactNode } from 'react'

const SKILL_TOKEN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g
export function SkillChipText({
  text,
  skills = [],
}: {
  text: string
  skills?: string[]
}) {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const name = match[2] ?? ''
    if (!skills.includes(name)) continue
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    nodes.push(
      text.slice(cursor, start),
      <span
        className="inline-block rounded-md border border-primary/35 bg-primary/10 px-1.5 py-px text-[0.9em] text-primary"
        key={`${start}-${name}`}
      >
        ${name}
      </span>,
    )
    cursor = start + name.length + 1
  }
  return <>{cursor ? [...nodes, text.slice(cursor)] : text}</>
}
