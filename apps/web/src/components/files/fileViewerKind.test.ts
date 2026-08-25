import { describe, expect, it } from 'vitest'
import { fileViewerKind, languageForFilename } from './fileViewerKind'

describe('fileViewerKind', () => {
  it.each([
    ['photo.PNG', 'application/octet-stream', 'image'],
    ['manual.bin', 'application/pdf', 'pdf'],
    ['manual.pdf', 'application/octet-stream', 'pdf'],
    ['movie.bin', 'video/mp4', 'video'],
    ['sound.bin', 'audio/ogg', 'audio'],
    ['server.ts', 'application/octet-stream', 'text'],
    ['data.bin', 'application/octet-stream', 'download'],
  ] as const)('%s becomes %s', (filename, mime, expected) =>
    expect(fileViewerKind(filename, mime)).toBe(expected),
  )

  it('maps code extensions to highlighting languages', () =>
    expect(languageForFilename('widget.ts')).toBe('typescript'))
})
