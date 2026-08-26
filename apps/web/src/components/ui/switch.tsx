import { useId, type ButtonHTMLAttributes } from 'react'

export function Switch({
  checked,
  onCheckedChange,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <button
      {...props}
      id={props.id ?? id}
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ui-switch ${props.className ?? ''}`}
      onClick={() => onCheckedChange?.(!checked)}
    />
  )
}
