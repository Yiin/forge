// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextWindowMeter } from './ContextWindowMeter'

const usage = (extra: Record<string, unknown> = {}) => ({
  usedTokens: 157_000,
  maxTokens: 1_000_000,
  source: 'test',
  observedAt: 1,
  ...extra,
})

describe('ContextWindowMeter', () => {
  afterEach(cleanup)
  it('renders context usage and progress', () => {
    render(<ContextWindowMeter usage={usage()} />)
    fireEvent.click(screen.getByLabelText('Context window 16% used'))
    expect(screen.getByText('16% · 157k/1m')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '16',
    )
  })

  it('renders optional total and compaction text', () => {
    render(<ContextWindowMeter usage={usage({ totalProcessedTokens: 0 })} />)
    fireEvent.click(screen.getByLabelText('Context window 16% used'))
    expect(screen.queryByText('Total processed')).toBeNull()
    cleanup()
    render(
      <ContextWindowMeter
        usage={usage({
          totalProcessedTokens: 2_000_000,
          compactsAutomatically: true,
        })}
      />,
    )
    fireEvent.click(screen.getByLabelText('Context window 16% used'))
    expect(screen.getByText('Total processed')).toBeTruthy()
    expect(screen.getByText(/automatically compacts/)).toBeTruthy()
  })

  it('shows subscription windows without inventing a reset', () => {
    render(
      <ContextWindowMeter
        usage={usage()}
        account={{
          accountId: 'a',
          harnessKind: 'claude',
          harnessKey: 'claude',
          enabled: true,
          installed: true,
          version: 'test',
          status: 'ready',
          auth: { status: 'authenticated' },
          checkedAt: '',
          usage: [
            {
              window: '5h window',
              utilization: 0.42,
              resetsAt: null,
              source: 'test',
              observedAt: '',
            },
          ],
          usageStatus: 'ok',
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText('Context window 16% used'))
    expect(screen.getByText('5h window')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.queryByText(/resets in/)).toBeNull()
  })

  it('hides unsupported subscription windows', () => {
    render(
      <ContextWindowMeter
        usage={usage()}
        account={{
          accountId: 'a',
          harnessKind: 'claude',
          harnessKey: 'claude',
          enabled: true,
          installed: true,
          version: 'test',
          status: 'ready',
          auth: { status: 'authenticated' },
          checkedAt: '',
          usage: [
            {
              window: '5h window',
              utilization: 0.42,
              resetsAt: null,
              source: 'test',
              observedAt: '',
            },
          ],
          usageStatus: 'unsupported',
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText('Context window 16% used'))
    expect(screen.queryByText('5h window')).toBeNull()
  })
})
