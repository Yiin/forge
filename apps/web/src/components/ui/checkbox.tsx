import type { InputHTMLAttributes, ReactNode } from 'react'

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className="ui-check-label">
      <input {...props} type="checkbox" className={`ui-checkbox ${props.className ?? ''}`} />
      {label}
    </label>
  )
}

