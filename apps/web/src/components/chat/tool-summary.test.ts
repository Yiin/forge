import { describe, expect, it } from 'vitest'
import { summarizeToolCall } from './tool-summary'

describe('summarizeToolCall', () => {
  it('summarizes shell commands with their useful metadata', () => {
    expect(
      summarizeToolCall('`Terminal`', {
        command: 'hostname',
        description: 'Check system hostname',
        timeout: 5000,
      }),
    ).toEqual({
      title: '$ hostname',
      detail: '— Check system hostname · timeout 5000ms',
    })
  })

  it('summarizes file tools with their path', () => {
    expect(
      summarizeToolCall('read_file', { path: '/tmp/example.txt' }),
    ).toEqual({ title: 'read_file /tmp/example.txt' })
  })

  it('falls back to a clean title for empty or unknown input', () => {
    expect(summarizeToolCall('`Terminal`', {})).toEqual({ title: 'Terminal' })
    expect(summarizeToolCall('Tool', undefined)).toEqual({ title: 'Tool' })
  })
})
