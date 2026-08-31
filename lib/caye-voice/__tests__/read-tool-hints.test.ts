import { describe, expect, it } from 'vitest'
import { voiceReadToolHints } from '../read-tool-hints'

describe('voiceReadToolHints', () => {
  it('narrows obvious service reads', () => {
    expect(voiceReadToolHints('What tours do we offer?')).toEqual(['get_services'])
    expect(voiceReadToolHints('Which services are available?')).toEqual(['get_services'])
  })

  it('narrows common operational reads', () => {
    expect(voiceReadToolHints('What bookings do we have today?')).toEqual(['get_recent_bookings'])
    expect(voiceReadToolHints('How much revenue today?')).toEqual(['get_revenue'])
    expect(voiceReadToolHints('Is WhatsApp connected?')).toEqual(['get_channel_status'])
    expect(voiceReadToolHints('Who is on the team?')).toEqual(['get_team_members'])
    expect(voiceReadToolHints('What are our current goals?')).toEqual(['list_active_goals'])
  })

  it('fails open to the full tool surface for mutations and compound work', () => {
    expect(voiceReadToolHints('What tours do we offer and then add a new one?')).toBeUndefined()
    expect(voiceReadToolHints('Update the price of the island tour')).toBeUndefined()
    expect(voiceReadToolHints('Check bookings and also message the customer')).toBeUndefined()
  })

  it('fails open for broad or ambiguous questions', () => {
    expect(voiceReadToolHints('How is the business doing?')).toBeUndefined()
    expect(voiceReadToolHints('What should we focus on?')).toBeUndefined()
  })
})
