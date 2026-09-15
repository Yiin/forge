import { describe, expect, it } from 'vitest'
import {
  normalizeBrowserAddress,
  normalizePreviewPath,
  previewPage,
} from './BrowserPreview'
import type { PreviewTarget } from '@forge/protocol/preview'

it('keeps every navigation inside the registered preview prefix', () => {
  const target = {
    publicUrl: 'http://127.0.0.2:4567/preview/original/',
  } as PreviewTarget
  expect(previewPage(target, '/')).toBe(
    'http://127.0.0.2:4567/preview/original/',
  )
  expect(previewPage(target, '/second?q=1#detail')).toBe(
    'http://127.0.0.2:4567/preview/original/second?q=1#detail',
  )
  expect(previewPage(target, '/../../outside')).toBe(
    'http://127.0.0.2:4567/preview/original/outside',
  )
  expect(previewPage(target, '/https://example.test/x')).toBe(
    'http://127.0.0.2:4567/preview/original/https://example.test/x',
  )
  expect(previewPage(target, '/javascript:alert(1)')).toBe(
    'http://127.0.0.2:4567/preview/original/javascript:alert(1)',
  )
})

describe('browser preview addresses', () => {
  it('adds HTTP and strips paths before registration', () => {
    expect(normalizeBrowserAddress('127.0.0.1:4173/app?x=1').origin).toBe(
      'http://127.0.0.1:4173',
    )
  })

  it.each(['ftp://127.0.0.1:4173', 'http://user:pass@127.0.0.1:4173'])(
    'rejects unsafe address %s',
    (address) => {
      expect(() => normalizeBrowserAddress(address)).toThrow()
    },
  )

  it('keeps navigation inside the registered preview path', () => {
    expect(normalizePreviewPath('/app?tab=1#main')).toBe('/app?tab=1#main')
    expect(() => normalizePreviewPath('//evil.example')).toThrow()
    expect(() => normalizePreviewPath('https://evil.example')).toThrow()
  })
})
