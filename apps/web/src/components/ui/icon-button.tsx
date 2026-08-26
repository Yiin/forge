import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
}) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      aria-label={label}
      className={`ui-icon-button ${props.className ?? ''}`}
    >
      {children}
    </button>
  )
}
