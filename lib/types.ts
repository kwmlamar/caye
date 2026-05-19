export type ChannelType = 'wa' | 'ig' | 'fb' | 'em'
export type CayeStatus = 'replied' | 'held' | 'drafted' | 'none'
export type BookingStatus = 'confirmed' | 'pending' | 'completed'

export interface ThreadMessage {
  side: 'in' | 'out' | 'caye-action'
  text: string
  time?: string
  cayeDrafted?: boolean
  sentAs?: string
}

export interface Conversation {
  id: string
  name: string
  role: string
  channel: ChannelType
  time: string
  preview: string
  unread: number
  cayeStatus: CayeStatus
  cayeNote: string
  pinned?: boolean
  thread?: ThreadMessage[]
}

export interface Contact {
  id: string
  name: string
  channel: ChannelType
  phone: string
  email: string
  bookings: number
  lastSeen: string
  origin: string
  tags: string[]
}

export interface ContactBooking {
  date: string
  tour: string
  guests: number
  status: BookingStatus
  source: string
}

export interface Booking {
  day: number
  start: string
  end: string
  name: string
  tour: string
  guests: number
  status: 'confirmed' | 'pending'
  caye?: boolean
  ship?: string
}

export interface WeekDay {
  dow: string
  date: string
}

export interface CayeBullet {
  ch: ChannelType
  who: string
  reason: string
  time: string
}

export interface CayeMessage {
  from: 'user' | 'caye'
  text: string
  bullets?: CayeBullet[]
  footer?: string
}

export interface CayeHeldItem {
  who: string
  channel: ChannelType
  reason: string
  time: string
}

// Settings types

export interface NavItem {
  id: string
  label: string
  sub: string
  icon: string
  badge?: string
}

export interface ChannelConfig {
  id: string
  name: string
  handle: string
  bg: string
  label: string
  on: boolean
  stat?: { last7: number; response: string }
  since?: string
  note?: string
}

export interface TeamMember {
  name: string
  email: string
  role: string
  status: 'active' | 'pending'
  you?: boolean
}

export interface PlanFeature {
  in: boolean
  label: string
  sub: string
}

export interface Tone {
  id: string
  icon: string
  title: string
  desc: string
}

export interface DelayOption {
  id: string
  label: string
}

export interface NotificationPrefs {
  push: boolean
  email: boolean
}

export type Screen = 'chats' | 'contacts' | 'calendar'
export type SettingsSection = 'profile' | 'channels' | 'caye' | 'notifications' | 'team' | 'billing'
export type ActiveSection = Screen | 'settings'
