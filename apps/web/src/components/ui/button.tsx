import type { ButtonHTMLAttributes } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'comfortable' | 'compact'
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'comfortable',
  loading = false,
  disabled,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`ui-button ${variant} ${size} ${className ?? ''}`}
    >
      {loading ? 'Working…' : children}
    </button>
  )
}
