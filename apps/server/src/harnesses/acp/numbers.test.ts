import { describe, expect, it } from 'vitest'
import { captureNumbers, declaredInteger } from './numbers.js'

describe('ACP exact numeric source', () => {
  it('preserves exact i64 and u64 spellings without passing through Number', () => {
    const values = [
      '-9223372036854775808',
      '-1',
      '0',
      '9007199254740991',
      '9007199254740992',
      '9007199254740993',
      '9223372036854775807',
      '18446744073709551615',
    ]
    const captured = captureNumbers('[' + values.join(',') + ']')
    expect(captured.numbers.map((token) => token.text)).toEqual(values)
    for (let index = 0; index < values.length; index++) {
      const token = captured.numbers[index]!
      const result = declaredInteger(
        token,
        index === values.length - 1 ? 'u64' : 'i64',
      )
      expect(result.decimal).toBe(values[index])
      if (index > 3 || index < 2) expect(result.safeCount).toBeUndefined()
    }
    expect(declaredInteger(captured.numbers[2]!, 'u64').safeCount).toBe(0)
  })
  it('captures decoded paths and UTF-8 wire offsets while ignoring string contents', () => {
    const source =
      '{"é":"18446744073709551615", "a\\u002fb~":[9007199254740993, null, -0]}'
    const capture = captureNumbers(source)
    expect(capture.numbers.map((token) => token.path)).toEqual([
      '/a~1b~0/0',
      '/a~1b~0/2',
    ])
    for (const token of capture.numbers)
      expect(
        Buffer.from(source)
          .subarray(token.offset, token.offset + token.text.length)
          .toString(),
      ).toBe(token.text)
    expect(capture.numbers[1]!.text).toBe('-0')
  })
  it.each([
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '[01]',
    '[1,]',
    '{"x":}',
    'NaN',
    '1e',
    '"bad\\x"',
  ])('rejects malformed or duplicate source %s', (source) => {
    expect(() => captureNumbers(source)).toThrow()
  })
  it.each(['-1', '-0', '18446744073709551616', '1e3', '1.0'])(
    'rejects unsupported u64 %s without rounding',
    (text) => {
      expect(() =>
        declaredInteger(captureNumbers(text).numbers[0]!, 'u64'),
      ).toThrow()
    },
  )
  it('captures string routing fields in the same validated source scan', () => {
    const routing: Record<string, string> = {}
    captureNumbers(
      '{"params":{"sessionId":"original","_meta":{"promptId":"exact"}},"text":"unchanged"}',
      (path, value) => {
        if (path.startsWith('/params/')) routing[path] = value
      },
    )
    expect(routing).toEqual({
      '/params/sessionId': 'original',
      '/params/_meta/promptId': 'exact',
    })
    expect(() => captureNumbers('{"id":"one","id":"two"}', () => {})).toThrow()
  })
  it('charges JSON-escaped paths within the encoded source metadata limit', () => {
    const source = JSON.stringify({ ['\n'.repeat(32768)]: Array(20).fill(0) })
    expect(() => captureNumbers(source)).toThrow()
    const bounded = captureNumbers(
      JSON.stringify({ ['\n'.repeat(4096)]: Array(20).fill(0) }),
    )
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      1024 * 1024,
    )
  })
  it('bounds number capture and preserves a final frame without a newline', () => {
    expect(captureNumbers('{"x":0}').numbers[0]!.text).toBe('0')
    expect(() =>
      captureNumbers('[' + Array(16385).fill('0').join(',') + ']'),
    ).toThrow()
  })
})
