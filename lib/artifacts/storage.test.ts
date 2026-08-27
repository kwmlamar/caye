import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { detectMimeType, sha256Hex, buildStoragePath } from './storage'

describe('detectMimeType — never trust the extension/declared type', () => {
  it('sniffs a real PNG even when declared as something else', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(detectMimeType(png, 'application/pdf')).toBe('image/png')
  })

  it('sniffs a real JPEG', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(detectMimeType(jpeg, null)).toBe('image/jpeg')
  })

  it('sniffs a real PDF regardless of declared type', () => {
    const pdf = Buffer.from('%PDF-1.4\n...')
    expect(detectMimeType(pdf, 'image/png')).toBe('application/pdf')
  })

  it('falls back to the declared type only for indistinguishable zip-based containers (docx)', () => {
    const zipSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    expect(
      detectMimeType(zipSignature, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('falls back to declared type for bytes with no recognizable signature (e.g. plain text/csv)', () => {
    const csv = Buffer.from('name,total\nJeff,450\n')
    expect(detectMimeType(csv, 'text/csv')).toBe('text/csv')
  })

  it('never fabricates a mime type it did not sniff or was told', () => {
    const garbage = Buffer.from([0x01, 0x02, 0x03])
    expect(detectMimeType(garbage, null)).toBe('application/octet-stream')
  })
})

describe('sha256Hex', () => {
  it('is stable for the same bytes', () => {
    const bytes = Buffer.from('hello world')
    expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from('hello world')))
  })

  it('differs for different bytes', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')))
  })
})

describe('buildStoragePath', () => {
  it('never derives the path from a caller-supplied filename', () => {
    const path = buildStoragePath('ws-1', 'artifact-1', 'image/png')
    expect(path).toBe('ws-1/artifact-1/original.png')
    // A hostile "filename" containing path traversal has no way into this
    // function's signature at all — buildStoragePath doesn't accept one.
  })

  it('falls back to a safe generic extension for an unmapped mime type', () => {
    expect(buildStoragePath('ws-1', 'artifact-1', 'application/x-weird')).toBe('ws-1/artifact-1/original.bin')
  })
})
