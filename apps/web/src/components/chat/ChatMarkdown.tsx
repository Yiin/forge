import { Check, Copy, WrapText } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { Streamdown } from 'streamdown'
import { useCopied } from './useCopied'
import './chat-markdown.css'

// Streamed words fade in by opacity only, with no slide.
const STREAM_FADE = {
  animation: 'fadeIn',
  duration: 200,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  sep: 'word',
} as const

const COMPONENTS = { code: CodeBlock, inlineCode: InlineCode }

export function ChatMarkdown({
  text,
  streaming = false,
}: {
  text: string
  /** The reply is still growing; new words fade in. */
  streaming?: boolean
}) {
  return (
    <div className="chat-markdown w-full min-w-0">
      <Streamdown
        mode="streaming"
        parseIncompleteMarkdown
        skipHtml
        lineNumbers={false}
        controls={false}
        codeBlockMaxHeight={0}
        tableMaxHeight={0}
        animated={STREAM_FADE}
        isAnimating={streaming}
        components={COMPONENTS}
      >
        {text}
      </Streamdown>
    </div>
  )
}

function InlineCode({
  node: _node,
  ...props
}: ComponentProps<'code'> & {
  node?: unknown
}) {
  return <code data-streamdown="inline-code" {...props} />
}

/**
 * zeron's fenced code frame: a 28px header with the language, a wrap toggle
 * and copy, over a body that scrolls sideways unless wrapped.
 */
function CodeBlock({
  className,
  children,
}: ComponentProps<'code'> & { node?: unknown }) {
  const language = /language-(\S+)/.exec(className ?? '')?.[1] ?? ''
  const code = String(children ?? '').replace(/\n$/, '')
  const [wrap, setWrap] = useState(false)
  const [copied, copy] = useCopied()
  return (
    <div className="md-code" data-streamdown="code-block">
      <div className="md-code-header">
        <span className="min-w-0 truncate">{language}</span>
        <div className="md-code-actions">
          <button
            type="button"
            className="md-code-button"
            aria-pressed={wrap}
            aria-label={wrap ? 'Use horizontal scrolling' : 'Fit content'}
            title={wrap ? 'Use horizontal scrolling' : 'Fit content'}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText className="size-[13px]" aria-hidden />
          </button>
          <button
            type="button"
            className="md-code-button"
            data-copy
            aria-label="Copy code"
            title="Copy code"
            onClick={() => copy(code)}
          >
            {copied ? (
              <>
                <Check className="size-3" aria-hidden /> Copied
              </>
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
          </button>
        </div>
      </div>
      <pre className="md-code-body" data-wrap={wrap}>
        <code>{code}</code>
      </pre>
    </div>
  )
}
