'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'

// Same user_metadata.full_name field lib/supabase.ts already reads
// elsewhere (getUser's profile-seed path) — not a new source of truth,
// just read client-side for the greeting. Falls back to the email local
// part rather than a generic "Founder" when no name was ever set.
export function useFounderIdentity() {
  const [firstName, setFirstName] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session || cancelled) return
      const meta = session.user.user_metadata as { full_name?: string; name?: string } | undefined
      const fullName = (meta?.full_name || meta?.name || '').trim()
      const derivedFromEmail = session.user.email?.split('@')[0]
      setFirstName(fullName ? fullName.split(/\s+/)[0] : (derivedFromEmail ?? null))
      setEmail(session.user.email ?? null)
    }
    load()
    return () => { cancelled = true }
  }, [])

  return { firstName, email }
}
