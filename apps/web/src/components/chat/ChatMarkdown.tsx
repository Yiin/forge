import { Streamdown } from 'streamdown'

export function ChatMarkdown({
  text,
  streaming = true,
}: {
  text: string
  streaming?: boolean
}) {
  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown
        skipHtml
        lineNumbers={false}
        shikiTheme={['github-dark', 'github-light']}
      >
        {text}
      </Streamdown>
    </div>
  )
}
