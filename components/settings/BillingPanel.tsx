'use client'

import SIcon from './SIcon'
import { PLAN_FEATURES } from '@/lib/data/settings'
import { useWorkspace } from '@/lib/workspace-context'

const INVOICES = [
  { d: 'May 1, 2026', a: '$89.00', n: 'INV-2026-0073', s: 'Paid' },
  { d: 'Apr 1, 2026', a: '$89.00', n: 'INV-2026-0052', s: 'Paid' },
  { d: 'Mar 1, 2026', a: '$89.00', n: 'INV-2026-0031', s: 'Paid' },
]

const PLAN_PRICES: Record<string, number> = {
  free: 0,
  starter: 29,
  medium: 59,
  pro: 89,
  elite: 149,
}

const PLAN_DESCS: Record<string, string> = {
  free: 'Get started with the basics — one channel, Caye AI drafts only, up to 3 team members.',
  starter: 'For solo operators just getting started. One channel, Caye AI drafts, up to 3 members.',
  medium: 'For growing operators running 2–3 channels with a small team.',
  pro: 'Built for owner-operators running 50–300 tours a month across multiple channels, with Caye AI handling the bulk of the inbox.',
  elite: 'For high-volume operators and agencies. Everything in Pro plus multiple locations and custom AI voice.',
}

export default function BillingPanel() {
  const { workspace } = useWorkspace()

  const plan = workspace.plan || 'pro'
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1)
  const price = PLAN_PRICES[plan] ?? 89
  const desc = PLAN_DESCS[plan] ?? PLAN_DESCS.pro

  const trialDays = workspace.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86400000))
    : 0

  const trialLabel = trialDays > 0
    ? `Trial ends in ${trialDays} days`
    : 'Trial ended'

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Billing</div>
          <h1>Plan &amp; usage</h1>
          <p className="set-page-desc">
            You&apos;re on the {planName} plan
            {trialDays > 0 ? ` — trial ends in ${trialDays} days` : ''}.
            Switch any time; we&apos;ll prorate the difference.
          </p>
        </div>
      </header>

      <div className="plan-card">
        <div className="plan-head">
          <div>
            <div className="plan-tag"><span className="dot"></span>Current plan</div>
            <div className="plan-name">{planName}</div>
            <div className="plan-sub">{desc}</div>
          </div>
          <div className="plan-price">
            <div className="amt"><span className="cur">$</span>{price}</div>
            <div className="per">per month</div>
          </div>
        </div>

        <div className="plan-meter">
          <div>
            <div className="k">Conversations</div>
            <div className="v">1,284 <small>/ 3,000</small></div>
            <div className="bar"><span style={{ width: '43%' }}></span></div>
          </div>
          <div>
            <div className="k">Team seats</div>
            <div className="v">4 <small>/ 8</small></div>
            <div className="bar"><span style={{ width: '50%' }}></span></div>
          </div>
          <div>
            <div className="k">Caye AI replies</div>
            <div className="v">887 <small>this month</small></div>
            <div className="bar"><span style={{ width: '72%', background: 'var(--tc-sun)' }}></span></div>
          </div>
        </div>

        <div className="plan-foot">
          <div className="renew">
            {trialDays > 0
              ? `${trialLabel} · then renews monthly`
              : 'Renews monthly'}
          </div>
          <button className="btn-upgrade">Upgrade to Reef <SIcon name="chev" size={14} /></button>
        </div>
      </div>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>What&apos;s in your plan</h3>
            <div className="desc">Everything {planName} includes, plus what you&apos;d unlock on Reef.</div>
          </div>
          <a href="#" style={{ fontSize: 12.5, color: 'var(--tc-teal)', fontWeight: 500, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Compare plans <SIcon name="external" size={12} />
          </a>
        </div>
        <div className="s-card-body">
          <div className="features-grid">
            {PLAN_FEATURES.map((f, i) => (
              <div key={i} className={'feature-item' + (f.in ? '' : ' locked')}>
                <span className="tick">
                  {f.in ? <SIcon name="tick" size={11} /> : <SIcon name="lock" size={11} />}
                </span>
                <div className="ft">{f.label}<small>{f.sub}</small></div>
              </div>
            ))}
          </div>
        </div>
        <div className="s-card-foot">
          <span>Payment method · <b style={{ color: 'var(--tc-ink)' }}>Visa ending 4418</b> · expires 09/27</span>
          <button className="btn-ghost sm">Update card</button>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Invoices</h3>
            <div className="desc">Last 3 months · receipts emailed to {workspace.contact_email}</div>
          </div>
        </div>
        <div className="team-table">
          {INVOICES.map((iv, i) => (
            <div className="team-row" key={i} style={{ gridTemplateColumns: '1fr 140px 110px 32px' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--tc-ink)' }}>{iv.d}</div>
                <div style={{ fontSize: 11.5, color: 'var(--tc-ink-mute)', fontFamily: 'var(--font-mono)', letterSpacing: '.04em', marginTop: 1 }}>{iv.n}</div>
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--tc-ink)', fontFeatureSettings: "'tnum'" }}>{iv.a}</span>
              <span className="team-status active"><span className="pip"></span>{iv.s}</span>
              <button className="team-more"><SIcon name="external" size={14} /></button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
