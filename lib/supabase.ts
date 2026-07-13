import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type {
  Customer,
  CustomerPlan,
  Contact,
  Conversation,
  Message,
  MessageTemplate,
  AutomationRule,
  ConversationWithContact,
  Notification
} from '@/types/database'

export type {
  Customer,
  CustomerPlan,
  Contact,
  Conversation,
  Message,
  MessageTemplate,
  AutomationRule,
  ConversationWithContact,
  Notification
}

export type WaitlistEntry = {
  id?: string
  name: string
  email: string
  business_type: string
  phone?: string
  created_at?: string
}

// Singleton browser client
let supabaseInstance: SupabaseClient | null = null

export const getSupabase = () => {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!supabaseUrl || !supabaseAnonKey) {
    const msg = 'Supabase environment variables are not set. Please configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.'
    if (typeof window !== 'undefined') {
      console.error(msg)
      throw new Error(msg)
    }
    throw new Error(msg)
  }

  supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: {
        events_per_second: 10,
      },
    },
  })
  return supabaseInstance
}

export const supabase = {
  from: (...args: Parameters<SupabaseClient['from']>) => getSupabase().from(...args)
}

export const createSupabaseClient = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase environment variables are not set')
  }

  return createClient(supabaseUrl, supabaseAnonKey)
}

// ==================== AUTH FUNCTIONS ====================

export async function signUp(
  email: string,
  password: string,
  businessName: string,
  fullName: string,
  plan: CustomerPlan = 'free',
  billingPeriod: 'monthly' | 'annual' = 'monthly'
) {
  const client = getSupabase()

  const { data: authData, error: authError } = await client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
      data: {
        business_name: businessName,
        full_name: fullName,
      },
    },
  })

  if (authError) {
    return { data: null, error: authError.message }
  }

  if (authData.user) {
    const { error: customerError } = await client
      .from('customers')
      .insert({
        id: authData.user.id,
        business_name: businessName,
        full_name: fullName,
        contact_email: email,
        status: 'trial',
        plan: plan,
        timezone: 'America/Nassau',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      })

    if (customerError) {
      console.error('Error creating customer:', customerError)
    }

    const { error: memberError } = await client
      .from('workspace_members')
      .insert({
        workspace_id: authData.user.id,
        user_id: authData.user.id,
        role: 'owner',
      })

    if (memberError) {
      console.error('Error creating workspace member:', memberError)
    }
  }

  return { data: authData, error: null }
}

export async function signIn(email: string, password: string) {
  const client = getSupabase()

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return { data: null, error: error.message }
  }

  return { data, error: null }
}

export async function signOut() {
  const client = getSupabase()
  const { error } = await client.auth.signOut()
  return { error: error?.message || null }
}

export async function getSession() {
  const client = getSupabase()
  const { data: { session }, error } = await client.auth.getSession()
  return { session, error: error?.message || null }
}

export async function getUser() {
  const client = getSupabase()
  const { data: { user }, error } = await client.auth.getUser()
  return { user, error: error?.message || null }
}

export type OAuthProvider = 'google' | 'facebook'

export async function signInWithOAuth(provider: OAuthProvider, options?: { redirectTo?: string }) {
  const client = getSupabase()
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: options?.redirectTo || `${window.location.origin}/auth/callback`,
    },
  })
  return { data, error: error?.message || null }
}

/**
 * Attaches a signed-in dashboard user as owner of a workspace that was
 * created via WhatsApp-first signup (no auth user of its own yet).
 * workspace_members is a genuine many-to-many join — this deliberately
 * does not assume workspaceId === userId, unlike the default OAuth
 * signup path (see app/auth/callback/page.tsx).
 */
export async function claimWorkspace(workspaceId: string, userId: string) {
  const client = getSupabase()
  const { error } = await client
    .from('workspace_members')
    .upsert({ workspace_id: workspaceId, user_id: userId, role: 'owner' }, { onConflict: 'workspace_id,user_id' })
  return { error: error?.message || null }
}

