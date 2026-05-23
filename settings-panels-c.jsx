// =========================================================
// Caye — Settings panels (Team, Billing) + SaveBar
// =========================================================

// ---------------- SAVE BAR (shared) ----------------
const SaveBar = ({ changes }) => (
  <div className="save-bar">
    <div className="changes">
      {changes ? (
        <>
          <span className="pip"></span>
          <span>{changes} unsaved {changes === 1 ? "change" : "changes"}</span>
        </>
      ) : (
        <span>All changes saved · <span style={{ color: "var(--ink-soft)" }}>just now</span></span>
      )}
    </div>
    <button className="btn-ghost">Discard</button>
    <button className="btn-solid">Save changes</button>
  </div>
);

// ---------------- 5. TEAM ----------------
const TEAM = [
  { name: "Karenda Munroe",  email: "karenda@karendastours.com", role: "Owner",        status: "active",  you: true },
  { name: "Devon Reyes",     email: "devon@karendastours.com",   role: "Manager",      status: "active" },
  { name: "Marisol Choc",    email: "marisol@karendastours.com", role: "Tour guide",   status: "active" },
  { name: "Jamal Williams",  email: "jamal.w@gmail.com",         role: "Tour guide",   status: "pending" },
];

const TeamPanel = () => {
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole]   = React.useState("Tour guide");

  return (
    <div className="set-page" data-screen-label="Settings — Team">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Team</div>
          <h1>Who's on the dock</h1>
          <p className="set-page-desc">Add the people who help you run tours. Owners and Managers see every conversation; Tour guides only see chats for the trips they're assigned to.</p>
        </div>
        <div className="ph-right">
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--ink-mute)", letterSpacing: ".04em" }}>
            {TEAM.filter((t) => t.status === "active").length} active · {TEAM.filter((t) => t.status === "pending").length} pending
          </span>
        </div>
      </header>

      <section className="s-card">
        <div className="team-table">
          <div className="team-row head">
            <span>Member</span>
            <span>Role</span>
            <span>Status</span>
            <span></span>
          </div>
          {TEAM.map((m, i) => (
            <div className="team-row" key={i}>
              <div className="team-who">
                <Avatar name={m.name} size={34} />
                <div>
                  <div className="nm">
                    {m.name}
                    {m.you && <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: "var(--ink-mute)", letterSpacing: ".1em", marginLeft: 8, padding: "2px 6px", background: "var(--bg-deep)", borderRadius: 4, fontWeight: 600, textTransform: "uppercase" }}>You</span>}
                  </div>
                  <div className="em">{m.email}</div>
                </div>
              </div>
              <select className="role-select" defaultValue={m.role} disabled={m.you}>
                <option>Owner</option>
                <option>Manager</option>
                <option>Tour guide</option>
                <option>Viewer</option>
              </select>
              <span className={"team-status " + m.status}>
                <span className="pip"></span>
                {m.status === "active" ? "Active" : "Invited"}
              </span>
              <button className="team-more" disabled={m.you}><SIcon name="more" size={16} /></button>
            </div>
          ))}
        </div>
        <div className="invite-row">
          <div className="s-input-affix" style={{ flex: 1 }}>
            <span className="prefix">@</span>
            <input
              placeholder="teammate@karendastours.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <select className="role-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} style={{ width: 140 }}>
            <option>Owner</option>
            <option>Manager</option>
            <option>Tour guide</option>
            <option>Viewer</option>
          </select>
          <button className="btn-solid"><SIcon name="plus" size={13} /> Send invite</button>
        </div>
        <div className="s-card-foot">
          <span>Invites expire after 7 days · Your Growth plan includes <b style={{ color: "var(--ink)" }}>up to 8 members</b></span>
          <button className="btn-ghost sm">Role permissions</button>
        </div>
      </section>
    </div>
  );
};

// ---------------- 6. BILLING ----------------
const FEATURES = [
  { in: true,  label: "5 connected channels",       sub: "WhatsApp · Instagram · Messenger · Email · SMS" },
  { in: true,  label: "Caye AI auto-reply",         sub: "Unlimited messages · all 5 channels" },
  { in: true,  label: "Up to 8 team members",       sub: "Roles + tour-guide scoped access" },
  { in: true,  label: "Booking page + payments",    sub: "Stripe & Wise · 1.9% transaction fee" },
  { in: true,  label: "Daily summary email",        sub: "Tomorrow's tours, today's bookings" },
  { in: false, label: "Multiple locations",         sub: "Run more than one operation from one inbox" },
  { in: false, label: "Caye AI custom voice clone", sub: "Train Caye on 50 of your past replies" },
  { in: false, label: "Cruise-line API integration",sub: "Pull manifests from Carnival, Royal Caribbean, NCL" },
];

