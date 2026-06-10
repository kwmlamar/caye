// Marketing render of the dashboard. Not connected to data — every value
// here is a static prop. Matches the live dashboard's typography + spacing
// so what prospects see on the landing is what they'll see after signup.

const INBOX = [
  {
    who: 'Maya Castro',
    preview: 'Caye replied · sunset sail confirmed for Saturday',
    status: 'replied' as const,
    time: '6 min',
  },
  {
    who: 'James Whitfield',
    preview: 'Caye replied · group of 4 booked, deposit link sent',
    status: 'replied' as const,
    time: '14 min',
  },
  {
    who: 'Daniel Russo',
    preview: 'Held for your call · custom full-day charter request',
    status: 'held' as const,
    time: '32 min',
  },
]

export function DashboardMockup() {
  return (
    <section className="relative bg-gradient-to-b from-cream to-[#f3eee5] py-24 md:py-32 px-6 overflow-hidden">
      {/* Soft caribbean glow behind the frame */}
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px] bg-caribbean-teal/[0.06] blur-[120px] pointer-events-none" />

      <div className="relative max-w-6xl mx-auto">
        {/* Editorial caption */}
        <div className="text-center mb-14 md:mb-16">
          <div className="flex items-center justify-center gap-3 mb-6">
            <span className="h-px w-8 bg-near-black/25" />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-near-black/60 font-medium">
              Inside Caye
            </span>
            <span className="h-px w-8 bg-near-black/25" />
          </div>
          <h2 className="font-instrument text-4xl md:text-5xl lg:text-6xl tracking-[-0.024em] text-near-black leading-[1.02]">
            What you&rsquo;ll{' '}
            <span className="italic text-caribbean-teal-deep">actually see</span>.
          </h2>
          <p className="mt-5 font-newsreader font-light text-[1.1rem] md:text-[1.2rem] text-near-black/70 max-w-md mx-auto leading-snug">
            One screen. Your inbox, your calendar, and Caye &mdash; all in one place.
          </p>
        </div>

        {/* Browser frame */}
        <div className="rounded-2xl border border-near-black/10 bg-white overflow-hidden shadow-[0_30px_80px_-24px_rgba(14,26,26,0.28)]">
          {/* Window chrome */}
          <div className="flex items-center gap-3 px-4 py-3 bg-near-black/[0.025] border-b border-near-black/[0.06]">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
            </div>
            <div className="flex-1 flex justify-center">
              <span className="font-mono text-[10.5px] text-near-black/50 bg-white/80 border border-near-black/[0.06] px-3 py-1 rounded-md">
                meetcaye.com/dashboard
              </span>
            </div>
            <div className="w-12" />
          </div>

          {/* Dashboard body */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_340px] min-h-[520px]">
            {/* ── Main column ─────────────────────────────── */}
            <div className="p-10 md:p-14 border-b md:border-b-0 md:border-r border-near-black/[0.06] bg-gradient-to-br from-white via-white to-[#f7f4ed] relative">
              {/* Greeting */}
              <h3 className="font-instrument text-4xl md:text-5xl text-near-black leading-[1.05] tracking-[-0.022em]">
                Morning,{' '}
                <span className="italic text-caribbean-teal-deep">Marie</span>.
              </h3>
              <p className="mt-3 text-[13.5px] text-near-black/55 leading-snug">
                Everything&rsquo;s handled. 3 bookings confirmed overnight, 2 replies sent, 1 message held for your call.
              </p>

              {/* Caye chat bubble */}
              <div className="mt-10 flex items-start gap-3 max-w-md">
                <div className="w-8 h-8 rounded-full bg-near-black flex items-center justify-center text-cream text-[11px] font-semibold flex-shrink-0 font-instrument italic">
                  C
                </div>
                <div className="flex-1">
                  <div className="bg-near-black/[0.04] border border-near-black/[0.04] rounded-2xl rounded-tl-md px-4 py-3">
                    <p className="text-[13px] text-near-black/85 leading-relaxed">
                      Replied to two booking inquiries this morning &mdash; both confirmed for Saturday. Held one note from Daniel; he&rsquo;s asking about a custom full-day charter on your scheduled day off. Want to look?
                    </p>
                  </div>
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-near-black/40 mt-1.5 block ml-1">
                    Caye &middot; 7:42 AM
                  </span>
                </div>
              </div>

              {/* Input strip */}
              <div className="mt-12 rounded-xl border border-near-black/[0.1] bg-white px-4 py-3 flex items-center gap-3 shadow-[0_2px_8px_-2px_rgba(14,26,26,0.06)]">
                <span className="text-[13px] text-near-black/35 flex-1">
                  Ask Caye anything&hellip;
                </span>
                <span className="font-mono text-[10px] text-near-black/40 border border-near-black/[0.1] px-1.5 py-0.5 rounded">
                  ⏎
                </span>
              </div>

              {/* Quick action chips */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                {[
                  'Catch me up',
                  'Draft a reply',
                ].map((label) => (
                  <button
                    key={label}
                    className="text-left text-[11.5px] text-near-black/60 rounded-lg border border-near-black/[0.06] bg-white/60 px-3 py-2 hover:border-near-black/[0.12] transition-colors"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Inbox column ────────────────────────────── */}
            <div className="p-6 bg-white">
              <div className="flex items-center justify-between mb-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-near-black/50 font-semibold">
                  Inbox &middot; today
                </span>
                <span className="font-mono text-[10px] text-near-black/35">3</span>
              </div>
              <div className="space-y-2.5">
                {INBOX.map((row, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-near-black/[0.06] hover:border-near-black/[0.14] transition-colors p-3 bg-white"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[12.5px] font-medium text-near-black">
                        {row.who}
                      </span>
                      <span
                        className={`font-mono text-[9px] uppercase tracking-[0.12em] font-semibold ${
                          row.status === 'held'
                            ? 'text-[#c94824]'
                            : 'text-[#0a8475]'
                        }`}
                      >
                        {row.status === 'held' ? 'Held' : 'Replied'}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-near-black/55 leading-snug line-clamp-2">
                      {row.preview}
                    </p>
                    <span className="font-mono text-[9.5px] text-near-black/35 mt-1.5 block">
                      {row.time} ago
                    </span>
                  </div>
                ))}
              </div>

              {/* Tab strip below — Bookings / Calendar / Contacts */}
              <div className="mt-6 pt-4 border-t border-near-black/[0.06] flex items-center justify-between text-[11px] text-near-black/45 font-mono uppercase tracking-[0.14em]">
                <span>Bookings</span>
                <span>Calendar</span>
                <span>Contacts</span>
              </div>
            </div>
          </div>
        </div>

        {/* Caption beneath frame */}
        <p className="mt-8 text-center font-newsreader italic text-[14px] text-near-black/55 max-w-lg mx-auto">
          One screen, every channel. Caye handles the inbox so you can run the business.
        </p>
      </div>
    </section>
  )
}
