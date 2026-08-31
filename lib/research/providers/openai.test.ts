import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  createOpenAiResearchProvider,
  extractOpenAiOutputText,
  extractOpenAiSearchResults,
} from './openai'

/** Shape of a real POST /v1/responses payload using tools:[{type:'web_search'}]. */
const WEB_SEARCH_RESPONSE = {
  id: 'resp_1',
  model: 'gpt-5',
  output: [
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'caribbean tourism ai' } },
    {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'Two relevant sources were consulted.',
        annotations: [
          { type: 'url_citation', start_index: 0, end_index: 10, url: 'https://www.imf.org/report', title: 'IMF Report' },
          { type: 'url_citation', start_index: 11, end_index: 20, url: 'https://example.gov/data', title: 'Gov Data' },
          { type: 'url_citation', start_index: 21, end_index: 30, url: 'https://www.imf.org/report', title: 'IMF Report (dup)' },
        ],
      }],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 120 },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('OpenAI research evidence parsing', () => {
  it('extracts unique cited source URLs from Responses API url_citation annotations', () => {
    expect(extractOpenAiSearchResults(WEB_SEARCH_RESPONSE)).toEqual([
      { url: 'https://www.imf.org/report', title: 'IMF Report' },
      { url: 'https://example.gov/data', title: 'Gov Data' },
    ])
  })

  it('returns nothing when the model answered without citing any source', () => {
    expect(extractOpenAiSearchResults({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I think so.', annotations: [] }] }],
    })).toEqual([])
  })

  it('ignores non-citation annotations so unattributed prose cannot become a source', () => {
    expect(extractOpenAiSearchResults({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'x',
          annotations: [{ type: 'file_citation', file_id: 'file_1', filename: 'notes.txt' }],
        }],
      }],
    })).toEqual([])
  })

  it('extracts assistant output text for synthesis', () => {
    expect(extractOpenAiOutputText({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"claims":[]}' }] }],
    })).toBe('{"claims":[]}')
  })
})

describe('source discovery on reasoning models', () => {
  // Regression for the first production cycle after the provider migration:
  // gpt-5-mini spent its whole output budget on hidden reasoning, emitted no
  // annotated prose, and the run found zero sources.
  it('recovers sources from web_search_call.action.sources when the model cited nothing', () => {
    expect(extractOpenAiSearchResults({
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'china us ai',
            sources: [
              { url: 'https://example.gov/a', title: 'Gov A' },
              { url: 'https://arxiv.org/abs/1', title: 'Paper' },
            ],
          },
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] },
      ],
    })).toEqual([
      { url: 'https://example.gov/a', title: 'Gov A' },
      { url: 'https://arxiv.org/abs/1', title: 'Paper' },
    ])
  })

  it('returns no sources when the response is truncated with neither citations nor sources', () => {
    expect(extractOpenAiSearchResults({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'x' } }],
    })).toEqual([])
  })

  it('prefers cited references but still adds every other consulted source', () => {
    expect(extractOpenAiSearchResults({
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://b.gov/2' }, { url: 'https://a.gov/1' }] } },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', url: 'https://a.gov/1', title: 'Cited A' }] }],
        },
      ],
    })).toEqual([
      { url: 'https://a.gov/1', title: 'Cited A' },
      { url: 'https://b.gov/2' },
    ])
  })

  it('tolerates a bare string source entry without inventing a title', () => {
    expect(extractOpenAiSearchResults({
      output: [{ type: 'web_search_call', action: { type: 'search', sources: ['https://plain.gov/x'] } }],
    })).toEqual([{ url: 'https://plain.gov/x' }])
  })
})

