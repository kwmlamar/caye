// =========================================================
// Caye — Settings panels (one per nav section)
// =========================================================

// ---------------- 1. PROFILE ----------------
const ProfilePanel = () => {
  const [biz, setBiz] = React.useState("Karenda's Tours");
  const [tz, setTz] = React.useState("America/Belize (GMT-6)");
  const [slug, setSlug] = React.useState("karenda-tours");
  const [email, setEmail] = React.useState("karenda@karendastours.com");

  return (
    <div className="set-page" data-screen-label="Settings — Profile">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Profile</div>
          <h1>Business identity</h1>
          <p className="set-page-desc">How your tour business appears to guests across every channel — booking pages, automated replies, and receipts.</p>
        </div>
        <div className="ph-right">
          <button className="btn-ghost"><SIcon name="external" size={14} /> View public page</button>
        </div>
      </header>

      <section className="s-card">
        <div className="s-card-head"><div className="h"><h3>Identity</h3><div className="desc">Shown to guests in chat headers, confirmation emails and your booking page.</div></div></div>
        <div className="s-card-body">
          <div className="s-row">
            <div className="s-label">Business logo<span className="help">PNG or SVG, square, min 512px.</span></div>
            <div className="s-field">
              <div className="logo-upload">
                <div className="logo-preview">K</div>
                <div className="logo-actions">
                  <div className="logo-buttons">
                    <button className="btn-solid sm"><SIcon name="upload" size={13} /> Upload new</button>
                    <button className="btn-ghost sm danger">Remove</button>
                  </div>
                  <div className="logo-hint">karenda-tours-logo.png · 96 kb</div>
                </div>
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Business name</div>
            <div className="s-field">
              <input className="s-input" value={biz} onChange={(e) => setBiz(e.target.value)} />
              <div className="s-help">Displayed as the sender name on all outbound messages.</div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Booking page URL</div>
            <div className="s-field">
              <div className="s-input-affix">
                <span className="prefix">tropichat.co/</span>
                <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
                <span className="suffix">/book</span>
              </div>
              <div className="s-help"><span className="mono">https://tropichat.co/{slug}/book</span></div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Contact email<span className="help">Replies and guest receipts come from here.</span></div>
            <div className="s-field">
              <input className="s-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>

          <div className="s-row">
            <div className="s-label">Timezone</div>
            <div className="s-field">
              <select className="s-input" value={tz} onChange={(e) => setTz(e.target.value)}>
                <option>America/Belize (GMT-6)</option>
                <option>America/Jamaica (GMT-5)</option>
                <option>America/Barbados (GMT-4)</option>
                <option>America/Nassau (GMT-5)</option>
                <option>America/Santo_Domingo (GMT-4)</option>
              </select>
              <div className="s-help">Used for response delays, the daily summary, and tour scheduling.</div>
            </div>
          </div>
        </div>
      </section>

      <SaveBar />
    </div>
  );
};

// ---------------- 2. CHANNELS ----------------
const CHANNELS = [
  { id: "wa", name: "WhatsApp Business", handle: "+501 622-4418", bg: "#22c55e", label: "W", on: true,
    stat: { last7: 142, response: "1m 24s" }, since: "Connected Mar 2024" },
  { id: "ig", name: "Instagram", handle: "@karendas.tours", bg: "linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)", label: "IG", on: true,
    stat: { last7: 38, response: "4m 02s" }, since: "Connected Aug 2024" },
  { id: "fb", name: "Messenger", handle: "fb.me/karendastours", bg: "#3b82f6", label: "M", on: true,
    stat: { last7: 21, response: "2m 47s" }, since: "Connected Mar 2024" },
  { id: "em", name: "Email", handle: "karenda@karendastours.com", bg: "var(--ink)", label: "@", on: true,
    stat: { last7: 56, response: "12m 30s" }, since: "Connected Mar 2024" },
  { id: "sms", name: "SMS", handle: "Not connected", bg: "#6b7681", label: "#", on: false,
    note: "Cruise-line guests often arrive without WhatsApp data. SMS catches them at the dock." },
];

const ChannelsPanel = () => (
  <div className="set-page" data-screen-label="Settings — Channels">
    <header className="set-page-head">
      <div className="ph-left">
        <div className="set-page-eyebrow"><span className="dot"></span>Channels</div>
        <h1>Where guests reach you</h1>
        <p className="set-page-desc">Every connected channel funnels into the same Caye inbox. Caye AI replies on all connected channels by default.</p>
      </div>
      <div className="ph-right">
        <button className="btn-ghost">Test inbound message</button>
      </div>
    </header>

    <div className="channels-grid">
      {CHANNELS.map((ch) => (
        <div key={ch.id} className={"channel-card" + (ch.on ? " connected" : "")}>
          <div className="channel-head">
            <span className="channel-mark" style={{ background: ch.bg }}>{ch.label}</span>
            <div className="channel-info">
              <div className="channel-name">{ch.name}</div>
              <div className="channel-meta">{ch.handle}</div>
            </div>
            <span className={"channel-status " + (ch.on ? "on" : "off")}>
              <span className="pip"></span>
              {ch.on ? "Connected" : "Off"}
            </span>
          </div>
          <div className="channel-body">
            {ch.on ? (
              <>
                <div className="stat"><b>{ch.stat.last7}</b> messages last 7 days</div>
                <div className="stat">Avg response <b>{ch.stat.response}</b></div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--ink-mute)", lineHeight: 1.5 }}>{ch.note}</div>
            )}
          </div>
          <div className="channel-foot">
            <span style={{ fontSize: 11.5, color: "var(--ink-faint)", fontFamily: "'JetBrains Mono', monospace", letterSpacing: ".04em" }}>
              {ch.since || "—"}
            </span>
            {ch.on ? (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn-ghost sm">Configure</button>
                <button className="btn-ghost sm danger">Disconnect</button>
              </div>
            ) : (
              <button className="btn-solid sm"><SIcon name="plus" size={12} /> Connect</button>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
);

Object.assign(window, { ProfilePanel, ChannelsPanel });
