import { describe, it, expect } from 'vitest'
import { categorizeTool, groupToolsByCategory } from './tool-categories'

describe('categorizeTool', () => {
  it('groups customer-communication tools', () => {
    expect(categorizeTool('send_reply').label).toBe('Customer communication')
    expect(categorizeTool('get_customer').label).toBe('Customer communication')
    expect(categorizeTool('get_customer_history').label).toBe('Customer communication')
    expect(categorizeTool('search_threads').label).toBe('Customer communication')
    expect(categorizeTool('mark_handled').label).toBe('Customer communication')
  })

  it('groups booking/calendar tools', () => {
    expect(categorizeTool('get_calendar').label).toBe('Bookings & calendar')
    expect(categorizeTool('get_zoho_calendar').label).toBe('Bookings & calendar')
    expect(categorizeTool('check_availability').label).toBe('Bookings & calendar')
    expect(categorizeTool('add_blackout_date').label).toBe('Bookings & calendar')
  })

  it('groups pricing/payment tools', () => {
    expect(categorizeTool('update_service_price').label).toBe('Pricing & payments')
    expect(categorizeTool('lookup_price').label).toBe('Pricing & payments')
    expect(categorizeTool('send_payment_confirmation').label).toBe('Pricing & payments')
    expect(categorizeTool('get_revenue').label).toBe('Pricing & payments')
  })

  it('groups business-knowledge tools', () => {
    expect(categorizeTool('add_business_fact').label).toBe('Business knowledge')
    expect(categorizeTool('add_standing_rule').label).toBe('Business knowledge')
    expect(categorizeTool('get_services').label).toBe('Business knowledge')
    expect(categorizeTool('update_business_hours').label).toBe('Business knowledge')
  })

  it('groups voice/team tools', () => {
    expect(categorizeTool('update_voice_register').label).toBe('Voice & team')
    expect(categorizeTool('add_team_member').label).toBe('Voice & team')
  })

  it('groups outreach tools', () => {
    expect(categorizeTool('run_outreach').label).toBe('Outreach')
    expect(categorizeTool('create_outreach_leads').label).toBe('Outreach')
  })

  it('groups channel tools', () => {
    expect(categorizeTool('get_channel_status').label).toBe('Channels')
    expect(categorizeTool('get_connect_link').label).toBe('Channels')
  })

  it('groups scheduling tools', () => {
    expect(categorizeTool('schedule_reminder').label).toBe('Scheduling & reminders')
  })

  it('groups driver/logistics tools', () => {
    expect(categorizeTool('get_my_assignments').label).toBe('Driver & logistics')
    expect(categorizeTool('notify_driver').label).toBe('Driver & logistics')
  })

  it('groups admin/ops tools', () => {
    expect(categorizeTool('get_cron_health').label).toBe('Operations')
    expect(categorizeTool('trigger_cron').label).toBe('Operations')
    expect(categorizeTool('set_workspace_autonomy').label).toBe('Operations')
  })

  it('falls back to Other for unrecognized names', () => {
    expect(categorizeTool('some_future_tool_xyz').label).toBe('Other')
  })
})

describe('groupToolsByCategory', () => {
  it('groups and orders by category, omitting empty buckets', () => {
    const tools = [
      { name: 'send_reply' },
      { name: 'get_calendar' },
      { name: 'get_customer' },
      { name: 'trigger_cron' },
    ]
    const grouped = groupToolsByCategory(tools)
    const labels = grouped.map((g) => g.category.label)
    expect(labels).toEqual(['Customer communication', 'Bookings & calendar', 'Operations'])
    expect(grouped.find((g) => g.category.label === 'Customer communication')?.tools).toHaveLength(2)
  })

  it('returns an empty array for an empty tool list', () => {
    expect(groupToolsByCategory([])).toEqual([])
  })
})
