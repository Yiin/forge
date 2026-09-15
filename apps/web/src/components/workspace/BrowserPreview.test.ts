import { describe, expect, it } from 'vitest'
import { normalizeBrowserAddress, normalizePreviewPath } from './BrowserPreview'

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
