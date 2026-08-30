import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  createAnthropicResearchSynthesizer,
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

describe('Anthropic research synthesis JSON recovery', () => {
  const input = {
    question: 'Which architecture is safer?',
    sources: [{
      id: '49fbc100-6faa-4dc7-bc1c-fa016b0e64b7',
      source: {
        url: 'https://example.com/source',
        title: 'Source',
        content: 'Evidence text.',
        fetchedAt: '2026-08-30T03:30:00Z',
      },
    }],
  }

  const validJson = JSON.stringify({
    claims: [{
      statement: 'Bounded architectures can improve reliability.',
      claimType: 'finding',
      confidence: 0.8,
      sourceQuality: 'primary',
      sourceIds: ['S1'],
    }],
    brief: 'Bounded architectures are promising.',
    strongestEvidence: [],
    conflictingEvidence: [],
    unknowns: [],
    materialChanges: [],
    implications: [],
    recommendations: [],
  })

  it('uses short evidence handles in the model prompt and maps them back to durable source IDs', async () => {
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: validJson }],
    })
    const client = { messages: { create } } as unknown as Anthropic
    const synthesize = createAnthropicResearchSynthesizer({ client, model: 'test-model' })

    const result = await synthesize(input)

    const prompt = create.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('"evidenceHandle":"S1"')
    expect(prompt).not.toContain('49fbc100-6faa-4dc7-bc1c-fa016b0e64b7')
    expect(result.claims[0].sourceIds).toEqual(['49fbc100-6faa-4dc7-bc1c-fa016b0e64b7'])
  })

  it('retries from scratch when the first synthesis response is truncated', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{"claims":[{"statement":"cut off' }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: validJson }],
      })
    const client = { messages: { create } } as unknown as Anthropic
    const synthesize = createAnthropicResearchSynthesizer({ client, model: 'test-model' })

    const result = await synthesize(input)

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][0].max_tokens).toBe(8_192)
    expect(result.brief).toBe('Bounded architectures are promising.')
    expect(result.claims).toHaveLength(1)
  })

  it('retries when the first complete response contains malformed JSON', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"claims": [}' }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: validJson }],
      })
    const client = { messages: { create } } as unknown as Anthropic
    const synthesize = createAnthropicResearchSynthesizer({ client, model: 'test-model' })

    const result = await synthesize(input)

    expect(create).toHaveBeenCalledTimes(2)
    expect(result.brief).toBe('Bounded architectures are promising.')
  })

  it('retries when a material claim has no evidence', async () => {
    const unsupportedJson = JSON.stringify({
      claims: [{
        statement: 'Unsupported claim.',
        claimType: 'finding',
        confidence: 0.9,
        sourceQuality: 'primary',
        sourceIds: [],
      }],
      brief: 'Attempt one.',
      strongestEvidence: [],
      conflictingEvidence: [],
      unknowns: [],
      materialChanges: [],
      implications: [],
      recommendations: [],
    })
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: unsupportedJson }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: validJson }] })
    const client = { messages: { create } } as unknown as Anthropic
    const synthesize = createAnthropicResearchSynthesizer({ client, model: 'test-model' })

    const result = await synthesize(input)

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0].messages[0].content).toContain('Material research claim lacks evidence')
    expect(result.claims[0].sourceIds).toEqual(['49fbc100-6faa-4dc7-bc1c-fa016b0e64b7'])
  })

  it('retries when a claim cites an evidence handle outside the supplied run evidence', async () => {
    const inventedSourceJson = JSON.stringify({
      claims: [{
        statement: 'Claim with invented citation.',
        claimType: 'finding',
        confidence: 0.7,
        sourceQuality: 'unknown',
        sourceIds: ['S99'],
      }],
      brief: 'Attempt one.',
      strongestEvidence: [],
      conflictingEvidence: [],
      unknowns: [],
      materialChanges: [],
      implications: [],
      recommendations: [],
    })
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: inventedSourceJson }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: validJson }] })
    const client = { messages: { create } } as unknown as Anthropic
    const synthesize = createAnthropicResearchSynthesizer({ client, model: 'test-model' })

    const result = await synthesize(input)

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0].messages[0].content).toContain('evidence handles not present in this run')
    expect(result.brief).toBe('Bounded architectures are promising.')
  })
})
