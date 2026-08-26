// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from './select'

function TestSelect() {
  const [value, setValue] = useState('one')
  return (
    <Select value={value} onValueChange={(next) => setValue(next as string)}>
      <SelectTrigger aria-label="Choice">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="one">One</SelectItem>
        <SelectItem value="two">Two</SelectItem>
        <SelectItem value="three">Three</SelectItem>
      </SelectPopup>
    </Select>
  )
}

describe('Select', () => {
  it('exposes listbox semantics, keyboard navigation, and focus restoration', async () => {
    render(<TestSelect />)
    const trigger = screen.getByRole('combobox', { name: 'Choice' })
    trigger.focus()
    fireEvent.click(trigger)

    const listbox = await screen.findByRole('listbox', { hidden: true })
    expect(listbox).toBeTruthy()
    expect(
      screen.getByRole('option', { name: 'One' }).getAttribute('aria-selected'),
    ).toBe('true')

    const three = screen.getByRole('option', { name: 'Three' })
    fireEvent.keyDown(three, { key: 'End' })
    fireEvent.click(three)
    await waitFor(() => expect(screen.getByText('Three')).toBeTruthy())

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('listbox', { hidden: true }), {
      key: 'Escape',
    })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
