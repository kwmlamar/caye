'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp Business',
  gmail: 'Email (Gmail)',
  email: 'Zoho Mail',
  instagram: 'Instagram',
  messenger: 'Messenger',
  sms: 'SMS',
}

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: '#25D366',
  gmail: '#EA4335',
  email: 'var(--tc-ink)',
  instagram: 'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)',
  messenger: '#0084FF',
  sms: '#6b7681',
}

export default function BillingPanel() {
  const { workspace, workspaceId } = useWorkspace()

  // Overage switch state
  const [overagesEnabled, setOveragesEnabled] = useState(false)

  // Invoice Details edit state
  const [isEditingInvoice, setIsEditingInvoice] = useState(false)
  const [legalName, setLegalName] = useState(workspace.business_name || workspace.full_name || 'Bimini Island Tours')
  const [billingAddress, setBillingAddress] = useState('Bimini, Bahamas')
  const [taxId, setTaxId] = useState('Not set')

  // Temporary local states during edit
  const [tempName, setTempName] = useState(legalName)
  const [tempAddress, setTempAddress] = useState(billingAddress)
  const [tempTaxId, setTempTaxId] = useState(taxId)

  // Live usage states
  const [usedCredits, setUsedCredits] = useState<number>(0)
  const [channelUsage, setChannelUsage] = useState<{ type: string; count: number }[]>([])
  const [loadingUsage, setLoadingUsage] = useState(true)

  const plan = workspace.plan || 'pro'
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1)
  
  // Mapping limits
  const limit = plan === 'free' ? 500 : plan === 'starter' ? 1000 : plan === 'medium' ? 2500 : plan === 'pro' ? 5000 : 10000
  const remaining = Math.max(0, limit - usedCredits)
  const remainingPercent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)))

  // Query live usage data from Supabase
  useEffect(() => {
    if (!workspaceId) return
    let active = true

    async function fetchUsage() {
      try {
        const supabase = getSupabase()
        
        // 1. Fetch connected active accounts for the workspace
        const { data: accounts, error: accError } = await supabase
          .from('connected_accounts')
          .select('id, channel_type')
          .eq('user_id', workspaceId)
          .eq('is_active', true)

        if (accError) throw accError
        if (!accounts || accounts.length === 0) {
          if (active) {
            setUsedCredits(0)
            setChannelUsage([])
            setLoadingUsage(false)
          }
          return
        }

        // 2. Query count of AI messages for each account in parallel
        const counts = await Promise.all(
          accounts.map(async (acc) => {
            const { count, error } = await supabase
              .from('unified_messages')
              .select('id, conversation:unified_conversations!inner(connected_account_id)', { count: 'exact', head: true })
              .eq('sender_attribution', 'caye_autopilot')
              .eq('conversation.connected_account_id', acc.id)

            if (error) {
              console.error(`Error counting credits for account ${acc.id}:`, error)
              return { type: acc.channel_type, count: 0 }
            }
            return { type: acc.channel_type, count: count || 0 }
          })
        )

        // Aggregate by channel type (in case multiple accounts are connected for the same type)
        const aggregated: Record<string, number> = {}
        counts.forEach(c => {
          aggregated[c.type] = (aggregated[c.type] || 0) + c.count
        })

        const usageList = Object.entries(aggregated).map(([type, count]) => ({ type, count }))
        const total = counts.reduce((sum, item) => sum + item.count, 0)

        if (active) {
          setUsedCredits(total)
          setChannelUsage(usageList)
          setLoadingUsage(false)
        }
      } catch (err) {
        console.error('Failed to load credits usage:', err)
        if (active) {
          setUsedCredits(0)
          setChannelUsage([])
          setLoadingUsage(false)
        }
      }
    }

    fetchUsage()
    return () => { active = false }
  }, [workspaceId])

  const renewDate = workspace?.stripe_current_period_end
    ? new Date(workspace.stripe_current_period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const handleEditPayment = () => {
    toast.success('Redirecting to Stripe Billing Portal...')
  }

  const handleSaveInvoice = () => {
    setLegalName(tempName)
    setBillingAddress(tempAddress)
    setTaxId(tempTaxId)
    setIsEditingInvoice(false)
    toast.success('Invoice details updated locally!')
  }

  const handleCancelInvoice = () => {
    setTempName(legalName)
    setTempAddress(billingAddress)
    setTempTaxId(taxId)
    setIsEditingInvoice(false)
  }

  return (
    <div className="set-page" style={{ maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      
      {/* 1. Current Plan Card */}
      <section className="s-card">
        <div className="s-card-head" style={{ paddingBottom: '16px' }}>
          <h3 style={{ fontSize: '15.5px', fontWeight: 600, color: '#0E1A1A', margin: 0 }}>Current plan</h3>
        </div>
        <div className="s-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#0E1A1A' }}>{planName}</span>
              <span style={{ fontSize: '13px', color: 'rgba(14, 26, 26, 0.45)', marginLeft: '6px' }}>
                ({limit.toLocaleString()} credits / month)
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '13px' }}>
              <span style={{ color: 'rgba(14, 26, 26, 0.45)' }}>Credits remaining</span>
              <strong style={{ color: '#0E1A1A', fontWeight: 600 }}>
                {loadingUsage ? '...' : remaining.toLocaleString()} / {limit.toLocaleString()}
              </strong>
            </div>
          </div>

          {/* Teal progress bar */}
          <div style={{ height: '8px', background: 'rgba(14, 26, 26, 0.05)', borderRadius: '999px', overflow: 'hidden', width: '100%' }}>
            <div style={{ height: '100%', width: `${loadingUsage ? 0 : remainingPercent}%`, background: '#0FB5A1', borderRadius: '999px', transition: 'width 0.3s ease' }} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
            <button 
              onClick={() => toast.success('Select a plan to upgrade')} 
              className="btn-solid"
              style={{
                background: '#0070f3',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#005ed3'}
              onMouseLeave={e => e.currentTarget.style.background = '#0070f3'}
            >
              Upgrade to paid plan
            </button>
            <button 
              onClick={() => toast.error('Cancellation request submitted')}
              className="btn-ghost"
              style={{
                color: '#E85A3C',
                borderColor: 'rgba(232, 90, 60, 0.15)',
                background: 'transparent',
                border: '1px solid rgba(232, 90, 60, 0.15)',
                borderRadius: '8px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(232, 90, 60, 0.03)'
                e.currentTarget.style.borderColor = 'rgba(232, 90, 60, 0.3)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.borderColor = 'rgba(232, 90, 60, 0.15)'
              }}
            >
              Cancel
            </button>
          </div>

          <p style={{ fontSize: '12px', color: 'rgba(14, 26, 26, 0.45)', margin: '4px 0 0 0' }}>
            Your new billing plan will renew on <strong style={{ fontWeight: 600, color: 'rgba(14, 26, 26, 0.7)' }}>{renewDate}</strong>.
          </p>

        </div>
      </section>

      {/* 2. Payment Method Card */}
      <section className="s-card">
        <div className="s-card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0E1A1A', margin: '0 0 4px 0' }}>Payment method</h3>
            <span style={{ fontSize: '13.5px', color: 'rgba(14, 26, 26, 0.8)', fontFamily: 'var(--font-mono), monospace' }}>
              VISA•••• 4418 Exp 09/2027
            </span>
          </div>
          <button onClick={handleEditPayment} className="btn-ghost" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
            Edit
          </button>
        </div>
      </section>

      {/* 3. Enable Overages Card */}
      <section className="s-card">
        <div className="s-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0E1A1A', margin: 0 }}>Enable overages</h3>
            <label className="toggle-switch">
              <input 
                type="checkbox" 
                checked={overagesEnabled} 
                onChange={(e) => {
                  setOveragesEnabled(e.target.checked)
                  toast.success(e.target.checked ? 'Overages enabled for this billing period.' : 'Overages disabled.')
                }} 
              />
              <span className="slider"></span>
            </label>
          </div>
          <p style={{ fontSize: '12px', color: 'rgba(14, 26, 26, 0.45)', lineHeight: '1.5', margin: 0, paddingRight: '48px' }}>
            Overages let you keep using Caye after running out of credits, up to 4x your subscription. Overage credits cost twice as much.
          </p>
        </div>
      </section>

      {/* 4. Invoice Billing Details Card */}
      <section className="s-card">
        <div className="s-card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0E1A1A', margin: 0 }}>Invoice billing details</h3>
            <p style={{ fontSize: '12px', color: 'rgba(14, 26, 26, 0.45)', margin: '4px 0 0 0' }}>
              These details appear on future invoices we send for this workspace.
            </p>
          </div>
          {!isEditingInvoice && (
            <button onClick={() => setIsEditingInvoice(true)} className="btn-ghost" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
              Edit
            </button>
          )}
        </div>
        <div className="s-card-body" style={{ paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {isEditingInvoice ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.45)' }}>Legal name</span>
                <input 
                  value={tempName} 
                  onChange={(e) => setTempName(e.target.value)} 
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(14, 26, 26, 0.12)',
                    fontSize: '13.5px',
                    outline: 'none',
                    background: '#ffffff',
                    color: '#0E1A1A'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.45)' }}>Billing address</span>
                <input 
                  value={tempAddress} 
                  onChange={(e) => setTempAddress(e.target.value)} 
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(14, 26, 26, 0.12)',
                    fontSize: '13.5px',
                    outline: 'none',
                    background: '#ffffff',
                    color: '#0E1A1A'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.45)' }}>Tax ID</span>
                <input 
                  value={tempTaxId} 
                  onChange={(e) => setTempTaxId(e.target.value)} 
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(14, 26, 26, 0.12)',
                    fontSize: '13.5px',
                    outline: 'none',
                    background: '#ffffff',
                    color: '#0E1A1A'
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button onClick={handleSaveInvoice} className="btn-solid sm" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
                  Save
                </button>
                <button onClick={handleCancelInvoice} className="btn-ghost sm" style={{ padding: '6px 14px', fontSize: '12.5px' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.4)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Legal name</span>
                <span style={{ fontSize: '13.5px', color: '#0E1A1A', marginTop: '2px' }}>{legalName}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.4)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Billing address</span>
                <span style={{ fontSize: '13.5px', color: '#0E1A1A', marginTop: '2px' }}>{billingAddress}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'rgba(14, 26, 26, 0.4)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tax ID</span>
                <span style={{ fontSize: '13.5px', color: '#0E1A1A', marginTop: '2px' }}>{taxId}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 5. Usage Card */}
      <section className="s-card">
        <div className="s-card-head" style={{ paddingBottom: '12px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#0E1A1A', margin: 0 }}>Usage</h3>
          <p style={{ fontSize: '12.5px', color: 'rgba(14, 26, 26, 0.45)', margin: '4px 0 0 0' }}>
            Interested in reducing your credit consumption? <span style={{ color: '#0FB5A1', cursor: 'pointer', textDecoration: 'underline' }}>Learn more</span>
          </p>
        </div>
        
        <div className="s-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          {/* Dropdown selectors side-by-side */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <select style={{
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid rgba(14,26,26,0.12)',
              fontSize: '12.5px',
              color: '#0E1A1A',
              background: '#ffffff',
              outline: 'none',
              cursor: 'pointer'
            }}>
              <option>Current billing period</option>
              <option>Previous billing period</option>
            </select>

            <select style={{
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid rgba(14,26,26,0.12)',
              fontSize: '12.5px',
              color: '#0E1A1A',
              background: '#ffffff',
              outline: 'none',
              cursor: 'pointer'
            }}>
              <option>All channels</option>
              <option>WhatsApp Business</option>
              <option>Email (Gmail)</option>
              <option>Zoho Mail</option>
              <option>Instagram</option>
              <option>Messenger</option>
              <option>SMS</option>
            </select>
          </div>

          {/* Usage Table */}
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', marginTop: '6px' }}>
            
            {/* Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 140px 100px',
              borderBottom: '1px solid rgba(14, 26, 26, 0.08)',
              paddingBottom: '8px',
              fontSize: '11px',
              fontWeight: 600,
              color: 'rgba(14, 26, 26, 0.4)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}>
              <div>Channel</div>
              <div>Credits</div>
              <div>Status</div>
            </div>

            {loadingUsage ? (
              <p style={{ fontSize: '13px', color: 'rgba(14,26,26,0.45)', padding: '16px 0', margin: 0 }}>
                Loading usage details...
              </p>
            ) : channelUsage.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'rgba(14,26,26,0.45)', padding: '16px 0', margin: 0 }}>
                No active channel usage detected for this billing period.
              </p>
            ) : (
              channelUsage.map((c) => {
                const name = CHANNEL_NAMES[c.type] || c.type
                const color = CHANNEL_COLORS[c.type] || '#6b7681'
                const initial = name.charAt(0).toUpperCase()
                return (
                  <div key={c.type} style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 140px 100px',
                    alignItems: 'center',
                    padding: '12px 0',
                    borderBottom: '1px solid rgba(14, 26, 26, 0.05)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: '26px',
                        height: '26px',
                        borderRadius: '6px',
                        background: color,
                        color: '#ffffff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '13px',
                        fontWeight: 600
                      }}>
                        {initial}
                      </div>
                      <span style={{ fontSize: '13.5px', fontWeight: 600, color: '#0E1A1A' }}>{name}</span>
                    </div>
                    <span style={{ fontSize: '13.5px', color: '#0E1A1A', fontFeatureSettings: "'tnum'" }}>{c.count.toLocaleString()}</span>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#0FB5A1'
                    }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#0FB5A1' }} />
                      Active
                    </span>
                  </div>
                )
              })
            )}

          </div>

        </div>
      </section>

    </div>
  )
}
