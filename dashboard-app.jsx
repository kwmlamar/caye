// =========================================================
// Main Caye dashboard app
// =========================================================

const SCREENS = [
  { id: "chats", label: "Chats", count: 4, icon: "chat" },
  { id: "contacts", label: "Contacts", count: null, icon: "contacts" },
  { id: "calendar", label: "Calendar", count: 14, icon: "cal" },
];

// Minimal stroke icons
const Icon = ({ name, size = 20 }) => {
  const s = size;
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "chat":
      return (
        <svg width={s} height={s} viewBox="0 0 20 20" {...stroke} style={stroke}>
          <path d="M3 5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 16.5v-3H5a2 2 0 0 1-2-2v-6z" />
        </svg>
      );
    case "contacts":
      return (
        <svg width={s} height={s} viewBox="0 0 20 20" {...stroke} style={stroke}>
          <circle cx="10" cy="7.5" r="3" />
          <path d="M3.5 16.5c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5" />
        </svg>
      );
    case "cal":
      return (
        <svg width={s} height={s} viewBox="0 0 20 20" {...stroke} style={stroke}>
          <rect x="3" y="4.5" width="14" height="12" rx="2" />
          <path d="M3 8h14M7 3v3M13 3v3" />
        </svg>
      );
    case "settings":
      return (
        <svg width={s} height={s} viewBox="0 0 20 20" {...stroke} style={stroke}>
          <circle cx="10" cy="10" r="2.4" />
          <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
        </svg>
      );
    case "search":
      return (
        <svg width={s} height={s} viewBox="0 0 20 20" {...stroke} style={stroke}>
          <circle cx="9" cy="9" r="5" />
          <path d="m13 13 3 3" />
        </svg>
      );
    default:
      return null;
  }
};

const Sidebar = ({ screen, setScreen, expanded, setExpanded }) => {
  return (
    <nav className={"sidebar" + (expanded ? " expanded" : "")} onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
      <div className="sb-top">
        <a href="#" className="sb-brand">
          <span className="sb-mark">T</span>
          <span className="sb-brand-name">Caye</span>
        </a>

        <div className="sb-section">
          <span className="sb-section-label">Workspace</span>
          {SCREENS.map((s) => (
            <button
              key={s.id}
              className={"sb-item" + (screen === s.id ? " active" : "")}
              onClick={() => setScreen(s.id)}
              title={s.label}
            >
              <span className="sb-icon"><Icon name={s.icon} size={18} /></span>
              <span className="sb-label">{s.label}</span>
              {s.count != null && <span className="sb-count">{s.count}</span>}
            </button>
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
        <button className="sb-item" title="Settings">
          <span className="sb-icon"><Icon name="settings" size={18} /></span>
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
};

const TopBar = ({ screen, openCaye, cayeOpen }) => {
  const titleMap = {
    chats: "Chats",
    contacts: "Contacts",
    calendar: "Calendar",
    "caye-demo": "Chats",
  };
  return (
    <header className="top-bar">
      <div className="tb-left">
        <h1 className="tb-title">{titleMap[screen]}</h1>
      </div>
      <div className="tb-right">
        <div className="tb-search">
          <Icon name="search" size={14} />
          <input placeholder="Search everything…" />
        </div>
      </div>
    </header>
  );
};

// Screen switcher (top-of-file demo strip — switches between the 4 design states)
const DemoStrip = ({ screen, setScreen }) => {
  const states = [
    { id: "chats", label: "1 · Chats" },
    { id: "contacts", label: "2 · Contacts" },
    { id: "calendar", label: "3 · Calendar" },
    { id: "caye-demo", label: "4 · Caye panel" },
  ];
  return (
    <div className="demo-strip">
      <div className="demo-brand">
        <span className="dm-mark">T</span>
        <span>Caye · Dashboard exploration</span>
      </div>
      <div className="demo-tabs">
        {states.map((s) => (
          <button
            key={s.id}
            className={"dm-tab" + (screen === s.id ? " on" : "")}
            onClick={() => setScreen(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="demo-meta">
        <span>1280 × 800 · desktop-first</span>
      </div>
    </div>
  );
};

const App = () => {
  const [screen, setScreen] = React.useState("chats");
  const [sidebarExpanded, setSidebarExpanded] = React.useState(false);
  const [cayeOpen, setCayeOpen] = React.useState(false);
  const [activeChatId, setActiveChatId] = React.useState("c1");

  // Demo screen #4 = Chats with Caye panel pre-opened
  React.useEffect(() => {
    if (screen === "caye-demo") {
      setCayeOpen(true);
    }
  }, [screen]);

  // Reset sidebar nav highlight when on caye-demo
  const navScreen = screen === "caye-demo" ? "chats" : screen;
  const mainScreen = screen === "caye-demo" ? "chats" : screen;

  // ⌘J keyboard
  React.useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setCayeOpen((x) => !x);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  return (
    <div className="tc-root">
      <DemoStrip screen={screen} setScreen={setScreen} />

      <div className="tc-frame" data-screen-label={
        screen === "chats" ? "01 Chats" :
        screen === "contacts" ? "02 Contacts" :
        screen === "calendar" ? "03 Calendar" :
        "04 Caye panel"
      }>
        <Sidebar
          screen={navScreen}
          setScreen={setScreen}
          expanded={sidebarExpanded}
          setExpanded={setSidebarExpanded}
        />

        <div className={"tc-main" + (cayeOpen ? " caye-open" : "")}>
          <TopBar screen={screen} openCaye={() => setCayeOpen(true)} cayeOpen={cayeOpen} />

          <main className="tc-content">
            {mainScreen === "chats" && (
              <ChatsScreen
                activeId={activeChatId}
                setActiveId={setActiveChatId}
                openCaye={() => setCayeOpen(true)}
              />
            )}
            {mainScreen === "contacts" && <ContactsScreen />}
            {mainScreen === "calendar" && <CalendarScreen />}
          </main>
        </div>

        <CayePanel open={cayeOpen} onClose={() => setCayeOpen(false)} />

        {!cayeOpen && (
          <button className="caye-fab" onClick={() => setCayeOpen(true)} title="Ask Caye">
            <CayeMark size={30} />
          </button>
        )}
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
