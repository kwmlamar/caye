"use client"

import { useState, useEffect, useRef, FormEvent } from "react"
import { useRouter } from "next/navigation"
import { getSession, getSupabase } from "@/lib/supabase"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Question {
  id: string
  field: string
  question: string
  suggestedAnswer: string
}

interface BusinessProfile {
  system_prompt: string
  tone: string
  pricing_info: string
  common_questions: string[]
  cancellation_policy: string
  escalation_rules: string
  never_say: string
}

interface VoiceProfile {
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
}

interface Message {
  id: string
  role: 'caye' | 'user'
  text: string
}

type Phase = 'loading' | 'chatting' | 'synthesizing' | 'summary' | 'error'
type VoiceSamplePhase = 'idle' | 'showing' | 'submitting' | 'confirmed'

interface Props {
  questions: Question[]
  workspaceIdHint?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function CayeAvatar() {
  return (
    <div style={{
      width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
      background: 'conic-gradient(from 140deg, #1e6157 0%, #f4b942 55%, #e85a3c 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em',
    }}>C</div>
  )
}

function TypingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <CayeAvatar />
      <div style={{
        background: '#1c2830', border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '16px 16px 16px 4px',
        padding: '12px 16px', display: 'inline-flex', gap: 5, alignItems: 'center',
      }}>
        {[0, 160, 320].map((delay, i) => (
          <span
            key={i}
            className="typing-dot"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

function ProgressPill({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'rgba(255,255,255,0.06)', borderRadius: 999,
      padding: '5px 12px 5px 8px',
      border: '1px solid rgba(255,255,255,0.1)',
    }}>
      <div style={{
        width: 64, height: 4, borderRadius: 2,
        background: 'rgba(255,255,255,0.12)', overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 2,
          background: 'linear-gradient(90deg, #1e6157, #f4b942)',
          transition: 'width 0.4s ease',
        }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.06em' }}>
        {current} / {total}
      </span>
    </div>
  )
}

function SummarySkeleton() {
  return (
    <div style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'conic-gradient(from 140deg, #1e6157 0%, #f4b942 55%, #e85a3c 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, fontWeight: 700, color: '#fff',
          animation: 'spin 2s linear infinite',
        }}>C</div>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', textAlign: 'center', maxWidth: 240 }}>
          Building your profile with Claude…
        </p>
      </div>
      {[100, 70, 85, 60].map((w, i) => (
        <div key={i} style={{
          width: `${w}%`, maxWidth: 480, height: 12, borderRadius: 6,
          background: 'rgba(255,255,255,0.06)',
          animation: `shimmer 1.8s ease-in-out ${i * 200}ms infinite`,
        }} />
      ))}
    </div>
  )
}

function ProfileSummary({ profile, onConfirm }: { profile: BusinessProfile; onConfirm: () => void }) {
  const sections = [
    { label: 'Tone & Voice', value: profile.tone },
    { label: 'Pricing & Booking', value: profile.pricing_info },
    { label: 'Cancellation Policy', value: profile.cancellation_policy },
    { label: 'Escalation Rules', value: profile.escalation_rules },
    { label: 'Never Say', value: profile.never_say },
  ]

  return (
    <div style={{
      background: 'var(--tc-bg-soft, #fff)',
      borderRadius: 20, overflow: 'hidden',
      boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
      width: '100%', maxWidth: 560,
      margin: '0 auto',
    }}>
      <div style={{
        background: '#0b1419', padding: '20px 24px',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
          background: 'conic-gradient(from 140deg, #1e6157 0%, #f4b942 55%, #e85a3c 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, color: '#fff',
        }}>C</div>
        <div>
          <p style={{ fontSize: 15, fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
            Caye is ready
          </p>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
            Here&apos;s how I&apos;ll represent your business
          </p>
        </div>
      </div>

      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{
          background: 'var(--tc-bg-app, #faf8f3)',
          border: '1px solid var(--tc-line, rgba(11,20,25,0.08))',
          borderRadius: 12, padding: '14px 16px', marginBottom: 14,
        }}>
          <p style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--tc-teal, #1e6157)', marginBottom: 6,
          }}>System Prompt Preview</p>
          <p style={{ fontSize: 13, color: 'var(--tc-ink-soft, #2d3a44)', lineHeight: 1.55 }}>
            {profile.system_prompt}
          </p>
        </div>

        {sections.map(s => (
          <div key={s.label} style={{
            display: 'grid', gridTemplateColumns: '130px 1fr',
            gap: '0 16px', padding: '11px 0',
            borderTop: '1px solid var(--tc-line, rgba(11,20,25,0.08))',
          }}>
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--tc-ink-faint, #9aa3ac)', paddingTop: 1,
            }}>{s.label}</span>
            <span style={{ fontSize: 13, color: 'var(--tc-ink-soft, #2d3a44)', lineHeight: 1.5 }}>
              {s.value}
            </span>
          </div>
        ))}

        {profile.common_questions?.length > 0 && (
          <div style={{
            display: 'grid', gridTemplateColumns: '130px 1fr',
            gap: '0 16px', padding: '11px 0',
            borderTop: '1px solid var(--tc-line, rgba(11,20,25,0.08))',
          }}>
            <span style={{
              fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: 'var(--tc-ink-faint, #9aa3ac)', paddingTop: 1,
            }}>FAQ Topics</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {profile.common_questions.slice(0, 6).map((q, i) => (
                <span key={i} style={{
                  background: 'var(--tc-teal-soft, #e0eeea)',
                  color: 'var(--tc-teal, #1e6157)',
                  borderRadius: 999, padding: '3px 10px',
                  fontSize: 11.5, fontWeight: 500,
                }}>{q}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '16px 24px 24px', borderTop: '1px solid var(--tc-line, rgba(11,20,25,0.08))' }}>
        <button
          onClick={onConfirm}
          style={{
            width: '100%', padding: '13px 20px',
            background: '#0b1419', color: '#fff',
            border: 'none', borderRadius: 10, cursor: 'pointer',
            fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'background 0.15s ease, transform 0.1s ease',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1e6157' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#0b1419' }}
        >
          Looks great — go to dashboard
          <span style={{ fontSize: 16 }}>→</span>
        </button>
        <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--tc-ink-faint, #9aa3ac)', marginTop: 10 }}>
          You can adjust any of this in Settings → Caye AI
        </p>
      </div>
    </div>
  )
}

function VoiceSamplePanel({
  value,
  onChange,
  onSubmit,
  onSkip,
  isSubmitting,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onSkip: () => void
  isSubmitting: boolean
}) {
  const canSubmit = value.trim().length > 0 && !isSubmitting
  return (
    <div className="ob-message" style={{ paddingLeft: 38 }}>
      <div style={{
        background: '#1c2830',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 14,
        padding: '14px 16px',
      }}>
        <p style={{
          fontSize: 12, color: 'rgba(255,255,255,0.5)',
          marginBottom: 10, lineHeight: 1.55,
        }}>
          Paste 3–5 messages or emails you&apos;ve sent to clients. Separate each with <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 3, padding: '1px 4px', fontSize: 11 }}>---</code>. The more real examples, the better Caye will sound like you.
        </p>
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={isSubmitting}
          placeholder={"Hey Sarah, just confirming your appointment Thursday at 2pm...\n---\nHi! Thanks for reaching out. Here's what we can do for you..."}
          style={{
            width: '100%',
            minHeight: 160,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 8,
            color: '#fff',
            fontSize: 13,
            lineHeight: 1.55,
            padding: '10px 12px',
            resize: 'vertical',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
        <div style={{
          display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onSkip}
            disabled={isSubmitting}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.5)',
              borderRadius: 8, padding: '8px 14px',
              fontSize: 13, cursor: isSubmitting ? 'default' : 'pointer',
              fontFamily: 'inherit',
              transition: 'color 0.15s ease, border-color 0.15s ease',
            }}
          >
            Skip for now
          </button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            style={{
              background: canSubmit ? '#1e6157' : 'rgba(255,255,255,0.08)',
              border: 'none',
              color: '#fff',
              borderRadius: 8, padding: '8px 16px',
              fontSize: 13, fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'default',
              fontFamily: 'inherit',
              transition: 'background 0.15s ease',
            }}
          >
            {isSubmitting ? 'Analyzing…' : 'Teach Caye your voice'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function OnboardingClient({ questions, workspaceIdHint }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [workspaceId, setWorkspaceId] = useState<string | null>(workspaceIdHint ?? null)
  const [businessName, setBusinessName] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [showTyping, setShowTyping] = useState(false)
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [inputValue, setInputValue] = useState('')
  const [profile, setProfile] = useState<BusinessProfile | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [answeredCount, setAnsweredCount] = useState(0)
  const [voiceSamplePhase, setVoiceSamplePhase] = useState<VoiceSamplePhase>('idle')
  const [voiceSamples, setVoiceSamples] = useState('')
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chatStartedRef = useRef(false)
  const voiceNextQRef = useRef<number>(5)

  // ── Auth init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      const { session } = await getSession()
      if (!session) { router.push('/login'); return }
      const wsId = workspaceIdHint || session.user.id
      setWorkspaceId(wsId)
      const supabase = getSupabase()
      const { data } = await supabase
        .from('customers')
        .select('business_name')
        .eq('id', wsId)
        .single()
      if (data?.business_name) setBusinessName(data.business_name)
      setPhase('chatting')
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, showTyping, voiceSamplePhase])

  // ── Focus input ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'chatting' && !showTyping && voiceSamplePhase === 'idle') {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [showTyping, phase, voiceSamplePhase])

  // ── Start conversation ────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'chatting' || chatStartedRef.current) return
    chatStartedRef.current = true
    startChat()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // ── Chat logic ────────────────────────────────────────────────────────────

  async function addCayeMessage(text: string) {
    setShowTyping(true)
    await sleep(650 + Math.random() * 350)
    setShowTyping(false)
    setMessages(prev => [...prev, { id: uid(), role: 'caye', text }])
  }

  async function startChat() {
    const greeting = businessName
      ? `Hey! I'm Caye — your AI receptionist for ${businessName}. I'll ask you 8 quick questions so I know exactly how to represent your business. Takes about 3 minutes. 🌴`
      : `Hey! I'm Caye — your AI receptionist. I'll ask you 8 quick questions so I know exactly how to represent your business. Takes about 3 minutes. 🌴`
    await addCayeMessage(greeting)
    await sleep(200)
    await askQuestion(0)
  }

  async function askQuestion(index: number) {
    setCurrentQ(index)
    await addCayeMessage(questions[index].question)
  }

  async function handleAnswer(text: string) {
    const q = questions[currentQ]
    setMessages(prev => [...prev, { id: uid(), role: 'user', text }])
    const newAnswers = { ...answers, [q.id]: text }
    setAnswers(newAnswers)
    setInputValue('')
    setAnsweredCount(prev => prev + 1)

    const next = currentQ + 1

    // After the tone question, show the voice sample step before continuing
    if (q.id === 'tone') {
      voiceNextQRef.current = next
      await sleep(300)
      await addCayeMessage(
        "Before we move on — paste a few messages you've sent to clients and I'll learn your writing style. The more real examples you share, the more I'll actually sound like you."
      )
      setVoiceSamplePhase('showing')
      return
    }

    if (next < questions.length) {
      await sleep(300)
      await askQuestion(next)
    } else {
      await sleep(300)
      await addCayeMessage("That's everything I need! Give me just a moment to put your profile together…")
      await sleep(600)
      setPhase('synthesizing')
      await synthesize(newAnswers)
    }
  }

  async function handleVoiceSampleSubmit() {
    if (!voiceSamples.trim()) return
    setVoiceSamplePhase('submitting')

    let extractedProfile: VoiceProfile | null = null
    try {
      const res = await fetch('/api/onboarding/voice-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples: [voiceSamples], workspaceId }),
      })
      const data = await res.json() as { voiceProfile?: VoiceProfile; error?: string }
      if (res.ok && data.voiceProfile) {
        extractedProfile = data.voiceProfile
        setVoiceProfile(data.voiceProfile)
      }
    } catch {
      // Non-fatal — continue without voice profile
    }

    setVoiceSamplePhase('confirmed')
    await sleep(300)
    if (extractedProfile) {
      await addCayeMessage(
        `Got it. Here's what I learned about your voice: ${extractedProfile.formality_level}, ${extractedProfile.tone_notes}`
      )
      await sleep(400)
    }
    await askQuestion(voiceNextQRef.current)
  }

  async function handleVoiceSampleSkip() {
    setVoiceSamplePhase('confirmed')
    await sleep(200)
    await askQuestion(voiceNextQRef.current)
  }

  async function synthesize(finalAnswers: Record<string, string>) {
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          answers: finalAnswers,
          businessName,
          ...(voiceProfile ? { voiceProfile } : {}),
        }),
      })
      const data = await res.json() as { profile?: BusinessProfile; error?: string }
      if (!res.ok || data.error) {
        setErrorMsg(data.error ?? 'Something went wrong. Please try again.')
        setPhase('error')
        return
      }
      setProfile(data.profile!)
      setPhase('summary')
    } catch {
      setErrorMsg('Network error — please refresh and try again.')
      setPhase('error')
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const text = inputValue.trim()
    if (!text || phase !== 'chatting' || showTyping) return
    handleAnswer(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as unknown as FormEvent)
    }
  }

  const currentQuestion = questions[currentQ]
  const isWaitingForAnswer = phase === 'chatting' && !showTyping && messages.length > 0
  const lastMessageIsCaye = messages[messages.length - 1]?.role === 'caye'
  const showVoicePanel = voiceSamplePhase === 'showing' || voiceSamplePhase === 'submitting'

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes typingBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes shimmer {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.7; }
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .typing-dot {
          display: block;
          width: 6px; height: 6px; border-radius: 50%;
          background: rgba(255,255,255,0.45);
          animation: typingBounce 1.2s ease-in-out infinite;
        }
        .ob-message {
          animation: fadeSlideUp 0.25s ease forwards;
        }
        .suggestion-chip {
          cursor: pointer;
          background: transparent;
          border: 1.5px solid rgba(30,97,87,0.5);
          color: rgba(255,255,255,0.85);
          border-radius: 10px;
          padding: 10px 14px;
          font-size: 13px;
          line-height: 1.45;
          text-align: left;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
          width: 100%;
          font-family: inherit;
        }
        .suggestion-chip:hover {
          background: rgba(30,97,87,0.15);
          border-color: rgba(30,97,87,0.85);
          color: #fff;
        }
        .ob-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #fff;
          font-size: 14px;
          line-height: 1.5;
          resize: none;
          min-height: 22px;
          max-height: 120px;
          font-family: inherit;
          padding: 0;
          overflow-y: auto;
        }
        .ob-input::placeholder {
          color: rgba(255,255,255,0.3);
        }
        .ob-send-btn {
          width: 34px; height: 34px;
          border-radius: 8px;
          background: #1e6157;
          border: none;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
          transition: background 0.15s ease, transform 0.1s ease;
          color: #fff;
        }
        .ob-send-btn:hover {
          background: #154a42;
        }
        .ob-send-btn:disabled {
          background: rgba(255,255,255,0.08);
          cursor: default;
        }
        .ob-send-btn:active:not(:disabled) {
          transform: scale(0.93);
        }
      `}</style>

      <div style={{
        height: '100vh',
        overflow: 'hidden',
        background: '#0b1419',
        display: 'flex',
        flexDirection: 'column',
        color: '#fff',
        fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)',
        WebkitFontSmoothing: 'antialiased',
      }}>

        {/* ── Top bar ── */}
        <header style={{
          height: 56,
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', alignItems: 'center',
          padding: '0 20px',
          flexShrink: 0,
          background: 'rgba(11,20,25,0.9)',
          backdropFilter: 'blur(12px)',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'conic-gradient(from 140deg, #1e6157 0%, #f4b942 55%, #e85a3c 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: '#fff',
            }}>C</div>
            <div>
              <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Caye</span>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginLeft: 8 }}>
                Setting up your profile
              </span>
            </div>
          </div>

          {phase === 'chatting' && (
            <ProgressPill current={answeredCount} total={questions.length} />
          )}
        </header>

        {/* ── Body ── */}
        <main style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'scroll',
          WebkitOverflowScrolling: 'touch' as never,
          padding: phase === 'summary' ? '32px 16px 40px' : '0 0 24px',
        }}>

          {/* Loading state */}
          {phase === 'loading' && (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'conic-gradient(from 140deg, #1e6157 0%, #f4b942 55%, #e85a3c 100%)',
                animation: 'spin 1.8s linear infinite',
              }} />
            </div>
          )}

          {/* Chat view */}
          {(phase === 'chatting' || phase === 'synthesizing') && (
            <div style={{
              width: '100%', maxWidth: 620,
              margin: '0 auto',
              padding: '28px 16px 0',
              display: 'flex', flexDirection: 'column', gap: 16,
            }}>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className="ob-message"
                  style={{
                    display: 'flex',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    alignItems: 'flex-end',
                    gap: 8,
                  }}
                >
                  {msg.role === 'caye' && <CayeAvatar />}
                  <div style={{
                    maxWidth: '80%',
                    background: msg.role === 'caye' ? '#1c2830' : '#e85a3c',
                    border: msg.role === 'caye' ? '1px solid rgba(255,255,255,0.07)' : 'none',
                    borderRadius: msg.role === 'caye'
                      ? '16px 16px 16px 4px'
                      : '16px 16px 4px 16px',
                    padding: '11px 15px',
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: '#fff',
                  }}>
                    {msg.text}
                  </div>
                </div>
              ))}

              {showTyping && <TypingDots />}

              {/* Synthesizing skeleton */}
              {phase === 'synthesizing' && !showTyping && (
                <div style={{ marginTop: 8 }}>
                  <SummarySkeleton />
                </div>
              )}

              {/* Voice sample panel — shown after tone question */}
              {showVoicePanel && (
                <VoiceSamplePanel
                  value={voiceSamples}
                  onChange={setVoiceSamples}
                  onSubmit={handleVoiceSampleSubmit}
                  onSkip={handleVoiceSampleSkip}
                  isSubmitting={voiceSamplePhase === 'submitting'}
                />
              )}

              {/* Suggestion chip — shown below the current Caye question */}
              {isWaitingForAnswer && lastMessageIsCaye && currentQuestion && voiceSamplePhase === 'idle' && (
                <div
                  className="ob-message"
                  style={{
                    paddingLeft: 38,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <p style={{
                    fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.3)', fontWeight: 600, marginBottom: 2,
                  }}>Suggested answer — tap to accept</p>
                  <button
                    className="suggestion-chip"
                    onClick={() => handleAnswer(currentQuestion.suggestedAnswer)}
                  >
                    {currentQuestion.suggestedAnswer}
                  </button>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Summary view */}
          {phase === 'summary' && profile && (
            <ProfileSummary
              profile={profile}
              onConfirm={() => router.push(`/dashboard/${workspaceId}`)}
            />
          )}

          {/* Error view */}
          {phase === 'error' && (
            <div style={{
              maxWidth: 420, margin: '80px auto',
              background: 'rgba(232,90,60,0.1)', border: '1px solid rgba(232,90,60,0.25)',
              borderRadius: 16, padding: '32px 28px', textAlign: 'center',
            }}>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Something went wrong</p>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.55, marginBottom: 20 }}>
                {errorMsg}
              </p>
              <button
                onClick={() => window.location.reload()}
                style={{
                  background: '#e85a3c', color: '#fff', border: 'none',
                  borderRadius: 8, padding: '10px 20px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                }}
              >
                Try again
              </button>
            </div>
          )}
        </main>

        {/* ── Input bar — hidden during voice sample step ── */}
        {phase === 'chatting' && !showVoicePanel && (
          <div style={{
            flexShrink: 0,
            padding: '12px 16px env(safe-area-inset-bottom, 12px)',
            background: 'rgba(11,20,25,0.95)',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            backdropFilter: 'blur(12px)',
          }}>
            <form
              onSubmit={handleSubmit}
              style={{
                maxWidth: 620,
                margin: '0 auto',
                display: 'flex',
                alignItems: 'flex-end',
                gap: 10,
                background: '#1c2830',
                border: '1px solid rgba(255,255,255,0.09)',
                borderRadius: 14,
                padding: '10px 12px',
              }}
            >
              <textarea
                ref={inputRef}
                className="ob-input"
                value={inputValue}
                onChange={e => {
                  setInputValue(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
                }}
                onKeyDown={handleKeyDown}
                placeholder={showTyping ? 'Caye is typing…' : 'Type your answer or tap the suggestion above'}
                disabled={showTyping}
                rows={1}
              />
              <button
                type="submit"
                className="ob-send-btn"
                disabled={!inputValue.trim() || showTyping}
                aria-label="Send"
              >
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                  <path d="M2 8h12M8 2l6 6-6 6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </form>
            <p style={{
              textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.2)',
              marginTop: 8, letterSpacing: '0.02em',
            }}>
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        )}
      </div>
    </>
  )
}
