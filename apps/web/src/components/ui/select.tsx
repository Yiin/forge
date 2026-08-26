import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'

function withClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  if (typeof className === 'function') {
    return (state: State) => [base, className(state)].filter(Boolean).join(' ')
  }
  return [base, className].filter(Boolean).join(' ')
}

export const Select = BaseSelect.Root

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <BaseSelect.Trigger
      ref={ref}
      className={withClassName('ui-select', className)}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="ui-select-icon">
        <ChevronDown size={16} aria-hidden="true" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  )
})

export const SelectValue = BaseSelect.Value

export const SelectPopup = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Popup>
>(function SelectPopup({ className, children, ...props }, ref) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner className="ui-select-positioner">
        <BaseSelect.Popup
          ref={ref}
          className={withClassName('ui-select-popup', className)}
          {...props}
        >
          <BaseSelect.ScrollUpArrow className="ui-select-scroll-arrow">
            <ChevronUp size={14} aria-hidden="true" />
          </BaseSelect.ScrollUpArrow>
          {children}
          <BaseSelect.ScrollDownArrow className="ui-select-scroll-arrow">
            <ChevronDown size={14} aria-hidden="true" />
          </BaseSelect.ScrollDownArrow>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
})

export const SelectItem = forwardRef<
  HTMLElement,
  ComponentPropsWithoutRef<typeof BaseSelect.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <BaseSelect.Item
      ref={ref}
      className={withClassName('ui-select-item', className)}
      {...props}
    >
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="ui-select-indicator">
        <Check size={15} aria-hidden="true" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  )
})

export function SelectOption({
  value,
  children,
  disabled,
}: {
  value: string
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <SelectItem value={value} disabled={disabled} label={String(children)}>
      {children}
    </SelectItem>
  )
}
