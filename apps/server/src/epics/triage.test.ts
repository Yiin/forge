import { describe, expect, it } from 'vitest'
import {
  classifyGate,
  failureSignature,
  isDependencyFailure,
  normalizeFailure,
  readSignatures,
  rememberSignature,
} from './triage.js'

describe('epic failure triage', () => {
  it('classifies an identical control failure as infrastructure', () => {
    const branch = { code: 1, output: '/tmp/a/node_modules/x missing (12ms)' }
    const control = { code: 1, output: '/tmp/b/node_modules/x missing (13ms)' }
    expect(classifyGate(branch, control)).toBe('infra')
    expect(isDependencyFailure(branch.output)).toBe(true)
    expect(normalizeFailure(branch.output)).toBe(
      normalizeFailure(control.output),
    )
  })

  it('stores signatures per bead and detects repeats', () => {
    const first = {
      attempt: 1,
      signature: failureSignature('bad /tmp/a'),
      excerpt: 'bad',
    }
    const config = rememberSignature({}, 'bead', first)
    expect(readSignatures(config, 'bead')).toEqual([first])
    expect(failureSignature('bad /tmp/b')).toBe(first.signature)
  })
})
