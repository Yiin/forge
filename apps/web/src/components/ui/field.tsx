import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'

export function Field({
  label,
  htmlFor,
  description,
  error,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  description?: ReactNode
  error?: ReactNode
  children: ReactNode
}) {
  const descriptionId = htmlFor ? `${htmlFor}-description` : undefined
  const errorId = htmlFor ? `${htmlFor}-error` : undefined
  const describedBy = [description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(' ')
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })
    : children
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {control}
      {description && (
        <p className="ui-field-description" id={descriptionId}>
          {description}
        </p>
      )}
      {error && (
        <p className="ui-field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
