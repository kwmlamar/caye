import type { NavItem, ChannelConfig, Tone, DelayOption, TeamMember, PlanFeature } from '@/lib/types'

export const SET_NAV: NavItem[] = [
  { id: 'profile', label: 'Profile', sub: 'Business identity', icon: 'biz' },
  { id: 'channels', label: 'Channels', sub: '5 connections', icon: 'ch' },
  { id: 'caye', label: 'Caye AI', sub: 'Auto-reply assistant', icon: 'caye', badge: 'AI' },
  { id: 'health', label: 'Caye health', sub: 'What she\'s been doing', icon: 'pulse' },
  { id: 'services', label: 'Services', sub: 'Tours & offerings', icon: 'svc' },
  { id: 'notifications', label: 'Notifications', sub: 'Alerts & summaries', icon: 'bell' },
  { id: 'team', label: 'Team', sub: '4 members', icon: 'ppl' },
  { id: 'billing', label: 'Billing', sub: 'Growth · trial 12d', icon: 'card' },
]

export const CHANNELS: ChannelConfig[] = [
  { id: 'wa', name: 'WhatsApp Business', handle: '+501 622-4418', bg: '#22c55e', label: 'W', on: true, stat: { last7: 142, response: '1m 24s' }, since: 'Connected Mar 2024' },
  { id: 'ig', name: 'Instagram', handle: '@karendas.tours', bg: 'linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)', label: 'IG', on: true, stat: { last7: 38, response: '4m 02s' }, since: 'Connected Aug 2024' },
  { id: 'fb', name: 'Messenger', handle: 'fb.me/karendastours', bg: '#3b82f6', label: 'M', on: true, stat: { last7: 21, response: '2m 47s' }, since: 'Connected Mar 2024' },
  { id: 'em', name: 'Email', handle: 'karenda@karendastours.com', bg: 'var(--tc-ink)', label: '@', on: true, stat: { last7: 56, response: '12m 30s' }, since: 'Connected Mar 2024' },
  { id: 'sms', name: 'SMS', handle: 'Not connected', bg: '#6b7681', label: '#', on: false, note: 'Cruise-line guests often arrive without WhatsApp data. SMS catches them at the dock.' },
]

export const TONES: Tone[] = [
  { id: 'friendly', icon: '🌴', title: 'Friendly', desc: 'Warm, conversational. Uses guest\'s name. Light use of "!" — fits cruise day-trippers.' },
  { id: 'professional', icon: '📋', title: 'Professional', desc: 'Polished, concise, fact-first. Good for tour operators, corporate clients, hotel concierges.' },
  { id: 'casual', icon: '🤙', title: 'Casual', desc: 'Relaxed, local. Caye uses island phrasing — "no worries, mon" stays in.' },
]

export const DELAYS: DelayOption[] = [
  { id: '0', label: 'Instant' },
  { id: '30', label: '30s' },
  { id: '60', label: '1m' },
  { id: '120', label: '2m' },
  { id: '300', label: '5m' },
]

export const TEAM: TeamMember[] = [
  { name: 'Karenda Munroe', email: 'karenda@karendastours.com', role: 'Owner', status: 'active', you: true },
  { name: 'Devon Reyes', email: 'devon@karendastours.com', role: 'Manager', status: 'active' },
  { name: 'Marisol Choc', email: 'marisol@karendastours.com', role: 'Tour guide', status: 'active' },
  { name: 'Jamal Williams', email: 'jamal.w@gmail.com', role: 'Tour guide', status: 'pending' },
]

export const PLAN_FEATURES: PlanFeature[] = [
  { in: true, label: '5 connected channels', sub: 'WhatsApp · Instagram · Messenger · Email · SMS' },
  { in: true, label: 'Caye AI auto-reply', sub: 'Unlimited messages · all 5 channels' },
  { in: true, label: 'Up to 8 team members', sub: 'Roles + tour-guide scoped access' },
  { in: true, label: 'Booking page + payments', sub: 'Stripe & Wise · 1.9% transaction fee' },
  { in: true, label: 'Daily summary email', sub: 'Tomorrow\'s tours, today\'s bookings' },
  { in: false, label: 'Multiple locations', sub: 'Run more than one operation from one inbox' },
  { in: false, label: 'Caye AI custom voice clone', sub: 'Train Caye on 50 of your past replies' },
  { in: false, label: 'Cruise-line API integration', sub: 'Pull manifests from Carnival, Royal Caribbean, NCL' },
]
