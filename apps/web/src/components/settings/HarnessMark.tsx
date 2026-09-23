// Brand marks come from Comet/Zeron (MIT, Copyright (c) 2026 Wing) via
// apps/web/src/assets/providers/. See THIRD_PARTY_NOTICES.md.
import { Bot } from 'lucide-react'
import claudeMark from '../../assets/providers/claude.svg'
import codexMark from '../../assets/providers/openai.svg'
import cursorMark from '../../assets/providers/cursor.svg'
import devinMark from '../../assets/providers/devin.svg'
import grokMark from '../../assets/providers/grok.svg'
import hermesMark from '../../assets/providers/hermes.svg'
import opencodeMark from '../../assets/providers/opencode.svg'
import piMark from '../../assets/providers/pi.svg'
import { cn } from '@/lib/utils'

const MARKS: Record<string, string> = {
  claude: claudeMark,
  codex: codexMark,
  cursor: cursorMark,
  devin: devinMark,
  grok: grokMark,
  hermes: hermesMark,
  opencode: opencodeMark,
  pi: piMark,
}

/**
 * Decorative brand mark for a harness kind (see harnessMarkKind). The SVG is
 * used as a CSS mask so the mark takes the text color; Claude keeps its brand
 * tint. Unknown kinds render a generic bot icon. Size defaults to 16px.
 */
export function HarnessMark({
  kind,
  className,
}: {
  kind: string
  className?: string
}) {
  const src = MARKS[kind]
  if (!src)
    return (
      <Bot
        aria-hidden
        data-harness-mark="fallback"
        className={cn('size-4 shrink-0', className)}
      />
    )
  return (
    <span
      aria-hidden
      data-harness-mark={kind}
      className={cn(
        'inline-block size-4 shrink-0',
        kind === 'claude' ? 'bg-[#D97757]' : 'bg-current',
        className,
      )}
      style={{
        maskImage: `url("${src}")`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
      }}
    />
  )
}