const BillingPanel = () => (
  <div className="set-page" data-screen-label="Settings — Billing">
    <header className="set-page-head">
      <div className="ph-left">
        <div className="set-page-eyebrow"><span className="dot"></span>Billing</div>
        <h1>Plan & usage</h1>
        <p className="set-page-desc">You're on the Growth plan — trial ends in 12 days. Switch any time; we'll prorate the difference.</p>
      </div>
    </header>

    <div className="plan-card">
      <div className="plan-head">
        <div>
          <div className="plan-tag"><span className="dot"></span>Current plan</div>
          <div className="plan-name">Growth</div>
          <div className="plan-sub">Built for owner-operators running 50–300 tours a month across multiple channels, with Caye AI handling the bulk of the inbox.</div>
        </div>
        <div className="plan-price">
          <div className="amt"><span className="cur">$</span>89</div>
          <div className="per">per month</div>
        </div>
      </div>

      <div className="plan-meter">
        <div>
          <div className="k">Conversations</div>
          <div className="v">1,284 <small>/ 3,000</small></div>
          <div className="bar"><span style={{ width: "43%" }}></span></div>
        </div>
        <div>
          <div className="k">Team seats</div>
          <div className="v">4 <small>/ 8</small></div>
          <div className="bar"><span style={{ width: "50%" }}></span></div>
        </div>
        <div>
          <div className="k">Caye AI replies</div>
          <div className="v">887 <small>this month</small></div>
          <div className="bar"><span style={{ width: "72%", background: "var(--sun)" }}></span></div>
        </div>
      </div>

      <div className="plan-foot">
        <div className="renew">Trial ends May 28 · then renews monthly</div>
        <button className="btn-upgrade">Upgrade to Reef <SIcon name="chev" size={14} /></button>
      </div>
    </div>

    <section className="s-card">
      <div className="s-card-head">
        <div className="h"><h3>What's in your plan</h3><div className="desc">Everything Growth includes, plus what you'd unlock on Reef.</div></div>
        <a href="#" style={{ fontSize: 12.5, color: "var(--teal)", fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>Compare plans <SIcon name="external" size={12} /></a>
      </div>
      <div className="s-card-body">
        <div className="features-grid">
          {FEATURES.map((f, i) => (
            <div key={i} className={"feature-item" + (f.in ? "" : " locked")}>
              <span className="tick">
                {f.in ? <SIcon name="tick" size={11} /> : <SIcon name="lock" size={11} />}
              </span>
              <div className="ft">{f.label}<small>{f.sub}</small></div>
            </div>
          ))}
        </div>
      </div>
      <div className="s-card-foot">
        <span>Payment method · <b style={{ color: "var(--ink)" }}>Visa ending 4418</b> · expires 09/27</span>
        <button className="btn-ghost sm">Update card</button>
      </div>
    </section>

    <section className="s-card">
      <div className="s-card-head">
        <div className="h"><h3>Invoices</h3><div className="desc">Last 3 months · receipts emailed to karenda@karendastours.com</div></div>
      </div>
      <div className="team-table">
        {[
          { d: "May 1, 2026", a: "$89.00", n: "INV-2026-0073", s: "Paid" },
          { d: "Apr 1, 2026", a: "$89.00", n: "INV-2026-0052", s: "Paid" },
          { d: "Mar 1, 2026", a: "$89.00", n: "INV-2026-0031", s: "Paid" },
        ].map((iv, i) => (
          <div className="team-row" key={i} style={{ gridTemplateColumns: "1fr 140px 110px 32px" }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{iv.d}</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-mute)", fontFamily: "'JetBrains Mono', monospace", letterSpacing: ".04em", marginTop: 1 }}>{iv.n}</div>
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", fontFeatureSettings: "'tnum'" }}>{iv.a}</span>
            <span className="team-status active"><span className="pip"></span>{iv.s}</span>
            <button className="team-more"><SIcon name="external" size={14} /></button>
          </div>
        ))}
      </div>
    </section>
  </div>
);

Object.assign(window, { SaveBar, TeamPanel, BillingPanel });
