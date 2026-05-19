// =========================================================
// Screen: CHATS
// =========================================================

const ChatsScreen = ({ activeId, setActiveId, openCaye }) => {
  const active = CONVERSATIONS.find((c) => c.id === activeId) || CONVERSATIONS[0];
  const [filter, setFilter] = React.useState("all"); // all | unread | caye-held

  const filtered = CONVERSATIONS.filter((c) => {
    if (filter === "unread") return c.unread > 0;
    if (filter === "caye-held") return c.cayeStatus === "held";
    return true;
  });

  return (
    <div className="chats-screen">
      {/* INBOX LIST */}
      <aside className="inbox-col">
        <div className="inbox-head">
          <div className="inbox-title">
            <h2>Chats</h2>
            <span className="count-pill">126</span>
          </div>
          <div className="search">
            <span className="ico">⌕</span>
            <input placeholder="Search messages, names…" />
          </div>
          <div className="seg">
            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
            <button className={filter === "unread" ? "on" : ""} onClick={() => setFilter("unread")}>Unread <span className="seg-count">4</span></button>
            <button className={filter === "caye-held" ? "on" : ""} onClick={() => setFilter("caye-held")}>
              <span className="caye-dot"></span> Caye held <span className="seg-count">2</span>
            </button>
          </div>
        </div>

        <div className="inbox-list">
          {filtered.map((c) => (
            <button
              key={c.id}
              className={"conv-row" + (c.id === activeId ? " active" : "")}
              onClick={() => setActiveId(c.id)}
            >
              <div className="conv-av-wrap">
                <Avatar name={c.name} size={40} />
                <span className="conv-channel">
                  <ChannelIc ch={c.channel} size={16} />
                </span>
              </div>
              <div className="conv-body">
                <div className="conv-line1">
                  <span className="conv-name">{c.name}</span>
                  <span className="conv-time">{c.time}</span>
                </div>
                <div className="conv-line2">
                  <span className="conv-preview">{c.preview}</span>
                  {c.unread > 0 && <span className="conv-unread">{c.unread}</span>}
                </div>
                {c.cayeStatus && c.cayeStatus !== "none" && (
                  <div className={"conv-caye " + c.cayeStatus}>
                    <span className="caye-pip"></span>
                    <span>
                      {c.cayeStatus === "replied" && "Caye replied"}
                      {c.cayeStatus === "drafted" && "Caye drafted"}
                      {c.cayeStatus === "held" && "Caye held"}
                    </span>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* THREAD PANE */}
      <section className="thread-col">
        <header className="thread-head">
          <div className="thread-who">
            <Avatar name={active.name} size={42} />
            <div>
              <div className="thread-name">{active.name}</div>
              <div className="thread-role">
                <ChannelIc ch={active.channel} size={14} /> {active.role}
              </div>
            </div>
          </div>
          <div className="thread-actions">
            <span className="ai-toggle header">
              <span className="ai-toggle-track on"><span className="ai-toggle-thumb"></span></span>
              Caye auto-reply
            </span>
            <button className="ghost-btn" title="Open contact">View contact</button>
            <button className="ghost-btn" title="Book this guest">+ Booking</button>
            <button className="ghost-btn icon-only" title="More">⋯</button>
          </div>
        </header>

        {/* Caye status strip — one clean line */}
        <div className={"caye-strip " + (active.cayeStatus || "none")}>
          <CayeMark size={14} />
          <span className="caye-strip-text">{active.cayeNote}</span>
        </div>

        <div className="thread-body">
          <div className="day-divider"><span>Today · Apr 28</span></div>

          {(active.thread || [
            { side: "in", text: active.preview, time: active.time },
          ]).map((m, i) =>
            m.side === "caye-action" ? (
              <div key={i} className="caye-action">
                <CayeMark size={16} />
                <span>{m.text}</span>
              </div>
            ) : (
              <div key={i} className={"msg-row " + m.side}>
                {m.side === "in" && <Avatar name={active.name} size={28} />}
                <div className="msg-stack">
                  {m.cayeDrafted && (
                    <div className="msg-caye-tag">
                      <CayeMark size={14} /> Drafted by Caye · sent as {m.sentAs}
                    </div>
                  )}
                  <div className={"bubble " + m.side}>{m.text}</div>
                  <div className="msg-time">{m.time}</div>
                </div>
              </div>
            )
          )}

          {/* Quick suggestions strip */}
          {active.cayeStatus === "replied" && (
            <div className="caye-suggest">
              <span className="caye-suggest-label"><CayeMark size={14} /> Caye suggests follow-ups</span>
              <div className="suggest-chips">
                <button>Send pickup details</button>
                <button>Offer add-on: GoPro rental</button>
                <button>Ask about dietary restrictions</button>
              </div>
            </div>
          )}
        </div>

        <footer className="reply-box">
          <div className="reply-tabs">
            <button className="rt on">Reply</button>
            <button className="rt">Internal note</button>
          </div>
          <textarea placeholder={`Write back to ${active.name.split(" ")[0]}…`} defaultValue="" />
          <div className="reply-footer">
            <div className="reply-tools">
              <button title="Attach" aria-label="Attach">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 4 5.8 8.7a2.4 2.4 0 1 0 3.4 3.4l5-5a4 4 0 1 0-5.7-5.6L3.4 6.6"/></svg>
              </button>
              <button title="Template" aria-label="Template">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M2.5 6.5h11M5.5 9.5h5M5.5 11h3"/></svg>
              </button>
              <button title="Ask Caye" aria-label="Ask Caye" className="caye-btn icon-only" onClick={openCaye}>
                <CayeMark size={14} />
              </button>
            </div>
            <button className="btn-send">Send</button>
          </div>
        </footer>
      </section>
    </div>
  );
};

// =========================================================
// Screen: CONTACTS
// =========================================================

const ContactsScreen = () => {
  const [activeId, setActiveId] = React.useState("p2");
  const [q, setQ] = React.useState("");
  const list = CONTACTS.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase())
  );
  const active = CONTACTS.find((c) => c.id === activeId) || CONTACTS[0];
  const bookings = CONTACT_BOOKINGS[active.id] || [];

  return (
    <div className="contacts-screen">
      <aside className="contacts-list">
        <div className="ct-head">
          <div className="inbox-title">
            <h2>Contacts</h2>
            <span className="count-pill">412</span>
          </div>
          <div className="search">
            <span className="ico">⌕</span>
            <input placeholder="Find by name, phone, email…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="seg">
            <button className="on">All</button>
            <button>VIPs <span className="seg-count">28</span></button>
            <button>Cruise <span className="seg-count">61</span></button>
            <button>Locals <span className="seg-count">94</span></button>
          </div>
        </div>

        <div className="ct-table">
          <div className="ct-table-head">
            <span>Name</span>
            <span>Channel</span>
            <span>Bookings</span>
            <span>Last seen</span>
          </div>
          {list.map((c) => (
            <button
              key={c.id}
              className={"ct-row" + (c.id === activeId ? " active" : "")}
              onClick={() => setActiveId(c.id)}
            >
              <span className="ct-name">
                <Avatar name={c.name} size={28} />
                <div>
                  <div className="n">{c.name}</div>
                  <div className="o">{c.origin}</div>
                </div>
              </span>
              <span className="ct-ch"><ChannelIc ch={c.channel} size={18} /></span>
              <span className="ct-bk">
                {c.bookings === 0 ? <span className="muted">—</span> : c.bookings}
              </span>
              <span className="ct-ls">{c.lastSeen}</span>
            </button>
          ))}
        </div>
      </aside>

      <aside className="contact-detail">
        <div className="cd-head">
          <Avatar name={active.name} size={64} />
          <div className="cd-id">
            <h3>{active.name}</h3>
            <div className="cd-tags">
              {active.tags.map((t) => (
                <span key={t} className={"tag " + (t === "VIP" ? "vip" : t === "Cruise" ? "cruise" : "")}>
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="cd-actions">
            <button className="ghost-btn">Message</button>
            <button className="ghost-btn">+ Booking</button>
          </div>
        </div>

        <div className="cd-stats">
          <div>
            <div className="k">Lifetime bookings</div>
            <div className="v">{active.bookings}</div>
          </div>
          <div>
            <div className="k">Channel</div>
            <div className="v inline"><ChannelIc ch={active.channel} size={16} /> {active.channel === "wa" ? "WhatsApp" : active.channel === "ig" ? "Instagram" : active.channel === "fb" ? "Messenger" : "Email"}</div>
          </div>
          <div>
            <div className="k">First seen</div>
            <div className="v">{active.origin}</div>
          </div>
        </div>

        <div className="cd-fields">
          <div className="cd-field">
            <div className="k">Phone</div>
            <div className="v">{active.phone}</div>
          </div>
          <div className="cd-field">
            <div className="k">Email</div>
            <div className="v">{active.email}</div>
          </div>
          <div className="cd-field">
            <div className="k">Last seen</div>
            <div className="v">{active.lastSeen}</div>
          </div>
        </div>

        <div className="cd-section">
          <div className="cd-section-head">
            <h4>Booking history</h4>
            <span className="muted">{bookings.length || 0}</span>
          </div>
          {bookings.length === 0 ? (
            <div className="cd-empty">No bookings yet — this is a fresh lead.</div>
          ) : (
            <ul className="bk-list">
              {bookings.map((b, i) => (
                <li key={i}>
                  <div className="bk-date">{b.date}</div>
                  <div className="bk-body">
                    <div className="bk-tour">{b.tour}</div>
                    <div className="bk-meta">{b.guests} guests · {b.status === "confirmed" ? <span className="st-confirmed">Confirmed</span> : b.status === "pending" ? <span className="st-pending">Pending</span> : <span className="st-done">Completed</span>}{b.source === "Caye" && <span className="bk-caye"><CayeMark size={12} /> Caye</span>}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="cd-section">
          <div className="cd-section-head">
            <h4>Notes</h4>
            <button className="ghost-btn sm">+ Add</button>
          </div>
          <textarea
            className="cd-notes"
            placeholder="Anything Caye and your team should remember about this guest…"
            defaultValue={
              active.id === "p2"
                ? "Allergic to shellfish — heads-up to chef on lunch tours. Prefers afternoon pickups."
                : active.id === "p6"
                ? "Lives in Paradise Island. Has booked under both Sandra and Daphne Sweeting (sisters). Repeat."
                : ""
            }
          />
        </div>
      </aside>
    </div>
  );
};

// =========================================================
// Screen: CALENDAR
// =========================================================

const TOUR_COLOR = {
  "Snorkel + Lunch": "var(--coral)",
  "Sunset Cruise": "var(--coral-deep)",
  "Glass-Bottom Boat": "var(--teal)",
  "Private Charter": "var(--ink)",
};

const CalendarScreen = () => {
  const hours = Array.from({ length: 11 }, (_, i) => i + 8); // 8am – 6pm

  // Convert "HH:MM" to fractional hour
  const t2h = (s) => {
    const [h, m] = s.split(":").map(Number);
    return h + m / 60;
  };

  // Each row = 56px; column begins at 8am
  const ROW_H = 56;
  const START = 8;

  const dayBookings = (d) => BOOKINGS.filter((b) => b.day === d);

  // Stats
  const totals = {
    confirmed: BOOKINGS.filter((b) => b.status === "confirmed").length,
    pending: BOOKINGS.filter((b) => b.status === "pending").length,
    caye: BOOKINGS.filter((b) => b.caye).length,
    guests: BOOKINGS.reduce((a, b) => a + b.guests, 0),
  };

  return (
    <div className="cal-screen">
      <header className="cal-head">
        <div className="cal-left">
          <h2>Calendar</h2>
          <div className="cal-nav">
            <button className="ico-btn">←</button>
            <span className="cal-range">Apr 28 – May 4, 2026</span>
            <button className="ico-btn">→</button>
            <button className="ghost-btn sm">Today</button>
          </div>
        </div>
        <div className="cal-right">
          <div className="cal-stats">
            <span><b>{totals.confirmed}</b> confirmed</span>
            <span><b>{totals.pending}</b> pending</span>
            <span className="caye"><CayeMark size={12} /> <b>{totals.caye}</b> by Caye</span>
            <span><b>{totals.guests}</b> guests</span>
          </div>
          <button className="seg-2">
            <span className="on">Week</span><span>Day</span><span>Month</span>
          </button>
          <button className="btn-primary sm">+ New booking</button>
        </div>
      </header>

      <div className="cal-grid-wrap">
        <div className="cal-week-head">
          <div className="time-gutter"></div>
          {WEEK_DAYS.map((d, i) => (
            <div key={i} className={"cal-day-head" + (i === 5 ? " today" : "")}>
              <span className="dow">{d.dow}</span>
              <span className="dnum">{d.date}</span>
              <span className="dcount">{dayBookings(i).length} tour{dayBookings(i).length !== 1 ? "s" : ""}</span>
            </div>
          ))}
        </div>

        <div className="cal-grid">
          <div className="cal-times">
            {hours.map((h) => (
              <div key={h} className="cal-time-row">
                <span className="cal-time">{h <= 12 ? h : h - 12}{h < 12 ? "am" : "pm"}</span>
              </div>
            ))}
          </div>
          {WEEK_DAYS.map((_, di) => (
            <div key={di} className={"cal-col" + (di === 5 ? " today" : "")}>
              {hours.map((h) => (
                <div key={h} className="cal-cell"></div>
              ))}
              {dayBookings(di).map((b, i) => {
                const top = (t2h(b.start) - START) * ROW_H;
                const height = Math.max(38, (t2h(b.end) - t2h(b.start)) * ROW_H - 4);
                const status = b.status;
                const cls = `bk-card ${status}` + (b.caye ? " by-caye" : "");
                return (
                  <div key={i} className={cls} style={{ top, height }}>
                    <div className="bk-top">
                      <span className="bk-time">{b.start}–{b.end}</span>
                      {b.caye && <span className="bk-caye-tag" title="Confirmed by Caye"><CayeMark size={12} /></span>}
                    </div>
                    <div className="bk-tour">{b.tour}</div>
                    <div className="bk-name">{b.name}</div>
                    <div className="bk-foot">
                      <span className="bk-guests">{b.guests} guests</span>
                      {b.ship && <span className="bk-ship">· {b.ship}</span>}
                      <span className={"bk-status " + status}>
                        {status === "confirmed" ? "Confirmed" : "Pending"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// =========================================================
// CAYE PANEL (right slide-in)
// =========================================================

const CayePanel = ({ open, onClose }) => {
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState([
    {
      from: "user",
      text: "what's still waiting on me?",
    },
    {
      from: "caye",
      text: "3 things need your touch right now:",
      bullets: CAYE_PANEL_HELD.map((h) => ({
        ch: h.channel,
        who: h.who,
        reason: h.reason,
        time: h.time,
      })),
      footer: "Everything else is replied or auto-confirmed. Want me to draft answers for any of these?",
    },
  ]);

  const onSend = () => {
    if (!input.trim()) return;
    setMessages((m) => [...m, { from: "user", text: input }]);
    setInput("");
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          from: "caye",
          text: "On it. I'll draft replies in the same tone you used with Sandra Sweeting last week and queue them for your review.",
        },
      ]);
    }, 700);
  };

  // GSAP slide
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!ref.current) return;
    gsap.to(ref.current, {
      x: open ? 0 : 360,
      duration: 0.35,
      ease: "power3.out",
    });
  }, [open]);

  return (
    <aside className="caye-panel" ref={ref}>
      <header className="cp-head">
        <div className="cp-title">
          <CayeMark size={28} />
          <div>
            <div className="cp-name">Caye</div>
            <div className="cp-status"><span className="cp-pulse"></span> Listening · Karenda's voice</div>
          </div>
        </div>
        <button className="cp-close" onClick={onClose}>×</button>
      </header>

      <div className="cp-context">
        <span className="cp-context-label">CONTEXT</span>
        <span className="cp-context-chip">📅 Today's calendar</span>
        <span className="cp-context-chip">💬 126 chats</span>
        <span className="cp-context-chip">+ Add</span>
      </div>

      <div className="cp-body">
        {messages.map((m, i) => (
          <div key={i} className={"cp-msg " + m.from}>
            {m.from === "caye" && <CayeMark size={20} />}
            <div className="cp-msg-body">
              <div className="cp-msg-bubble">
                <div>{m.text}</div>
                {m.bullets && (
                  <ul className="cp-bullets">
                    {m.bullets.map((b, j) => (
                      <li key={j}>
                        <ChannelIc ch={b.ch} size={14} />
                        <div>
                          <div className="cp-b-top">
                            <strong>{b.who}</strong>
                            <span className="cp-b-time">{b.time}</span>
                          </div>
                          <div className="cp-b-reason">{b.reason}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {m.footer && <div className="cp-msg-footer">{m.footer}</div>}
              </div>
              {m.from === "caye" && i === messages.length - 1 && (
                <div className="cp-quick">
                  <button>Draft replies</button>
                  <button>Open Brielle's thread</button>
                  <button>Set policy: dogs</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <footer className="cp-foot">
        <div className="cp-input">
          <CayeMark size={16} />
          <input
            placeholder="Ask Caye anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
          />
          <button onClick={onSend} className="cp-send">↵</button>
        </div>
        <div className="cp-foot-meta">
          <span>configure tone in Settings</span>
        </div>
      </footer>
    </aside>
  );
};

Object.assign(window, {
  ChatsScreen,
  ContactsScreen,
  CalendarScreen,
  CayePanel,
});
