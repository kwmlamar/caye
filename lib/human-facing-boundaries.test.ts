import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('human-facing presentation boundaries', () => {
  it('sanitizes dashboard replies before persistence and JSON return', () => {
    const route = source('app/api/caye/chat/route.ts')
    const sanitizeAt = route.indexOf('const safeReply = sanitizeHumanFacingText(reply)')
    const persistAt = route.indexOf('content: safeReply', sanitizeAt)
    const returnAt = route.indexOf('reply: safeReply', persistAt)

    expect(route).toContain('HUMAN_FACING_VOICE_INSTRUCTIONS')
    expect(sanitizeAt).toBeGreaterThan(-1)
    expect(persistAt).toBeGreaterThan(sanitizeAt)
    expect(returnAt).toBeGreaterThan(persistAt)
  })

  it('sanitizes dashboard customer sends and previews', () => {
    const route = source('app/api/caye/chat/route.ts')
    expect(route).toContain("const safeBody = sanitizeHumanFacingText(body ?? '')")
    expect(route).toContain("dispatchOperatorReply(conversation_id, safeBody, 'caye-dashboard')")
    expect(route).toContain('preview: safeBody.slice(0, 160)')
    expect(route).toContain("const subject = sanitizeHumanFacingText(input.subject ?? '')")
  })

  it('uses one sanitized body for channel provider send, persistence, and preview', () => {
    const dispatch = source('lib/whatsapp/channel-dispatch.ts')
    expect(dispatch).toContain('const sanitizedText = sanitizeHumanFacingText(text)')
    expect(dispatch).toContain('let outboundBody = sanitizedText')
    expect(dispatch).toContain('sendMetaMessage(conv.customer_id, outboundBody')
    expect(dispatch).toContain('content: outboundBody')
    expect(dispatch).toContain('last_message_preview: outboundBody.slice(0, 100)')
  })

  it('sanitizes all Zoho human text while routing identities stay separate', () => {
    const email = source('lib/email-ai.ts')
    expect(email.match(/sanitizeHumanFacingEmail\(\{ to, subject, body \}\)/g)).toHaveLength(3)
    expect(email).toContain('toAddress: clean.to')
    expect(email).toContain('subject: clean.subject')
    expect(email).toContain('content: clean.body')
  })
})