describe('OpenAI research provider', () => {
  it('requests the web_search tool and normalizes results to the canonical shape', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(WEB_SEARCH_RESPONSE))
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', fetch: fetchMock as any })

    const results = await provider.search('caribbean tourism ai', { limit: 8 })

    expect(results).toEqual([
      { url: 'https://www.imf.org/report', title: 'IMF Report' },
      { url: 'https://example.gov/data', title: 'Gov Data' },
    ])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(init.body as string)
    expect(body.tools).toEqual([{ type: 'web_search' }])
    // Real external research, not pretrained recall.
    expect(body.tool_choice).toBe('required')
    // Sources must not depend on the model choosing to narrate.
    expect(body.include).toEqual(['web_search_call.action.sources'])
    // Hidden reasoning must not consume the budget before sources are emitted.
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  it('reports provider identity for provenance', () => {
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', model: 'gpt-5' })
    expect(provider.name).toBe('openai:gpt-5')
    expect(provider.id).toBe('openai')
  })

  it('defaults to the model this account has proven access to', () => {
    const previous = process.env.OPENAI_RESEARCH_MODEL
    delete process.env.OPENAI_RESEARCH_MODEL
    try {
      expect(createOpenAiResearchProvider({ apiKey: 'sk-test' }).name).toBe('openai:gpt-5-mini')
    } finally {
      if (previous !== undefined) process.env.OPENAI_RESEARCH_MODEL = previous
    }
  })

  it('declares every capability continuous research requires', () => {
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test' })
    for (const capability of ['web_search', 'source_citations', 'durable_source_fetch', 'structured_output'] as const) {
      expect(provider.capabilities).toContain(capability)
    }
  })

  it('fetches the real document rather than trusting the model to relay it', async () => {
    const fetchDocument = vi.fn(async (url: string) => ({
      content: 'The actual bytes of the page.',
      title: 'Real Title',
      finalUrl: url,
      fetchedAt: '2026-08-31T12:00:00Z',
    }))
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', fetchDocument: fetchDocument as any })

    const source = await provider.fetch({ url: 'https://example.gov/data' })

    expect(fetchDocument).toHaveBeenCalledWith('https://example.gov/data')
    expect(source).toEqual({
      url: 'https://example.gov/data',
      title: 'Real Title',
      content: 'The actual bytes of the page.',
      fetchedAt: '2026-08-31T12:00:00Z',
    })
  })

  it('preserves the citation URL as canonical identity so sources dedupe across providers', async () => {
    const provider = createOpenAiResearchProvider({
      apiKey: 'sk-test',
      fetchDocument: (async (url: string) => ({
        content: 'text',
        title: 'T',
        finalUrl: 'https://example.gov/data?utm_source=redirect',
        fetchedAt: '2026-08-31T12:00:00Z',
      })) as any,
    })

    const source = await provider.fetch({ url: 'https://example.gov/data', title: 'Cited Title' })
    expect(source.url).toBe('https://example.gov/data')
    expect(source.title).toBe('Cited Title')
  })

  it('surfaces the HTTP status so billing failures are classifiable, not guessed from prose', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' } }),
      { status: 429 },
    ))
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', fetch: fetchMock as any })

    await expect(provider.search('q')).rejects.toMatchObject({ httpStatus: 429 })
  })

  it('reports a missing API key as an auth failure rather than a malformed request', async () => {
    const provider = createOpenAiResearchProvider({ apiKey: undefined, fetch: vi.fn() as any })
    const originalKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      expect(await provider.checkHealth()).toEqual({ usable: false, detail: 'OPENAI_API_KEY is not set.' })
      await expect(provider.search('q')).rejects.toMatchObject({ authExpired: true })
    } finally {
      if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey
    }
  })

  it('flags an output-token truncation so synthesis retries instead of persisting a half claim', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      model: 'gpt-5',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"claims":[' }] }],
    }))
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', fetch: fetchMock as any })

    const result = await provider.complete({ system: 's', user: 'u', maxOutputTokens: 100 })
    expect(result.truncated).toBe(true)
  })

  it('reports usage for cost attribution', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      model: 'gpt-5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    }))
    const provider = createOpenAiResearchProvider({ apiKey: 'sk-test', fetch: fetchMock as any })

    const result = await provider.complete({ system: 's', user: 'u', maxOutputTokens: 8192 })
    expect(result.usage).toEqual({ model: 'gpt-5', inputTokens: 1200, outputTokens: 300 })

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    // Synthesis tokens belong to the JSON contract, not to hidden reasoning.
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.max_output_tokens).toBe(8192)
  })
})
