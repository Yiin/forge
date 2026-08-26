import { describe, expect, it } from 'vitest'
import {
  messageHitUrl,
  parseSnippet,
  runHitUrl,
  sessionHitUrl,
} from '../src/components/search/search-logic'

describe('search snippet parsing', () => {
  it('preserves text and only turns mark tags into highlights', () => {
    expect(parseSnippet('<mark>one</mark> <script>alert(1)</script>')).toEqual([
      { text: 'one', highlighted: true },
      { text: ' <script>alert(1)</script>', highlighted: false },
    ])
  })

  it('does not treat attributes or other tags as markup', () => {
    expect(parseSnippet('<mark class="bad">word</mark>')).toEqual([
      { text: '<mark class="bad">word', highlighted: false },
    ])
  })
})

describe('search hit URLs', () => {
  it('maps each result type to its deep link', () => {
    expect(sessionHitUrl('ses/1')).toBe('/s/ses%2F1')
    expect(messageHitUrl('ses/1', 42)).toBe('/s/ses%2F1?m=42')
    expect(runHitUrl('run/1')).toBe('/runs/run%2F1')
  })
})
