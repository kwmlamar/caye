'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isFounderUserId } from '@/lib/founder'
import { internalRedirectPath } from '@/lib/internal-redirect'
import { getSupabase } from '@/lib/supabase'

type ConsentRequest = {
  authorizationId: string
  clientName: string
  clientUri: string
  redirectUri: string
  scope: string
}

function ConsentFallback() {
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#FAF7F2' }}>Loading authorization…</main>
}

export default function OAuthConsentPage() {
  return <Suspense fallback={<ConsentFallback />}><OAuthConsentInner /></Suspense>
}

function OAuthConsentInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const authorizationId = searchParams.get('authorization_id')
  const [request, setRequest] = useState<ConsentRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!authorizationId) {
      setError('This authorization request is invalid or has expired.')
      return
    }

    const client = getSupabase()
    void (async () => {
      const { data: { user }, error: userError } = await client.auth.getUser()
      if (userError || !user) {
        const continuation = internalRedirectPath(`/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`)
        router.replace(`/login?next=${encodeURIComponent(continuation ?? '/oauth/consent')}`)
        return
      }

      // This is consent UI only. The MCP resource independently validates the
      // OAuth bearer and maps the verified user to founder authority server-side.
      if (!isFounderUserId(user.id)) {
        const { data } = await client.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
        if (data?.redirect_url) window.location.assign(data.redirect_url)
        else setError('This Caye account is not authorized to use the founder MCP.')
        return
      }

      const { data, error: detailsError } = await client.auth.oauth.getAuthorizationDetails(authorizationId)
      if (detailsError || !data) {
        setError('This authorization request is invalid or has expired.')
        return
      }
      if ('redirect_url' in data) {
        window.location.assign(data.redirect_url)
        return
      }
      if (data.user.id !== user.id) {
        setError('This authorization request does not belong to the signed-in account.')
        return
      }
      setRequest({
        authorizationId: data.authorization_id,
        clientName: data.client.name,
        clientUri: data.client.uri,
        redirectUri: data.redirect_uri,
        scope: data.scope,
      })
    })()
  }, [authorizationId, router])

  async function decide(approved: boolean) {
    if (!request || submitting) return
    setSubmitting(true)
    setError(null)
    const client = getSupabase()
    const result = approved
      ? await client.auth.oauth.approveAuthorization(request.authorizationId, { skipBrowserRedirect: true })
      : await client.auth.oauth.denyAuthorization(request.authorizationId, { skipBrowserRedirect: true })
    if (result.data?.redirect_url) {
      window.location.assign(result.data.redirect_url)
      return
    }
    setSubmitting(false)
    setError('Caye could not complete this authorization request. Please return to ChatGPT and try again.')
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#FAF7F2' }}>
      <section style={{ width: 'min(100%, 520px)', padding: 32, borderRadius: 16, background: '#fff', boxShadow: '0 20px 50px rgba(14,26,26,.12)' }}>
        <p style={{ color: '#0f5a4e', fontWeight: 700, letterSpacing: '.08em', fontSize: 12, textTransform: 'uppercase' }}>Caye founder access</p>
        <h1 style={{ marginTop: 12, fontSize: 28 }}>Connect ChatGPT to Caye?</h1>
        {request && <>
          <p style={{ marginTop: 12, color: '#5e5a52' }}>
            <strong>{request.clientName}</strong> is requesting access to Caye&apos;s read-only founder MCP tools.
          </p>
          <dl style={{ marginTop: 20, display: 'grid', gap: 12, color: '#5e5a52', fontSize: 14 }}>
            <div><dt style={{ fontWeight: 700, color: '#121212' }}>Requested scopes</dt><dd>{request.scope || 'No scopes requested'}</dd></div>
            <div><dt style={{ fontWeight: 700, color: '#121212' }}>Returns to</dt><dd style={{ overflowWrap: 'anywhere' }}>{request.redirectUri}</dd></div>
          </dl>
          <p style={{ marginTop: 20, color: '#5e5a52', fontSize: 14 }}>This connection can read the four listed MCP tools only. It cannot send messages, change data, or gain additional Caye authority.</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 28 }}>
            <button type="button" disabled={submitting} onClick={() => void decide(false)} style={{ padding: '10px 16px', border: '1px solid #d7d2ca', borderRadius: 8 }}>Cancel</button>
            <button type="button" disabled={submitting} onClick={() => void decide(true)} style={{ padding: '10px 16px', borderRadius: 8, background: '#0f5a4e', color: '#fff' }}>{submitting ? 'Connecting…' : 'Allow read-only access'}</button>
          </div>
        </>}
        {!request && !error && <p style={{ marginTop: 16, color: '#5e5a52' }}>Checking the authorization request…</p>}
        {error && <p role="alert" style={{ marginTop: 16, color: '#b42318' }}>{error}</p>}
      </section>
    </main>
  )
}
