import { Streamdown } from 'streamdown'

export function ChatMarkdown({
  text,
  streaming = true,
}: {
  text: string
  streaming?: boolean
}) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown
      skipHtml
      lineNumbers={false}
      shikiTheme={['github-dark', 'github-light']}
    >
      {text}
    </Streamdown>
  )
}