export async function resetPassword(email: string) {
  const client = getSupabase()
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  })
  return { error: error?.message || null }
}

export async function changePassword(newPassword: string) {
  const client = getSupabase()
  const { error } = await client.auth.updateUser({ password: newPassword })
  return { error: error?.message || null }
}

// ==================== WORKSPACE HELPERS ====================

export async function getWorkspaceId(): Promise<{ customerId: string | null; error: string | null }> {
  const { user } = await getUser()
  if (!user) return { customerId: null, error: 'Not authenticated' }

  const client = getSupabase()

  if (typeof window !== 'undefined') {
    const lastActive = localStorage.getItem('lastActiveWorkspaceId')
    if (lastActive) {
      const { data } = await client
        .from('workspace_members')
        .select('workspace_id')
        .eq('workspace_id', lastActive)
        .eq('user_id', user.id)
        .single()
      if (data) return { customerId: lastActive, error: null }
    }
  }

  return { customerId: user.id, error: null }
}

// ==================== CUSTOMER FUNCTIONS ====================

export async function getCurrentCustomer(): Promise<{ data: Customer | null; error: string | null }> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()

  if (ctxErr || !customerId) {
    return { data: null, error: ctxErr || 'Workspace not found' }
  }

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single()

  return { data, error: error?.message || null }
}

export const getPersonalCustomer = async (): Promise<{ data: Customer | null; error: string | null }> => {
  const { user } = await getUser()
  if (!user) return { data: null, error: 'Not authenticated' }

  const client = getSupabase()

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error && error.code === 'PGRST116') {
    const name = user.user_metadata?.full_name || user.user_metadata?.name || ''
    const email = user.email || ''

    const updates = {
      id: user.id,
      full_name: name,
      business_name: user.user_metadata?.business_name || '',
      contact_email: email,
      status: 'trial' as const,
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    }

    const { data: newData, error: upsertError } = await client
      .from('customers')
      .upsert(updates, { onConflict: 'id' })
      .select()
      .single()

    return { data: newData as Customer, error: upsertError?.message || null }
  }

  return { data, error: error?.message || null }
}

export async function updatePersonalProfile(updates: Partial<Customer>) {
  const { user } = await getUser()
  if (!user) return { error: 'Not authenticated' }

  const client = getSupabase()
  const { error } = await client
    .from('customers')
    .update(updates)
    .eq('id', user.id)

  return { error: error?.message || null }
}

export async function updateCustomer(updates: Partial<Customer>) {
  const client = getSupabase()
  const { data: { session } } = await client.auth.getSession()

  if (!session?.access_token) {
    return { error: 'Not authenticated' }
  }

  try {
    const res = await fetch('/api/customers/update', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify(updates)
    })

    const data = await res.json()
    if (!res.ok) {
      return { error: data.error || 'Failed to update customer settings' }
    }

    return { data: data.data, error: null }
  } catch (err) {
    console.error('updateCustomer fetch error:', err)
    return { error: 'Failed to connect to server' }
  }
}

// ==================== CONTACT FUNCTIONS ====================

