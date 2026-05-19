"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { signUp, signInWithOAuth } from "@/lib/supabase"

export default function SignupPage() {
  const router = useRouter()
  const [fullName, setFullName] = useState("")
  const [businessName, setBusinessName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError("Password must be at least 8 characters")
      return
    }
    setLoading(true)
    setError(null)

    const { data, error } = await signUp(email, password, businessName, fullName)
    setLoading(false)

    if (error) { setError(error); return }

    // If email confirmation is required, show success state
    if (data?.user && !data.session) {
      setSuccess(true)
      return
    }

    // Auto-confirmed (e.g. email confirmation disabled in Supabase)
    if (data?.user) {
      router.push(`/dashboard/${data.user.id}`)
    }
  }

  const handleOAuth = () => {
    signInWithOAuth('google', {
      redirectTo: `${window.location.origin}/auth/callback`
    })
  }

  if (success) {
    return (
      <div className="login-root">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="login-brand" style={{ justifyContent: 'center' }}>
            <span className="sb-mark" style={{ width: 36, height: 36, fontSize: 17 }}>C</span>
          </div>
          <h1 className="login-heading" style={{ textAlign: 'center' }}>Check your email</h1>
          <p style={{ fontSize: 13.5, color: 'var(--tc-ink-mute)', lineHeight: 1.6, marginTop: 8 }}>
            We sent a confirmation link to <strong style={{ color: 'var(--tc-ink)' }}>{email}</strong>.
            Click it to activate your account and get started.
          </p>
          <Link href="/login" className="login-oauth" style={{ marginTop: 24, display: 'flex' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-brand">
          <span className="sb-mark" style={{ width: 36, height: 36, fontSize: 17 }}>C</span>
          <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--tc-ink)' }}>Caye</span>
        </div>

        <h1 className="login-heading">Create your account</h1>
        <p className="login-sub">14-day free trial · No credit card required</p>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>Your name</label>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Karenda Munroe"
              required
              autoComplete="name"
            />
          </div>
          <div className="login-field">
            <label>Business name</label>
            <input
              type="text"
              value={businessName}
              onChange={e => setBusinessName(e.target.value)}
              placeholder="Island Tours Co."
              required
              autoComplete="organization"
            />
          </div>
          <div className="login-field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="login-divider"><span>or</span></div>

        <button className="login-oauth" onClick={handleOAuth}>
          <svg width={18} height={18} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--tc-ink-mute)', marginTop: 20 }}>
          Already have an account?{' '}
          <Link href="/login" style={{ color: 'var(--tc-teal)', fontWeight: 600, textDecoration: 'none' }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
