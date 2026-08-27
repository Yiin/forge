import { Streamdown } from 'streamdown'

const PROSE_CLASSES = [
  'text-sm leading-relaxed text-foreground',
  '[&>*+*]:mt-3',
  '[&_p]:leading-relaxed',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_table]:text-xs',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-card [&_pre]:p-3',
  '[&_code]:font-mono [&_code]:text-[0.85em]',
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5',
].join(' ')

export function ChatMarkdown({
  text,
  streaming = true,
}: {
  text: string
  streaming?: boolean
}) {
  return (
    <Streamdown
      className={PROSE_CLASSES}
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
