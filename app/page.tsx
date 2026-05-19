'use client'

import Link from 'next/link'
import { useEffect } from 'react'

export default function Home() {
  useEffect(() => {
    document.body.classList.add('lp-body')
    return () => { document.body.classList.remove('lp-body') }
  }, [])

  return (
    <div className="lp-page">

      {/* NAV */}
      <nav className="lp-nav">
        <div className="lp-wrap lp-inner">
          <a href="#top" className="lp-brand">
            <span className="lp-mark">C</span>
            Caye
          </a>
          <div className="lp-nav-links">
            <a href="#caye">Meet Caye</a>
            <a href="#how">How it works</a>
            <a href="#handles">Features</a>
            <a href="#pricing">Pricing</a>
            <Link href="/login" className="lp-nav-link-ghost">Login</Link>
            <Link href="/signup" className="lp-nav-cta">Get started →</Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="lp-hero" id="top">
        <div className="lp-wrap">
          <div className="lp-hero-grid">

            <div>
              <div className="lp-hero-pill" id="hero-pill">
                <span className="lp-badge-tag">New</span>
                <span>Live with pilot operators in the Bahamas</span>
              </div>

              <h1 className="lp-hero-title lp-display" id="hero-title">
                <span className="lp-line"><span>Meet <span className="lp-accent">Caye.</span></span></span>
                <span className="lp-line"><span>She handles the</span></span>
                <span className="lp-line"><span>messages.</span></span>
              </h1>

              <p className="lp-hero-sub" id="hero-sub">
                Caye is your AI receptionist — pronounced <strong>key</strong>, named for the sandbars off the islands. She reads your booking messages, checks your calendar, and writes back in your voice. <strong>You find out after.</strong>
              </p>

              <div className="lp-cta-row" id="hero-cta">
                <Link className="lp-btn lp-btn-coral" href="/signup">Try Caye free <span className="lp-arrow">→</span></Link>
                <a className="lp-btn lp-btn-ghost" href="#how">See how she works</a>
              </div>

              <div className="lp-live-line" id="hero-live">
                <span className="lp-live-pulse" />
                <span>Pilot live · 14 active operators · Spring &apos;26</span>
              </div>
            </div>

            {/* Hero product window */}
            <div id="caye" style={{ position: 'relative' }}>
              <div className="lp-toast lp-toast-t1" id="toast1">
                <span className="lp-toast-ico">↓</span>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--lp-ink-mute)', fontFamily: "'JetBrains Mono',monospace", letterSpacing: '0.1em', textTransform: 'uppercase' }}>New inquiry</div>
                  <div>Cruise guest · WhatsApp</div>
                </div>
              </div>
              <div className="lp-toast lp-toast-t2" id="toast2">
                <span className="lp-toast-ico lp-toast-ico-coral">✓</span>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--lp-ink-mute)', fontFamily: "'JetBrains Mono',monospace", letterSpacing: '0.1em', textTransform: 'uppercase' }}>Booking confirmed</div>
                  <div>Sat 11:00 · added to calendar</div>
                </div>
              </div>

              <div className="lp-product-window" id="product-window">
                <div className="lp-pw-chrome">
                  <div className="lp-pw-dots"><span /><span /><span /></div>
                  <div className="lp-pw-title">caye · <strong>karenda&apos;s bahamas tours</strong></div>
                  <div style={{ width: 42 }} />
                </div>
                <div className="lp-pw-body">
                  <div className="lp-pw-rail">
                    <div className="lp-rail-head">Inbox</div>
                    <div className="lp-channel lp-channel-active">
                      <span className="lp-ico lp-ico-wa">W</span>
                      <span>WhatsApp</span>
                      <span className="lp-count lp-count-active">3</span>
                    </div>
                    <div className="lp-channel">
                      <span className="lp-ico lp-ico-ig">IG</span>
                      <span>Instagram</span>
                      <span className="lp-count">5</span>
                    </div>
                    <div className="lp-channel">
                      <span className="lp-ico lp-ico-fb">M</span>
                      <span>Messenger</span>
                      <span className="lp-count">2</span>
                    </div>
                    <div className="lp-channel">
                      <span className="lp-ico lp-ico-em">@</span>
                      <span>Email</span>
                      <span className="lp-count">12</span>
                    </div>
                    <div className="lp-rail-head" style={{ marginTop: 14 }}>Caye</div>
                    <div className="lp-channel">
                      <span className="lp-ico" style={{ background: 'var(--lp-teal)' }}>C</span>
                      <span>Drafts</span>
                      <span className="lp-count" style={{ background: 'var(--lp-teal-soft)', color: 'var(--lp-teal)' }}>4</span>
                    </div>
                  </div>

                  <div className="lp-pw-main">
                    <div className="lp-pw-thread-head">
                      <div className="lp-pw-avatar">A</div>
                      <div className="lp-who">
                        <div className="lp-thread-name">Anna · Carnival Pride</div>
                        <div className="lp-thread-role">WhatsApp · Cruise guest</div>
                      </div>
                      <div className="lp-thread-meta">2:14 PM</div>
                    </div>

                    <div className="lp-msg lp-msg-in">
                      Hi! Coming in on Carnival Pride Saturday — are 4 of us able to do the snorkel + lunch tour at 11?
                    </div>

                    <div className="lp-caye-banner">
                      <span className="lp-swirl" />
                      <span>caye · checking calendar…</span>
                    </div>

                    <div className="lp-msg lp-msg-out">
                      <span className="lp-msg-tag">Drafted by caye · sent as karenda</span>
                      Hi Anna — yes, Saturday 11am works perfectly. Pickup at the cruise port pier, look for the blue boat. $89 pp, lunch included. I&apos;ll have the confirmation in your inbox in a sec. — Karenda
                    </div>

                    <div className="lp-pw-action">
                      <div className="lp-draft">
                        <strong>Caye is on. Replying for you.</strong>
                        Reviews auto-send after 30s · you can edit any time
                      </div>
                      <span className="lp-btnlet">Review</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* MARQUEE */}
      <div className="lp-marquee" id="marquee">
        <div className="lp-track" id="track">
          <span>
            <span className="lp-item"><span className="lp-ic lp-ic-wa">W</span>WhatsApp</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-ig">IG</span>Instagram</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-fb">M</span>Messenger</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-em">@</span>Email</span>
            <span className="lp-star">✦</span>
            <span className="lp-item" style={{ color: 'var(--lp-coral)', fontWeight: 600 }}>→ One inbox.</span>
            <span className="lp-star">✦</span>
          </span>
          <span aria-hidden="true">
            <span className="lp-item"><span className="lp-ic lp-ic-wa">W</span>WhatsApp</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-ig">IG</span>Instagram</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-fb">M</span>Messenger</span>
            <span className="lp-star">✦</span>
            <span className="lp-item"><span className="lp-ic lp-ic-em">@</span>Email</span>
            <span className="lp-star">✦</span>
            <span className="lp-item" style={{ color: 'var(--lp-coral)', fontWeight: 600 }}>→ One inbox.</span>
            <span className="lp-star">✦</span>
          </span>
        </div>
      </div>

      {/* PROBLEM */}
      <section className="lp-problem">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <div className="lp-label"><span className="lp-eyebrow"><span className="lp-dot" />The problem · 01</span></div>
            <h2 className="lp-display lp-section-title">Messages don&apos;t fall <span className="lp-accent">on one phone</span> anymore.</h2>
          </div>

          <div className="lp-problem-grid">
            <div className="lp-channel-card">
              <div className="lp-card-head">
                <span className="lp-ic lp-ic-wa">W</span>
                <span className="lp-card-name">WhatsApp</span>
                <span className="lp-card-count">3 unread</span>
              </div>
              <div className="lp-when">2h ago</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">Anna · Cruise guest</span>&quot;Hi! Is the snorkel tour available Sat?&quot;</div>
              <div className="lp-ghost-msg lp-ghost-missed"><span className="lp-tiny">Marco · 8h ago</span>&quot;Still need a tour for 4 people&quot;</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">Sandra · 1d ago</span>&quot;Confirming pickup time&quot;</div>
            </div>
            <div className="lp-channel-card">
              <div className="lp-card-head">
                <span className="lp-ic lp-ic-ig">IG</span>
                <span className="lp-card-name">Instagram</span>
                <span className="lp-card-count">5 unread</span>
              </div>
              <div className="lp-when">DMs</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">@thecruisemom</span>&quot;Pricing for a group of 6?&quot;</div>
              <div className="lp-ghost-msg lp-ghost-missed"><span className="lp-tiny">@jaybahamas · 2d ago</span>&quot;Anyone home?&quot;</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">@island.honeymoon</span>&quot;Sunset cruise availability&quot;</div>
            </div>
            <div className="lp-channel-card">
              <div className="lp-card-head">
                <span className="lp-ic lp-ic-fb">M</span>
                <span className="lp-card-name">Messenger</span>
                <span className="lp-card-count">2 unread</span>
              </div>
              <div className="lp-when">FB inbox</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">David L.</span>&quot;How do I book?&quot;</div>
              <div className="lp-ghost-msg lp-ghost-missed"><span className="lp-tiny">Tia P. · 3d ago</span>&quot;Are you guys still doing tours?&quot;</div>
            </div>
            <div className="lp-channel-card">
              <div className="lp-card-head">
                <span className="lp-ic lp-ic-em">@</span>
                <span className="lp-card-name">Email</span>
                <span className="lp-card-count">12 unread</span>
              </div>
              <div className="lp-when">Inbox</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">booking@royalcaribbean</span>&quot;Group inquiry — 14 pax&quot;</div>
              <div className="lp-ghost-msg"><span className="lp-tiny">karenda@gmail</span>&quot;Re: Saturday tour 11am&quot;</div>
              <div className="lp-ghost-msg lp-ghost-missed"><span className="lp-tiny">Mark Z · friday</span>&quot;Need to confirm pickup...&quot;</div>
            </div>
          </div>

          <p className="lp-display lp-problem-quote" id="problem-quote">
            So bookings <span className="lp-accent">fall through the cracks</span> — and you find out two days later, when the cruise has already left port.
          </p>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="lp-how" id="how">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <div className="lp-label"><span className="lp-eyebrow lp-eyebrow-sun"><span className="lp-dot lp-dot-sun" />How Caye works · 02</span></div>
            <h2 className="lp-display lp-section-title">No flowcharts. <span className="lp-accent-sun">No training.</span> She just handles it.</h2>
          </div>

          <div className="lp-steps" id="steps">
            <div className="lp-step">
              <div className="lp-step-num">Step 01 · Sees the message</div>
              <h3>A guest reaches out.</h3>
              <p>Could be a cruise mom on WhatsApp. Could be a honeymooner emailing about a sunset cruise. Caye sees it the second it lands.</p>
              <div className="lp-step-ui">
                <span className="lp-ui-ic lp-ico-wa" style={{ background: '#22c55e' }}>W</span>
                <span>New thread from <strong style={{ color: '#fff' }}>+1 305 ···</strong></span>
              </div>
            </div>
            <div className="lp-step">
              <div className="lp-step-num">Step 02 · Checks availability</div>
              <h3>She checks your calendar.</h3>
              <p>Caye pulls availability the way you would — knows you don&apos;t run tours on Fridays, knows the boat needs an hour between trips.</p>
              <div className="lp-step-ui">
                <span className="lp-pip" />
                <span>Sat 11:00 — <strong style={{ color: '#fff' }}>open</strong> · 2hr slot available</span>
              </div>
            </div>
            <div className="lp-step">
              <div className="lp-step-num">Step 03 · Replies + books</div>
              <h3>She replies in your voice.</h3>
              <p>Caye sends the confirmation, books the event, logs the customer. You read it the next morning over coffee, if at all.</p>
              <div className="lp-step-ui">
                <span className="lp-ui-ic" style={{ background: 'var(--lp-coral)' }}>✓</span>
                <span>Confirmation sent · event added</span>
              </div>
            </div>
          </div>

          <div className="lp-chatscene">
            <div className="lp-display lp-chatlead">
              It looks like a <span className="lp-accent-sun">regular email thread.</span>
              <small>Because it is one — written by Caye, sent from your address, indistinguishable from the way you&apos;d reply yourself. Cruise guests don&apos;t know they&apos;re talking to an AI. They know they got a fast, warm answer.</small>
            </div>

            <div className="lp-chat-window" id="chat-card">
              <div className="lp-pw-thread-head">
                <div className="lp-pw-avatar lp-pw-avatar-coral">K</div>
                <div className="lp-who">
                  <div className="lp-thread-name">Karenda&apos;s Bahamas Tours</div>
                  <div className="lp-thread-role">Email · with Caye</div>
                </div>
                <div className="lp-thread-meta" style={{ background: 'var(--lp-coral)', color: '#fff', padding: '4px 8px', borderRadius: 6 }}>FRIDAY</div>
              </div>
              <div className="lp-chat-body">
                <div className="lp-msg lp-msg-in">
                  <span className="lp-msg-tag">From: cruise guest</span>
                  Hi there! Coming in on the Carnival Pride Saturday — are 4 of us able to do the snorkel + lunch tour at 11?
                </div>
                <div className="lp-caye-banner">
                  <span className="lp-swirl" />
                  <span>caye · checking calendar…</span>
                </div>
                <div className="lp-typing">
                  <span /><span /><span />
                </div>
                <div className="lp-msg lp-msg-out">
                  <span className="lp-msg-tag">From: karenda@bahamastours · sent by caye</span>
                  Hi Anna — yes, Saturday 11am works perfectly. Pickup at the cruise port pier, look for the blue boat. $89 pp, lunch included. I&apos;ll have the confirmation in your inbox in a sec. — Karenda
                </div>
                <div className="lp-caye-banner" style={{ background: 'var(--lp-coral-soft)', borderColor: 'rgba(232,90,60,0.4)', color: 'var(--lp-coral-deep)' }}>
                  <span className="lp-swirl" />
                  <span>caye · booking added · saturday 11:00</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* HANDLES */}
      <section className="lp-handles" id="handles">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <div className="lp-label"><span className="lp-eyebrow"><span className="lp-dot" />What Caye handles · 03</span></div>
            <h2 className="lp-display lp-section-title">Everything you&apos;d hire <span className="lp-accent">a receptionist</span> to do.</h2>
          </div>

          <div className="lp-handles-grid">
            <div className="lp-feature">
              <div className="lp-ftag">— 01 · Unified inbox</div>
              <h4>One inbox. Every channel.</h4>
              <p>WhatsApp, Instagram DMs, Messenger and email — all in one view. No more swiping between four apps trying to remember which guest asked what, where.</p>
              <div className="lp-viz lp-viz-channels">
                <span className="lp-ic lp-ic-wa">W</span><span className="lp-ic lp-ic-ig">IG</span><span className="lp-ic lp-ic-fb">M</span><span className="lp-ic lp-ic-em">@</span>
                <span className="lp-viz-arrow" />
                <span className="lp-viz-inbox">Inbox</span>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 02 · AI Smart Replies</div>
              <h4>After-hours replies.</h4>
              <p>Caye answers common inquiries automatically — pricing, hours, availability — the moment they come in. Including 2am. Including Sundays. Including Fridays.</p>
              <div className="lp-viz lp-viz-bubble">
                <div className="lp-vbubble">&quot;What time does the snorkel tour start?&quot;</div>
                <div className="lp-vbubble lp-vbubble-out">&quot;11am sharp — pier 4. See you Saturday!&quot;</div>
                <span className="lp-vstamp">↳ sent · 2:14am island time</span>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 03 · Booking management</div>
              <h4>Bookings, captured.</h4>
              <p>Whether the request lands in a DM or an email, Caye pulls it into a structured booking — name, date, party size, source — so nothing has to live in your head.</p>
              <div className="lp-viz lp-viz-booking">
                <div className="lp-vrow"><span className="lp-vk">Guest</span><span className="lp-vv">Anna · 4 pax</span></div>
                <div className="lp-vrow"><span className="lp-vk">When</span><span className="lp-vv">Sat · 11:00</span></div>
                <div className="lp-vrow"><span className="lp-vk">Status</span><span className="lp-vok">Confirmed</span></div>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 04 · Calendar integration</div>
              <h4>Calendar, kept honest.</h4>
              <p>Connect Google Calendar once. Caye reads availability before she promises anything, then drops the confirmed booking on the right day at the right time.</p>
              <div className="lp-viz lp-viz-cal">
                <div className="lp-vcal-d">M</div><div className="lp-vcal-d">T</div><div className="lp-vcal-d lp-vcal-has">W</div><div className="lp-vcal-d">T</div><div className="lp-vcal-d">F</div><div className="lp-vcal-d lp-vcal-now">S</div><div className="lp-vcal-d lp-vcal-has">S</div>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 05 · Automation flows</div>
              <h4>Follow-ups, on auto.</h4>
              <p>Reminder the night before, thank-you the morning after, a nudge if a deposit is overdue. The little touches that make repeat customers — done without you remembering.</p>
              <div className="lp-viz lp-viz-flow">
                <div className="lp-vflow-row lp-vflow-done"><span className="lp-vflow-pip lp-vflow-pip-done">✓</span><span>Booking confirmed</span></div>
                <div className="lp-vflow-row lp-vflow-done"><span className="lp-vflow-pip lp-vflow-pip-done">✓</span><span>Reminder sent · night before</span></div>
                <div className="lp-vflow-row"><span className="lp-vflow-pip">3</span><span>Thank-you · morning after</span></div>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 06 · Customer profiles</div>
              <h4>Customers, remembered.</h4>
              <p>Every guest gets a profile. Last booking. What they ordered. Which kid was allergic to shellfish. So you sound like a friend, not a chain.</p>
              <div className="lp-viz lp-viz-profile">
                <div className="lp-vprofile-top">
                  <div className="lp-vav">A</div>
                  <div>
                    <div className="lp-vnm">Anna M.</div>
                    <div className="lp-vsub">Carnival Pride · 4th visit</div>
                  </div>
                </div>
                <div className="lp-vmeta">
                  <span>No shellfish</span>
                  <span>$1,240 LTV</span>
                  <span>Repeat</span>
                </div>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 07 · Revenue analytics</div>
              <h4>The dollars, visible.</h4>
              <p>Every lead, every booking, every dollar — in a single dashboard. So you can stop guessing how the season is going and just look.</p>
              <div className="lp-viz lp-viz-chart">
                <div className="lp-vchart-top"><span className="lp-vchart-amt">$12,480</span><span className="lp-vchart-delta">+38%</span></div>
                <div className="lp-vchart-bars">
                  <div style={{ height: '40%' }} /><div style={{ height: '55%' }} /><div style={{ height: '48%' }} /><div style={{ height: '70%' }} /><div style={{ height: '62%' }} /><div style={{ height: '85%' }} /><div style={{ height: '100%' }} />
                </div>
              </div>
            </div>

            <div className="lp-feature">
              <div className="lp-ftag">— 08 · Voice & tone</div>
              <h4>In your voice. Always.</h4>
              <p>Caye learns the way you write — so customers feel you, not a chatbot. She&apos;s the receptionist, not the brand.</p>
              <div className="lp-viz lp-viz-voice">
                <div className="lp-vvoice-line" />
                <div className="lp-vvoice-line" />
                <div className="lp-vvoice-line" />
                <span className="lp-vvoice-tag">trained on · 312 of karenda&apos;s replies</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="lp-pricing" id="pricing">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <div className="lp-label"><span className="lp-eyebrow"><span className="lp-dot" />Pricing · 04</span></div>
            <h2 className="lp-display lp-section-title">One price. <span className="lp-accent">No contracts.</span> Cancel any time.</h2>
          </div>

          <div className="lp-price-grid">
            <div className="lp-price-card">
              <div className="lp-price-ftag">— Caye Solo</div>
              <div className="lp-price-num"><sup>$</sup>79</div>
              <div className="lp-price-per">/ month · flat</div>
              <div className="lp-price-title">Just Caye, handling the messages.</div>
              <ul>
                <li>Unified inbox · WhatsApp, IG, Messenger, Email</li>
                <li>Caye AI receptionist with smart replies</li>
                <li>Calendar integration &amp; booking management</li>
                <li>Customer profiles &amp; revenue analytics</li>
                <li>Onboarding call with our Bahamas team</li>
              </ul>
              <Link className="lp-btn lp-btn-ghost" href="/signup">Start with Caye <span className="lp-arrow">→</span></Link>
            </div>

            <div className="lp-price-card lp-price-featured">
              <div className="lp-price-ftag">— Caye + Website</div>
              <div className="lp-price-num"><sup>$</sup>129</div>
              <div className="lp-price-per">/ month · bundled</div>
              <div className="lp-price-title">Caye, plus a TropiTech-built website.</div>
              <ul>
                <li>Everything in Caye Solo</li>
                <li>Custom website built by TropiTech</li>
                <li>Booking page wired straight to Caye</li>
                <li>Domain, hosting, SSL — all handled</li>
                <li>Priority Bahamas-based support</li>
              </ul>
              <Link className="lp-btn lp-btn-coral" href="/signup">Get the bundle <span className="lp-arrow">→</span></Link>
            </div>
          </div>

          <div className="lp-pilot-note">
            <span className="lp-pilot-badge">Pilot offer</span>
            <p>First pilot customers get <strong>2 free months</strong> + <strong>$20/mo referral kickback</strong> for every active business they bring in. We&apos;re still small. We treat early operators like family.</p>
          </div>
        </div>
      </section>

      {/* TESTIMONIAL */}
      <section className="lp-testimonial">
        <div className="lp-wrap">
          <div className="lp-section-head">
            <div className="lp-label"><span className="lp-eyebrow lp-eyebrow-teal"><span className="lp-dot lp-dot-teal" />From the field · 05</span></div>
            <h2 className="lp-display lp-section-title">A Friday in Nassau, as told <span className="lp-accent">by Karenda.</span></h2>
          </div>

          <div className="lp-testimonial-inner">
            <div>
              <p className="lp-quote">&ldquo;I&apos;m Seventh Day Adventist. I don&apos;t work Fridays — and I never have. But bookings still come in on Fridays, and for years I&apos;d come back Saturday morning to <span className="lp-accent">five missed inquiries</span> and three cruise guests who already booked someone else.</p>
              <p className="lp-quote" style={{ marginTop: 18 }}>Now Caye just <span className="lp-accent">handles it.</span> I check Saturday and the confirmations are sent, the calendar is full, the day is already paid for.<span style={{ color: 'var(--lp-coral)' }}>&rdquo;</span></p>
              <div className="lp-attribution">
                <div className="lp-testimonial-avatar">K</div>
                <div className="lp-who-block">
                  <div className="lp-who-name">Karenda · pilot customer</div>
                  <div className="lp-who-role">Tour operator · Nassau, Bahamas</div>
                </div>
              </div>
            </div>

            <div className="lp-friday-card">
              <span className="lp-friday-stamp">Handled.</span>
              <div className="lp-friday-head">
                <h5>Karenda&apos;s week</h5>
                <span className="lp-friday-week">April &apos;26 · wk 14</span>
              </div>
              <div className="lp-calendar">
                <div className="lp-day"><span className="lp-day-lbl">Mon</span><span className="lp-day-nm">06</span></div>
                <div className="lp-day"><span className="lp-day-lbl">Tue</span><span className="lp-day-nm">07</span></div>
                <div className="lp-day"><span className="lp-day-lbl">Wed</span><span className="lp-day-nm">08</span></div>
                <div className="lp-day"><span className="lp-day-lbl">Thu</span><span className="lp-day-nm">09</span></div>
                <div className="lp-day lp-day-friday"><span className="lp-day-lbl">Fri</span><span className="lp-day-nm">10</span></div>
                <div className="lp-day"><span className="lp-day-lbl">Sat</span><span className="lp-day-nm">11</span></div>
                <div className="lp-day"><span className="lp-day-lbl">Sun</span><span className="lp-day-nm">12</span></div>
              </div>
              <div className="lp-friday-stats">
                <div className="lp-st"><span className="lp-st-num">6</span><span className="lp-st-k">Inquiries</span></div>
                <div className="lp-st"><span className="lp-st-num">4</span><span className="lp-st-k">Booked</span></div>
                <div className="lp-st"><span className="lp-st-num">$0</span><span className="lp-st-k">Karenda&apos;s time</span></div>
              </div>
              <div className="lp-friday-note">Friday — <strong>6 inquiries, 4 confirmed bookings, $0 of Karenda&apos;s time.</strong> Caye replied, checked the calendar, and got the deposit emails out by 2pm island time.</div>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="lp-final" id="cta">
        <div className="lp-wrap lp-final-inner">
          <h2 className="lp-display">Let <span className="lp-accent-ink">Caye</span> handle it.</h2>
          <p className="lp-final-sub">Try Caye free for two months. We&apos;ll get you set up over a call, connect your WhatsApp and email, and have Caye answering for you by the end of the week.</p>
          <div className="lp-cta-row">
            <Link className="lp-btn lp-btn-primary-dark" href="/signup">Start the pilot <span className="lp-arrow">→</span></Link>
            <a className="lp-btn lp-btn-ghost-white" href="#how">See how she works</a>
          </div>
          <div className="lp-lives">
            <span className="lp-live-pulse lp-live-pulse-ink" />
            <span>Live · pilots open · Bahamas first, Caribbean next</span>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-footer-row">
            <div>
              <div className="lp-brand lp-brand-footer"><span className="lp-mark lp-mark-footer">C</span>Caye</div>
              <p className="lp-footer-tag">A Caribbean AI receptionist. Built in Nassau by <a href="https://tropitech.org">TropiTech</a>.</p>
            </div>
            <div>
              <h6>Product</h6>
              <ul>
                <li><a href="#caye">Meet Caye</a></li>
                <li><a href="#how">How it works</a></li>
                <li><a href="#handles">Features</a></li>
                <li><a href="#pricing">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h6>Company</h6>
              <ul>
                <li><a href="https://tropitech.org">TropiTech</a></li>
                <li><a href="mailto:lamar@tropitech.org">Contact</a></li>
                <li><a href="#cta">Start a pilot</a></li>
                <li><a href="#cta">Referral program</a></li>
              </ul>
            </div>
            <div>
              <h6>Reach Lamar</h6>
              <ul>
                <li><a href="mailto:lamar@tropitech.org">lamar@tropitech.org</a></li>
                <li><a href="https://tropichat.chat">tropichat.chat</a></li>
                <li><a href="https://tropitech.org">tropitech.org</a></li>
              </ul>
            </div>
          </div>
          <div className="lp-colophon">
            <span>© 2026 Caye by TropiTech · Made on island time, on purpose.</span>
            <span>Nassau · Bahamas · Caribbean-wide soon</span>
          </div>
        </div>
      </footer>

    </div>
  )
}
