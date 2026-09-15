import { describe, expect, it } from 'vitest'
import { canonical, digest, immutableData } from './data.js'

describe('ACP canonical data authority', () => {
  it('rejects sparse and undefined arrays instead of colliding with empty arrays', () => {
    for (const value of [[undefined], Array(1), [null, undefined]]) {
      expect(() => immutableData(value)).toThrow()
      expect(() => canonical(value)).toThrow()
      expect(() => digest(value)).toThrow()
    }
    expect(canonical([])).toBe('[]')
    expect(digest([null])).not.toBe(digest([]))
  })
  it('rejects hidden array properties and accessors without invoking them', () => {
    const array: unknown[] = []
    Object.defineProperty(array, 'extra', { value: true })
    expect(() => canonical(array)).toThrow()
    let reads = 0
    const getter = Object.defineProperty([], '0', {
      get() {
        reads++
        return 1
      },
    })
    expect(() => canonical(getter)).toThrow()
    expect(reads).toBe(0)
  })
  it('uses sorted object keys and preserves array order', () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }))
    expect(digest([1, 2])).not.toBe(digest([2, 1]))
    expect(canonical({ omitted: undefined, value: null })).toBe(
      '{"value":null}',
    )
  })
})
