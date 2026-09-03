import { describe, expect, it } from 'vitest'
import { interruptReasonText } from './interrupt-copy'

describe('interruptReasonText', () => {
  it.each([
    ['cancelled', 'You stopped this turn.'],
    ['server_restart', 'Forge restarted. This turn stopped.'],
    ['server_crashed', 'Forge crashed and restarted. This turn stopped.'],
    ['agent_process_died', 'The agent process stopped.'],
    ['pty_process_died', 'The terminal process stopped.'],
    ['max_turn_time', 'The turn hit its time limit.'],
    ['error', 'The turn failed.'],
  ])('maps %s to human copy', (reason, expected) => {
    expect(interruptReasonText(reason)).toBe(expected)
  })

  it('includes the server update version when available', () => {
    expect(interruptReasonText('server_updated', '0.2.3')).toBe(
      'Forge updated to v0.2.3 and restarted. This turn stopped.',
    )
  })

  it('uses server update copy without a version', () => {
    expect(interruptReasonText('server_updated')).toBe(
      'Forge updated and restarted. This turn stopped.',
    )
  })

  it('keeps unknown reason codes visible', () => {
    expect(interruptReasonText('foo')).toBe('Turn stopped (foo).')
  })

  it('uses stopped copy when the reason is absent', () => {
    expect(interruptReasonText()).toBe('Turn stopped.')
  })
})
