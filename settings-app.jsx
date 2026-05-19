// =========================================================
// TropiChat — Settings page root
// =========================================================

// Outer rail sidebar (mirrors dashboard) — Settings is the active item here
const OUTER_RAIL = [
  { id: "chats",    label: "Chats",    count: 4,    icon: "chat",     href: "TropiChat Dashboard.html" },
  { id: "contacts", label: "Contacts", count: null, icon: "contacts", href: "TropiChat Dashboard.html" },
  { id: "calendar", label: "Calendar", count: 14,   icon: "cal",      href: "TropiChat Dashboard.html" },
];

const RailIcon = ({ name, size = 18 }) => {
  const s = size;
  const st = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "chat":
      return <svg width={s} height={s} viewBox="0 0 20 20" style={st}><path d="M3 5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 16.5v-3H5a2 2 0 0 1-2-2v-6z" /></svg>;
    case "contacts":
      return <svg width={s} height={s} viewBox="0 0 20 20" style={st}><circle cx="10" cy="7.5" r="3" /><path d="M3.5 16.5c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5" /></svg>;
    case "cal":
      return <svg width={s} height={s} viewBox="0 0 20 20" style={st}><rect x="3" y="4.5" width="14" height="12" rx="2" /><path d="M3 8h14M7 3v3M13 3v3" /></svg>;
    case "settings":
      return <svg width={s} height={s} viewBox="0 0 20 20" style={st}><circle cx="10" cy="10" r="2.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg>;
    case "search":
      return <svg width={s} height={s} viewBox="0 0 20 20" style={st}><circle cx="9" cy="9" r="5" /><path d="m13 13 3 3" /></svg>;
    default: return null;
  }
};

const OuterSidebar = ({ expanded, setExpanded }) => (
  <nav className={"sidebar" + (expanded ? " expanded" : "")} onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
    <div className="sb-top">
      <a href="TropiChat Dashboard.html" className="sb-brand">
        <span className="sb-mark">T</span>
        <span className="sb-brand-name">TropiChat</span>
      </a>

      <div className="sb-section">
        <span className="sb-section-label">Workspace</span>
        {OUTER_RAIL.map((s) => (
          <a key={s.id} href={s.href} className="sb-item" title={s.label}>
            <span className="sb-icon"><RailIcon name={s.icon} size={18} /></span>
            <span className="sb-label">{s.label}</span>
            {s.count != null && <span className="sb-count">{s.count}</span>}
          </a>
        ))}
      </div>

      <div className="sb-section">
        <span className="sb-section-label">Today</span>
        <div className="sb-day-card">
          <div className="sb-day-row">
            <span className="sb-day-pip confirmed"></span>
            <span className="sb-day-num">2</span>
            <span className="sb-day-k">confirmed tours</span>
          </div>
          <div className="sb-day-row">
            <span className="sb-day-pip pending"></span>
            <span className="sb-day-num">1</span>
            <span className="sb-day-k">pending</span>
          </div>
          <div className="sb-day-row">
            <span className="sb-day-pip caye"></span>
            <span className="sb-day-num">11</span>
            <span className="sb-day-k">handled by Caye</span>
          </div>
        </div>
      </div>
    </div>

    <div className="sb-bottom">
      <button className="sb-item active" title="Settings">
        <span className="sb-icon"><RailIcon name="settings" size={18} /></span>
        <span className="sb-label">Settings</span>
      </button>
      <button className="sb-item sb-user" title="Karenda">
        <Avatar name="Karenda Munroe" size={26} />
        <span className="sb-label">
          <span className="sb-user-name">Karenda M.</span>
          <span className="sb-user-org">Karenda's Tours</span>
        </span>
      </button>
    </div>
  </nav>
);

// Top bar w/ breadcrumb
const SettingsTopBar = ({ active }) => {
  const here = SET_NAV.find((s) => s.id === active);
  return (
    <header className="top-bar">
      <div className="tb-left">
        <div className="breadcrumb">
          <span>Workspace</span>
          <span className="sep">/</span>
          <span>Settings</span>
          <span className="sep">/</span>
          <span className="here">{here ? here.label : ""}</span>
        </div>
      </div>
      <div className="tb-right">
        <div className="tb-search">
          <RailIcon name="search" size={14} />
          <input placeholder="Search settings…" />
        </div>
        <button className="tb-caye on">
          <span className="caye-dot" style={{ width: 8, height: 8 }}></span>
          Caye is on
          <span className="kbd">⌘J</span>
        </button>
      </div>
    </header>
  );
};

// =========================================================
// Root app
// =========================================================
const App = () => {
  const [active, setActive] = React.useState("caye");
  const [sidebarExpanded, setSidebarExpanded] = React.useState(false);

  // Scroll content to top when switching panels
  const mainRef = React.useRef(null);
  React.useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [active]);

  return (
    <div className="tc-root">
      <div className="tc-frame" data-screen-label={`Settings — ${SET_NAV.find((s) => s.id === active)?.label || ""}`}>
        <OuterSidebar expanded={sidebarExpanded} setExpanded={setSidebarExpanded} />

        <div className="tc-main">
          <SettingsTopBar active={active} />

          <main className="tc-content">
            <div className="settings-screen">
              <SettingsNav active={active} setActive={setActive} />
              <div className="set-main" ref={mainRef}>
                {active === "profile"       && <ProfilePanel />}
                {active === "channels"      && <ChannelsPanel />}
                {active === "caye"          && <CayePanel />}
                {active === "notifications" && <NotificationsPanel />}
                {active === "team"          && <TeamPanel />}
                {active === "billing"       && <BillingPanel />}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
