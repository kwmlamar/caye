import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/** Fake storage bucket keyed by object path, tailored to .upload()/.list() only. */
const uploadCalls = vi.hoisted(() => [] as Array<{ path: string }>)
const bucketFiles = vi.hoisted(() => new Set<string>())
const forcedUploadError = vi.hoisted(() => ({ value: null as string | null }))
const forcedListMiss = vi.hoisted(() => ({ value: false }))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({
        upload: (path: string) => {
          uploadCalls.push({ path })
          if (forcedUploadError.value) return Promise.resolve({ data: null, error: { message: forcedUploadError.value } })
          bucketFiles.add(path)
          return Promise.resolve({ data: { path }, error: null })
        },
        list: (dir: string, opts: { search: string }) => {
          if (forcedListMiss.value) return Promise.resolve({ data: [], error: null })
          const matches = [...bucketFiles]
            .filter((p) => p.startsWith(`${dir}/`) && p.slice(dir.length + 1) === opts.search)
            .map((p) => ({ name: p.slice(dir.length + 1) }))
          return Promise.resolve({ data: matches, error: null })
        },
      }),
    },
  }),
}))

import { detectMimeType, sha256Hex, buildStoragePath, uploadArtifactBytes, objectExists } from './storage'

beforeEach(() => {
  uploadCalls.length = 0
  bucketFiles.clear()
  forcedUploadError.value = null
  forcedListMiss.value = false
})

describe('uploadArtifactBytes — adversarial scenario 14: never trust a bare success response (#87 review pass 2)', () => {
  it('confirms the object is actually listable before reporting ok:true', async () => {
    const result = await uploadArtifactBytes({ path: 'ws-1/artifact-1/original.png', bytes: Buffer.from('x'), mimeType: 'image/png' })
    expect(result.ok).toBe(true)
    expect(await objectExists('ws-1/artifact-1/original.png')).toBe(true)
  })

  it('reports failure when the upload API claims success but the object cannot be verified afterward', async () => {
    forcedListMiss.value = true
    const result = await uploadArtifactBytes({ path: 'ws-1/artifact-1/original.png', bytes: Buffer.from('x'), mimeType: 'image/png' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/could not be verified/i)
  })

  it('a retry hitting "already exists" is treated as success ONLY when the object is actually confirmed present', async () => {
    forcedUploadError.value = 'The resource already exists'
    forcedListMiss.value = true // simulates "exists" error without the object actually being there — should NOT be trusted
    const result = await uploadArtifactBytes({ path: 'ws-1/artifact-1/original.png', bytes: Buffer.from('x'), mimeType: 'image/png' })
    expect(result.ok).toBe(false)
  })
})

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
