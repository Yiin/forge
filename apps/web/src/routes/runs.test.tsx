// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EpicLaunchDialog } from './runs'
import { api } from '../lib/api'

vi.mock('../lib/api', () => ({
  api: {
    listProjects: vi.fn(),
    listHarnesses: vi.fn(),
    startRun: vi.fn(),
  },
}))

const mockedApi = vi.mocked(api)

describe('EpicLaunchDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.listProjects.mockResolvedValue([
      { id: 'project-1', name: 'Forge' },
    ])
    mockedApi.listHarnesses.mockResolvedValue({
      'fake-acp-agent': { name: 'Fake' },
    })
  })

  it('reports loading failures and retries', async () => {
    mockedApi.listProjects
      .mockRejectedValueOnce(new Error('Projects unavailable'))
      .mockResolvedValueOnce([{ id: 'project-1', name: 'Forge' }])
    render(<EpicLaunchDialog open onOpenChange={vi.fn()} onStarted={vi.fn()} />)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Projects unavailable',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await screen.findAllByRole('combobox'))[0]).toBeTruthy()
  })

  it('marks invalid fields and reports launch failures', async () => {
    mockedApi.startRun.mockRejectedValue(new Error('Runner rejected launch'))
    render(<EpicLaunchDialog open onOpenChange={vi.fn()} onStarted={vi.fn()} />)
    await screen.findByLabelText('Project')
    fireEvent.click(screen.getByRole('button', { name: 'Launch epic' }))
    expect(
      screen.getByPlaceholderText('forge-3b7').getAttribute('aria-invalid'),
    ).toBe('true')
    fireEvent.change(screen.getByPlaceholderText('forge-3b7'), {
      target: { value: 'forge-epic' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Launch epic' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Runner rejected launch',
    )
  })

  it('reports a successful run to the navigation owner', async () => {
    const onStarted = vi.fn()
    mockedApi.startRun.mockResolvedValue({ id: 'run-1' })
    render(
      <EpicLaunchDialog open onOpenChange={vi.fn()} onStarted={onStarted} />,
    )
    await screen.findByLabelText('Project')
    fireEvent.change(screen.getByPlaceholderText('forge-3b7'), {
      target: { value: 'forge-epic' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Launch epic' })[0])
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('run-1'))
  })
})