export async function getContacts(
  search?: string,
  tags?: string[],
  limit = 100
): Promise<{ data: Contact[]; error: string | null }> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()

  if (ctxErr || !customerId) {
    return { data: [], error: ctxErr || 'Workspace not found' }
  }

  let query = client
    .from('contacts')
    .select('*')
    .eq('customer_id', customerId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone_number.ilike.%${search}%,email.ilike.%${search}%`)
  }

  if (tags && tags.length > 0) {
    query = query.contains('tags', tags)
  }

  const { data, error } = await query

  return { data: data || [], error: error?.message || null }
}

export async function getContact(id: string): Promise<{ data: Contact | null; error: string | null }> {
  const client = getSupabase()

  const { data, error } = await client
    .from('contacts')
    .select('*')
    .eq('id', id)
    .single()

  return { data, error: error?.message || null }
}

export async function updateContact(id: string, updates: Partial<Contact>) {
  const client = getSupabase()

  const { error } = await client
    .from('contacts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)

  return { error: error?.message || null }
}

// ==================== CONVERSATION FUNCTIONS ====================

export async function getConversations(
  status?: string,
  search?: string,
  limit = 50
): Promise<{ data: ConversationWithContact[]; error: string | null }> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()

  if (ctxErr || !customerId) {
    return { data: [], error: ctxErr || 'Workspace not found' }
  }

  let query = client
    .from('conversations')
    .select(`*, contact:contacts(*)`)
    .eq('customer_id', customerId)
    .order('last_message_at', { ascending: false })
    .limit(limit)

  if (status && status !== 'all') {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  let filteredData = data || []
  if (search && filteredData.length > 0) {
    const searchLower = search.toLowerCase()
    filteredData = filteredData.filter((conv: ConversationWithContact) =>
      conv.contact?.name?.toLowerCase().includes(searchLower) ||
      conv.contact?.phone_number?.includes(search) ||
      conv.last_message_preview?.toLowerCase().includes(searchLower)
    )
  }

  return { data: filteredData as ConversationWithContact[], error: error?.message || null }
}

export async function getConversation(id: string): Promise<{ data: ConversationWithContact | null; error: string | null }> {
  const client = getSupabase()

  const { data, error } = await client
    .from('conversations')
    .select(`*, contact:contacts(*)`)
    .eq('id', id)
    .single()

  return { data: data as ConversationWithContact, error: error?.message || null }
}

export async function updateConversation(id: string, updates: Partial<Conversation>) {
  const client = getSupabase()

  const { error } = await client
    .from('conversations')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)

  return { error: error?.message || null }
}

// ==================== MESSAGE FUNCTIONS ====================

export async function getMessages(
  conversationId: string,
  limit = 50,
  before?: string
): Promise<{ data: Message[]; error: string | null }> {
  const client = getSupabase()

  let query = client
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(limit)

  if (before) {
    query = query.lt('sent_at', before)
  }

  const { data, error } = await query

  return {
    data: (data || []).reverse(),
    error: error?.message || null
  }
}

// ==================== REALTIME SUBSCRIPTIONS ====================

export function subscribeToMessages(
  conversationId: string,
  callback: (message: Message, eventType: 'INSERT' | 'UPDATE') => void
) {
  const client = getSupabase()

  const channel = client
    .channel(`messages:${conversationId}:${Math.random().toString(36).substring(7)}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => { callback(payload.new as Message, 'INSERT') }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => { callback(payload.new as Message, 'UPDATE') }
    )
    .subscribe()

  return () => { client.removeChannel(channel) }
}

export function subscribeToConversations(
  customerId: string,
  callback: (conversation: Conversation) => void
) {
  const client = getSupabase()

  const channel = client
    .channel(`conversations:${customerId}:${Math.random().toString(36).substring(7)}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversations', filter: `customer_id=eq.${customerId}` },
      (payload) => { callback(payload.new as Conversation) }
    )
    .subscribe()

  return () => { client.removeChannel(channel) }
}

// ==================== NOTIFICATION FUNCTIONS ====================

export async function getNotifications(
  limit = 20,
  offset = 0
): Promise<{ data: Notification[]; error: string | null }> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()

  if (ctxErr || !customerId) {
    return { data: [], error: ctxErr || 'Workspace not found' }
  }

  const { data, error } = await client
    .from('notifications')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return { data: data || [], error: error?.message || null }
}

export async function markNotificationAsRead(notificationId: string) {
  const client = getSupabase()

  const { error } = await client
    .from('notifications')
    .update({ read: true })
    .eq('id', notificationId)

  return { error: error?.message || null }
}
