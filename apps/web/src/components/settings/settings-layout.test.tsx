// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SettingsMeta, UsageMeter } from './settings-layout'

afterEach(cleanup)

it('joins only the present meta pieces with dot separators', () => {
  const { container } = render(
    <SettingsMeta>
      <span>Blurb</span>
      {false}
      <span>2 accounts</span>
    </SettingsMeta>,
  )
  expect(container.textContent).toBe('Blurb·2 accounts')
})

it('exposes usage as a meter with a warning fill from 80%', () => {
  const now = new Date(2026, 8, 1, 9, 0).getTime()
  render(
    <UsageMeter
      label="Session"
      percent={83.4}
      resetsAt={new Date(2026, 8, 1, 15, 45).toISOString()}
      nowMs={now}
    />,
  )
  const meter = screen.getByRole('meter', { name: 'Session usage' })
  expect(meter.getAttribute('aria-valuenow')).toBe('83')
  expect(meter.firstElementChild?.className).toContain('bg-warning')
  expect(screen.getByText('83% used')).toBeTruthy()
  expect(screen.getByText(/^resets /)).toBeTruthy()
})

it('hides the fill at 0% used', () => {
  render(<UsageMeter label="Week" percent={0} />)
  expect(
    screen.getByRole('meter', { name: 'Week usage' }).childElementCount,
  ).toBe(0)
})
