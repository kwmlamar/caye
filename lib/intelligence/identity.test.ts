import { describe, expect, it } from 'vitest'
import { intelligenceSemanticKey, normalizeIntelligenceStatement, scopeKey } from './identity'
import { validateIntelligenceFinding } from './ingest'

describe('intelligence identity and epistemic safeguards',()=>{
  it('normalizes deterministic equivalent formatting',()=>{
    expect(normalizeIntelligenceStatement('  OpenAI   plans “X” in 2027. ')).toBe('openai plans x in 2027.')
    expect(intelligenceSemanticKey({domain:'ai',topic:'OpenAI X',claim:'OpenAI plans “X” in 2027.'}))
      .toBe(intelligenceSemanticKey({domain:'ai',topic:'OpenAI X',claim:'  openai plans x in 2027. '}))
  })
  it('keeps scopes distinct to prevent cross-workspace merging',()=>{
    expect(scopeKey({kind:'workspace',workspaceId:'a'})).not.toBe(scopeKey({kind:'workspace',workspaceId:'b'}))
    expect(scopeKey({kind:'global'})).not.toBe(scopeKey({kind:'operator'}))
  })
  it('rejects unsupported observed facts',()=>{
    expect(()=>validateIntelligenceFinding({scope:{kind:'global'},domain:'ai',topic:'x',claim:'x happened',epistemicType:'observed_source_fact'})).toThrow(/supporting evidence/)
  })
  it('permits explicitly labelled unsupported inference without laundering it into fact',()=>{
    expect(()=>validateIntelligenceFinding({scope:{kind:'global'},domain:'ai',topic:'x',claim:'x may imply y',epistemicType:'inference'})).not.toThrow()
  })
  it('requires workspace id for private intelligence',()=>{
    expect(()=>scopeKey({kind:'workspace',workspaceId:''})).toThrow(/workspaceId/)
  })
})
