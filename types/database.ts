// Database types for Caye / TropiTech Supabase schema

export type CustomerStatus = 'active' | 'inactive' | 'suspended' | 'trial'
export type NotificationLevel = 'all' | 'milestones'
export type CustomerPlan = 'free' | 'starter' | 'medium' | 'pro' | 'elite' | 'tropic' | 'island_pro' | 'professional' | 'enterprise' | 'coconut'
export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'archived'
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent'
export type MessageDirection = 'inbound' | 'outbound'
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type TemplateCategory = 'marketing' | 'utility' | 'authentication'
export type TemplateApprovalStatus = 'pending' | 'approved' | 'rejected'
export type TriggerType = 'keyword' | 'new_conversation' | 'business_hours' | 'after_hours' | 'all_messages'
export type ActionType = 'send_message' | 'send_template' | 'add_tag' | 'assign_to' | 'assign_to_human' | 'mark_resolved'
export type NotificationType = 'new_message' | 'mention' | 'assignment' | 'system'

export interface BusinessHours {
  monday?: { start: string; end: string; enabled: boolean }
  tuesday?: { start: string; end: string; enabled: boolean }
  wednesday?: { start: string; end: string; enabled: boolean }
  thursday?: { start: string; end: string; enabled: boolean }
  friday?: { start: string; end: string; enabled: boolean }
  saturday?: { start: string; end: string; enabled: boolean }
  sunday?: { start: string; end: string; enabled: boolean }
}

// Customer (Business / Workspace owner) table
export interface Customer {
  id: string
  business_name: string
  has_onboarded: boolean
  ai_voice_profile?: unknown
  ai_autopilot_enabled: boolean
  default_tour_start_time: string | null
  notification_level: NotificationLevel
  business_brief?: unknown
  voice_profile_updated_at: string | null
  owner_messages_since_profile_update: number
  booking_url: string | null
  website_url: string | null
  proactive_nudges_enabled: boolean
  full_name: string | null
  contact_email: string
  password_hash?: string
  status: CustomerStatus
  plan: CustomerPlan
  auto_reply_enabled: boolean
  auto_reply_message: string | null
  business_hours: BusinessHours | null
  timezone: string
  phone_number: string | null
  whatsapp_phone_id: string | null
  whatsapp_business_id: string | null
  facebook_id: string | null
  avatar_url: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_price_id: string | null
  stripe_current_period_end: string | null
  trial_ends_at: string | null
  billing_period: 'monthly' | 'annual' | null
  created_at: string
  updated_at: string
}

// Contact table
export interface Contact {
  id: string
  customer_id: string
  phone_number: string | null
  name: string | null
  email: string | null
  tags: string[]
  notes: string | null
  first_message_at: string | null
  last_message_at: string | null
  total_messages_sent: number
  total_messages_received: number
  is_blocked: boolean
  opted_out: boolean
  channel_type: 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'sms' | null
  channel_id: string | null
  avatar_url: string | null
  ai_contact_profile: ContactStyleProfile | null
  inbound_message_count: number
  created_at: string
  updated_at: string
}

// Customer-side communication style learned from a contact's inbound messages.
// Used by Caye to mirror the customer's energy in replies.
export interface ContactStyleProfile {
  formality: 'casual' | 'formal'
  message_style: 'brief' | 'chatty' | 'detailed'
  language_notes: string
}

// Conversation table
export interface Conversation {
  id: string
  customer_id: string
  contact_id: string
  status: ConversationStatus
  assigned_to: string | null
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  tags: string[]
  priority: ConversationPriority
  created_at: string
  updated_at: string
  contact?: Contact
  messages?: Message[]
}

// Message table
export interface Message {
  id: string
  conversation_id: string
  customer_id: string
  twilio_message_sid: string | null
  whatsapp_message_id: string | null
  direction: MessageDirection
  from_number: string
  to_number: string
  body: string | null
  media_url: string | null
  media_type: string | null
  status: MessageStatus
  template_name: string | null
  is_automated: boolean
  sent_by: string | null
  sent_at: string
  delivered_at: string | null
  read_at: string | null
  error_message: string | null
  created_at: string
}

// Message Template table
export interface MessageTemplate {
  id: string
  customer_id: string
  name: string
  category: TemplateCategory
  language: string
  body: string
  variables: string[]
  header_text: string | null
  footer_text: string | null
  buttons: TemplateButton[] | null
  approval_status: TemplateApprovalStatus
  rejection_reason: string | null
  times_used: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

export interface TemplateButton {
  type: 'url' | 'phone' | 'quick_reply'
  text: string
  url?: string
  phone?: string
}

// Automation Rule table
export interface AutomationRule {
  id: string
  customer_id: string
  name: string
  is_enabled: boolean
  trigger_type: TriggerType
  trigger_value: string | null
  action_type: ActionType
  action_value: string
  priority: number
  times_triggered: number
  last_triggered_at: string | null
  created_at: string
  updated_at: string
}

// Notification table
export interface Notification {
  id: string
  customer_id: string
  type: NotificationType
  title: string
  message: string
  read: boolean
  link: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// Team Member table
export interface TeamMember {
  id: string
  customer_id: string
  user_id: string | null
  role: 'owner' | 'admin' | 'agent'
  name: string
  email: string
  status: 'pending' | 'active' | 'deactivated'
  is_active: boolean
  invited_at: string
  created_at: string
}

// Workspace member table
export interface WorkspaceMember {
  workspace_id: string
  user_id: string
  role: 'owner' | 'admin'
  created_at?: string
}

// Joined types
export interface ConversationWithContact extends Conversation {
  contact: Contact
}

export interface MessageWithSender extends Message {
  sender_name?: string
}

// Analytics types
export interface DailyStats {
  date: string
  messages_sent: number
  messages_received: number
  conversations_started: number
  conversations_resolved: number
  avg_response_time_seconds: number
}

// API response helpers
export interface ApiResponse<T> {
  data: T | null
  error: string | null
}

export interface PaginatedResponse<T> {
  data: T[]
  count: number
  page: number
  pageSize: number
  hasMore: boolean
}
