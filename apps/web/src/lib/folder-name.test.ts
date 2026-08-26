import { describe, expect, it } from 'vitest'
import { folderName } from './folder-name'

describe('folderName', () => {
  it('returns the basename', () => {
    expect(folderName('/a/b')).toBe('b')
    expect(folderName('/home/user/project')).toBe('project')
  })
  it('tolerates trailing slashes', () => {
    expect(folderName('/a/b/')).toBe('b')
    expect(folderName('/a/b///')).toBe('b')
  })
  it('returns / for the filesystem root', () => {
    expect(folderName('/')).toBe('/')
  })
})
