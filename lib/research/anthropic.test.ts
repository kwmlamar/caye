import { describe, expect, it } from 'vitest'
import {
  extractAnthropicFetchedDocument,
  extractAnthropicSearchResults,
} from './anthropic'

describe('Anthropic research evidence parsing', () => {
  it('extracts unique URLs from web search result blocks without treating encrypted content as evidence', () => {
    const results = extractAnthropicSearchResults([
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://example.com/a', title: 'A', encrypted_content: 'ciphertext' },
          { type: 'web_search_result', url: 'https://example.com/a', title: 'Duplicate', encrypted_content: 'ciphertext-2' },
          { type: 'web_search_result', url: 'https://example.com/b', title: 'B', encrypted_content: 'ciphertext-3' },
        ],
      },
    ])

    expect(results).toEqual([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' },
    ])
    expect(JSON.stringify(results)).not.toContain('ciphertext')
  })

  it('extracts exact fetched text and retrieval time for the expected URL', () => {
    const fetched = extractAnthropicFetchedDocument([
      {
        type: 'web_fetch_tool_result',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/source',
          retrieved_at: '2026-08-30T03:30:00Z',
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'Durable source text.' },
          },
        },
      },
    ], 'https://example.com/source')

    expect(fetched).toEqual({
      content: 'Durable source text.',
      fetchedAt: '2026-08-30T03:30:00Z',
    })
  })

  it('fails closed for a mismatched URL or non-text fetched document', () => {
    const blocks = [{
      type: 'web_fetch_tool_result',
      content: {
        type: 'web_fetch_result',
        url: 'https://example.com/source',
        content: { type: 'document', source: { type: 'base64', data: 'abc' } },
      },
    }]

    expect(extractAnthropicFetchedDocument(blocks, 'https://example.com/other')).toBeNull()
    expect(extractAnthropicFetchedDocument(blocks, 'https://example.com/source')).toBeNull()
  })
})
