// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessSettings } from './settings-pages'

const { listHarnesses, saveHarnesses, testHarness } = vi.hoisted(() => ({
  listHarnesses: vi.fn(),
  saveHarnesses: vi.fn(),
  testHarness: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: { listHarnesses, saveHarnesses, testHarness },
}))

const harness = {
  mock: {
    name: 'Mock agent',
    command: 'mock-agent',
    args: [],
    env: { API_KEY: 'secret' },
    protocol: 'acp' as const,
    enabled: true,
  },
}

describe('HarnessSettings', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    listHarnesses.mockResolvedValue(harness)
    saveHarnesses.mockResolvedValue(harness)
    testHarness.mockResolvedValue({
      ok: true,
      agentName: 'Mock',
      capabilities: { loadSession: true },
    })
  })

  it('keeps drafts local until Save and preserves them after a failed save', async () => {
    saveHarnesses.mockRejectedValueOnce(new Error('disk is full'))
    render(<HarnessSettings />)
    const name = await screen.findByDisplayValue('Mock agent')

    fireEvent.change(name, { target: { value: 'Edited agent' } })
    expect(saveHarnesses).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(screen.getByDisplayValue('Edited agent')).toBeTruthy()
    expect(screen.getByText(/Could not save: disk is full/)).toBeTruthy()
  })

  it('validates before saving and keeps secrets masked until revealed', async () => {
    render(<HarnessSettings />)
    const command = await screen.findByDisplayValue('mock-agent')
    fireEvent.change(command, { target: { value: '' } })
    expect(screen.getByText(/Too small: expected string/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveHarnesses).not.toHaveBeenCalled()

    const secret = screen.getByDisplayValue('secret') as HTMLInputElement
    expect(secret.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(secret.type).toBe('text')
  })

  it('shows test pending, success capabilities, and failure', async () => {
    render(<HarnessSettings />)
    await screen.findByDisplayValue('mock-agent')
    const test = screen.getByRole('button', { name: 'Test' })
    fireEvent.click(test)
    expect(screen.getByText('Testing…')).toBeTruthy()
    await screen.findByText(/Connection succeeded/)
    expect(screen.getByText(/loadSession: yes/)).toBeTruthy()

    testHarness.mockRejectedValueOnce(new Error('not reachable'))
    fireEvent.click(test)
    await waitFor(() => expect(screen.getByText('not reachable')).toBeTruthy())
  })

  it('requires confirmation before deleting a harness', async () => {
    render(<HarnessSettings />)
    await screen.findByDisplayValue('mock-agent')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Delete “Mock agent”/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!)
    await waitFor(() =>
      expect(screen.queryByDisplayValue('mock-agent')).toBeNull(),
    )
    expect(saveHarnesses).toHaveBeenCalledWith({})
  })
})
