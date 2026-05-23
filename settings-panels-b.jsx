// =========================================================
// Caye — Settings panels (Caye AI, Notifications, Team, Billing)
// =========================================================

// ---------------- 3. CAYE AI ----------------
const TONES = [
  { id: "friendly",     icon: "🌴", title: "Friendly",     desc: "Warm, conversational. Uses guest's name. Light use of \"!\" — fits cruise day-trippers." },
  { id: "professional", icon: "📋", title: "Professional", desc: "Polished, concise, fact-first. Good for tour operators, corporate clients, hotel concierges." },
  { id: "casual",       icon: "🤙", title: "Casual",       desc: "Relaxed, local. Caye uses island phrasing — \"no worries, mon\" stays in." },
];
const DELAYS = [
  { id: "0",   label: "Instant" },
  { id: "30",  label: "30s" },
  { id: "60",  label: "1m" },
  { id: "120", label: "2m" },
  { id: "300", label: "5m" },
];

const CayePanel = () => {
  const [autoReply, setAutoReply] = React.useState(true);
  const [holdHours, setHoldHours] = React.useState(true);
  const [tone, setTone] = React.useState("friendly");
  const [delay, setDelay] = React.useState("60");
  const [context, setContext] = React.useState(
    "We operate from San Pedro, Ambergris Caye. Half-day snorkel trips to Hol Chan & Shark Ray Alley depart 8:30am and 1:00pm. Full-day to Blue Hole departs 6:00am, weather permitting.\n\nKids under 8 ride free on the snorkel trip but need a parent. We accept USD and BZD cash, Visa/Mastercard, and bank transfer.\n\nPickup from any San Pedro hotel is free. Cruise-ship guests must be back at the tender pier by 3:30pm sharp."
  );
  const [topics, setTopics] = React.useState([
    { id: 1, label: "Refund requests", desc: "Anything mentioning refund, cancel, money back" },
    { id: 2, label: "Medical conditions", desc: "Pregnancy, heart, diving certifications, asthma" },
    { id: 3, label: "Group bookings 8+", desc: "Pricing for large groups should always go to Karenda" },
    { id: 4, label: "Custom itinerary", desc: "Anything not on the standard tour menu" },
    { id: 5, label: "Cruise ship delays", desc: "Guests reporting ship delays or missed connections" },
  ]);
  const [newTopic, setNewTopic] = React.useState("");
  const addTopic = () => {
    if (!newTopic.trim()) return;
    setTopics([...topics, { id: Date.now(), label: newTopic.trim(), desc: "Added by Karenda · just now" }]);
    setNewTopic("");
  };

  return (
    <div className="set-page" data-screen-label="Settings — Caye AI">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Caye AI</div>
          <h1>Your AI host</h1>
          <p className="set-page-desc">Caye is the AI that answers guests when you can't. Set her voice, what she knows, and when she should pull you in.</p>
        </div>
      </header>

      <div className="caye-banner">
        <div className="cb-mark">C</div>
        <div className="cb-body">
          <div className="cb-title">Caye handled 142 conversations this week</div>
          <div className="cb-desc">She drafted 87 replies you sent without edits, booked 11 tours autonomously, and escalated 9 to you. Average handle time: 3m 12s.</div>
          <div className="cb-stat">
            <div className="cb-stat-item"><b>94%</b>autonomous</div>
            <div className="cb-stat-item"><b>11</b>booked</div>
            <div className="cb-stat-item"><b>9</b>escalated</div>
            <div className="cb-stat-item"><b>3m 12s</b>avg handle</div>
          </div>
        </div>
      </div>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h"><h3>Status & schedule</h3><div className="desc">Caye answers automatically when she's on. Set quiet hours so she doesn't ping guests at 3am.</div></div>
        </div>
        <div className="s-card-body" style={{ gap: 0 }}>
          <div className="s-toggle-row">
            <div className="tr-left">
              <div className="tr-title">Auto-reply enabled</div>
              <div className="tr-desc">When on, Caye replies to incoming messages across all connected channels. You can still take over any conversation from the inbox.</div>
            </div>
            <Toggle on={autoReply} onChange={setAutoReply} />
          </div>
          <div className="s-toggle-row">
            <div className="tr-left">
              <div className="tr-title">Hold messages during quiet hours <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--ink-mute)", marginLeft: 6, fontWeight: 400 }}>10:00pm – 6:30am</span></div>
              <div className="tr-desc">Caye still drafts replies but waits until business hours to send. Urgent topics in your escalation list bypass this.</div>
            </div>
            <Toggle on={holdHours} onChange={setHoldHours} />
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h"><h3>Voice & tone</h3><div className="desc">How Caye sounds. You can change this anytime — she'll regenerate her response style on the next message.</div></div>
        </div>
        <div className="s-card-body">
          <div className="radio-cards">
            {TONES.map((t) => (
              <button key={t.id} className={"radio-card" + (tone === t.id ? " on" : "")} onClick={() => setTone(t.id)}>
                <span className="rc-check"></span>
                <span className="rc-icon">{t.icon}</span>
                <span className="rc-title">{t.title}</span>
                <span className="rc-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="s-row" style={{ marginTop: 8 }}>
            <div className="s-label">Response delay<span className="help">Adds a brief wait so replies don't feel robotic.</span></div>
            <div className="s-field">
              <div className="s-seg">
                {DELAYS.map((d) => (
                  <button key={d.id} className={delay === d.id ? "on" : ""} onClick={() => setDelay(d.id)}>{d.label}</button>
                ))}
              </div>
              <div className="s-help">
                {delay === "0"
                  ? "Caye replies the instant a message arrives."
                  : `Caye waits ${DELAYS.find((d) => d.id === delay).label} before sending. Feels more like a real person typing.`}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>What Caye should know</h3>
            <div className="desc">Drop in everything specific to your operation. Pricing, schedules, what to say about weather, your refund policy, the tone of your typical messages.</div>
          </div>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, letterSpacing: ".1em", color: "var(--ink-faint)", fontWeight: 600, textTransform: "uppercase" }}>
            {context.length} / 4000
          </span>
        </div>
        <div className="s-card-body">
          <textarea
            className="s-textarea"
            style={{ minHeight: 200 }}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Tell Caye about your tours, prices, pickup locations, refund policy, anything she'd need to answer a guest…"
          />
          <div className="s-help" style={{ marginTop: 0 }}>
            <SIcon name="tick" size={12} /> Saved 4 minutes ago · Caye re-trains on this every time you edit.
          </div>
        </div>
      </section>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Escalate to a human</h3>
            <div className="desc">When a message matches one of these topics, Caye stops, drafts a reply for your review, and notifies you. She never sends on these.</div>
          </div>
        </div>
        <div className="topic-list" style={{ margin: "18px 22px 0", borderRadius: 10 }}>
          {topics.map((t) => (
            <div key={t.id} className="topic-item">
              <span className="ti-icon"><SIcon name="warn" size={14} /></span>
              <div className="ti-body">
                <div className="ti-name">{t.label}</div>
                <div className="ti-desc">{t.desc}</div>
              </div>
              <button className="btn-ghost sm danger" onClick={() => setTopics(topics.filter((x) => x.id !== t.id))}>Remove</button>
            </div>
          ))}
        </div>
        <div className="s-card-body" style={{ paddingTop: 14 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="Add a topic — e.g. 'lost passport', 'shark allergies'…"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTopic()}
            />
            <button className="btn-solid" onClick={addTopic}><SIcon name="plus" size={13} /> Add topic</button>
          </div>
        </div>
      </section>

      <SaveBar changes={3} />
    </div>
  );
};

// ---------------- 4. NOTIFICATIONS ----------------
const NotificationsPanel = () => {
  const [prefs, setPrefs] = React.useState({
    newMsg:   { push: true,  email: false },
    booking:  { push: true,  email: true  },
    cayeHold: { push: true,  email: false },
    daily:    { push: false, email: true  },
  });
  const set = (k, ch, v) => setPrefs({ ...prefs, [k]: { ...prefs[k], [ch]: v } });

  const rows = [
    { k: "newMsg",   title: "New message",        desc: "A guest sent a new message that's waiting for you or Caye." },
    { k: "booking",  title: "Booking created",    desc: "A new tour booking landed — from any channel or your booking page." },
    { k: "cayeHold", title: "Caye held for review",desc: "Caye drafted a reply but held it for you (matched an escalation topic, or low confidence)." },
    { k: "daily",    title: "Daily summary",      desc: "Email at 6:30pm with tomorrow's tours, today's bookings, and pending guests." },
  ];

  return (
    <div className="set-page" data-screen-label="Settings — Notifications">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Notifications</div>
          <h1>What you hear about</h1>
          <p className="set-page-desc">Pick which events ping your phone and which ones land in your inbox. Quiet hours from Caye AI apply here too.</p>
        </div>
      </header>

      <section className="s-card">
        <div className="s-card-head">
          <div className="h"><h3>Alerts</h3><div className="desc">Push notifications go to the Caye mobile app on Karenda's phone.</div></div>
          <div style={{ display: "flex", gap: 24, paddingRight: 4 }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".14em", color: "var(--ink-faint)", fontWeight: 600, textTransform: "uppercase", width: 50, textAlign: "center" }}>Push</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".14em", color: "var(--ink-faint)", fontWeight: 600, textTransform: "uppercase", width: 50, textAlign: "center" }}>Email</span>
          </div>
        </div>
        <div className="s-card-body" style={{ gap: 0 }}>
          {rows.map((r) => (
            <div className="s-toggle-row" key={r.k}>
              <div className="tr-left">
                <div className="tr-title">{r.title}</div>
                <div className="tr-desc">{r.desc}</div>
              </div>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <span style={{ width: 50, display: "flex", justifyContent: "center" }}>
                  <Toggle on={prefs[r.k].push} onChange={(v) => set(r.k, "push", v)} />
                </span>
                <span style={{ width: 50, display: "flex", justifyContent: "center" }}>
                  <Toggle on={prefs[r.k].email} onChange={(v) => set(r.k, "email", v)} />
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="s-card-foot">
          <span>Sending to <b style={{ color: "var(--ink)" }}>karenda@karendastours.com</b> and 1 device</span>
          <button className="btn-ghost sm">Manage devices</button>
        </div>
      </section>

      <SaveBar />
    </div>
  );
};

Object.assign(window, { CayePanel, NotificationsPanel });
