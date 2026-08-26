import { describe, expect, it } from 'vitest'
import {
  ancestorPaths,
  directoriesToLoad,
  filePathUrl,
  pathsToExpand,
} from './fileBrowserPath'

describe('file browser paths', () => {
  it('maps a splat to a project file URL', () => {
    expect(filePathUrl('project one', '/src/index.ts/')).toBe(
      '/files/project%20one/src/index.ts',
    )
  })

  it('returns directory ancestors without the selected file', () => {
    expect(ancestorPaths('src/lib/index.ts')).toEqual([
      'src',
      'src/lib',
      'src/lib/index.ts',
    ])
    expect(pathsToExpand('src/lib/index.ts')).toEqual(['src', 'src/lib'])
  })

  it('loads the root and every directory needed for a deep link', () => {
    expect(directoriesToLoad('src/lib/index.ts')).toEqual([
      '',
      'src',
      'src/lib',
    ])
  })
})
