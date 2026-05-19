// =========================================================
// Mock data + reusable icons for the TropiChat dashboard
// =========================================================

// --- Channel mark (W / IG / M / @) ---
const ChannelIc = ({ ch, size = 18 }) => {
  const map = {
    wa: { bg: "#22c55e", label: "W" },
    ig: { bg: "linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)", label: "IG" },
    fb: { bg: "#3b82f6", label: "M" },
    em: { bg: "var(--ink)", label: "@" },
  };
  const c = map[ch];
  return (
    <span
      className="ch-ic"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, size * 0.28),
        background: c.bg,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(8, size * 0.5),
        fontWeight: 700,
        fontFamily: "'Geist', sans-serif",
        flexShrink: 0,
      }}
    >
      {c.label}
    </span>
  );
};

// --- Avatar bubble (initials + warm gradient) ---
const palettes = [
  "linear-gradient(140deg,#e85a3c,#c94824)",
  "linear-gradient(140deg,#1e6157,#2d8a7c)",
  "linear-gradient(140deg,#f4b942,#e88c3c)",
  "linear-gradient(140deg,#3b82f6,#6366f1)",
  "linear-gradient(140deg,#ec4899,#f59e0b)",
  "linear-gradient(140deg,#0b1419,#2d3a44)",
  "linear-gradient(140deg,#2d8a7c,#1e6157)",
  "linear-gradient(140deg,#c94824,#e85a3c)",
];
const hashIdx = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % palettes.length;
};
const Avatar = ({ name, size = 36 }) => {
  const initials = name
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className="av"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: palettes[hashIdx(name)],
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: Math.max(10, size * 0.4),
        flexShrink: 0,
        letterSpacing: "-0.01em",
      }}
    >
      {initials}
    </span>
  );
};

// --- Caye swirl mark ---
const CayeMark = ({ size = 22 }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      background:
        "conic-gradient(from 0deg, #1e6157, #f4b942, #e85a3c, #1e6157)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      position: "relative",
      boxShadow: "0 0 0 2px rgba(30,97,87,0.18)",
    }}
  >
    <span
      style={{
        width: size * 0.5,
        height: size * 0.5,
        borderRadius: "50%",
        background: "var(--bg-soft)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.32,
        fontWeight: 700,
        color: "var(--teal)",
        fontFamily: "'Geist', sans-serif",
        letterSpacing: "-0.02em",
      }}
    >
      C
    </span>
  </span>
);

// --- Conversations (Chats screen) ---
const CONVERSATIONS = [
  {
    id: "c1",
    name: "Anna Whitfield",
    role: "Carnival Pride · Cruise guest",
    channel: "wa",
    time: "2:14 PM",
    preview: "are 4 of us able to do the snorkel + lunch at 11?",
    unread: 1,
    cayeStatus: "replied", // replied | held | drafted | none
    cayeNote: "Caye replied · 2:14 PM",
    pinned: true,
    thread: [
      { side: "in", text: "Hi! Coming in on Carnival Pride Saturday — are 4 of us able to do the snorkel + lunch tour at 11?", time: "2:11 PM" },
      { side: "caye-action", text: "Caye · checked Saturday calendar · 3 spots open at 11:00" },
      {
        side: "out",
        cayeDrafted: true,
        sentAs: "Karenda",
        text: "Hi Anna — yes, Saturday 11am works perfectly. Pickup at the cruise port pier, look for the blue boat. $89 pp, lunch included. I'll send a confirmation through in a sec. — Karenda",
        time: "2:14 PM",
      },
      { side: "in", text: "Amazing, thank you! How long is the tour?", time: "2:16 PM" },
    ],
  },
  {
    id: "c2",
    name: "Marcus Ferreira",
    role: "Instagram · DM",
    channel: "ig",
    time: "1:42 PM",
    preview: "Saw your sunset cruise on IG — any spots Thursday?",
    unread: 0,
    cayeStatus: "drafted",
    cayeNote: "Caye drafted a reply · waiting on you",
  },
  {
    id: "c3",
    name: "Jessamyn Pyfrom",
    role: "MSC Seashore · Group of 8",
    channel: "em",
    time: "12:08 PM",
    preview: "Glass-bottom boat tour pricing for 8 adults?",
    unread: 2,
    cayeStatus: "replied",
    cayeNote: "Caye replied · 12:09 PM · awaiting customer",
  },
  {
    id: "c4",
    name: "Devaughn Knowles",
    role: "WhatsApp · Returning",
    channel: "wa",
    time: "11:31 AM",
    preview: "Just confirming pickup time for tomorrow 👍🏽",
    unread: 0,
    cayeStatus: "replied",
    cayeNote: "Caye replied · 11:32 AM",
  },
  {
    id: "c5",
    name: "Brielle Bethel",
    role: "Messenger · Local",
    channel: "fb",
    time: "10:14 AM",
    preview: "I think I left an earring on yesterday's boat 😅",
    unread: 1,
    cayeStatus: "held",
    cayeNote: "Caye held this — needs your call",
  },
  {
    id: "c6",
    name: "Tianna Rolle",
    role: "Instagram · DM",
    channel: "ig",
    time: "Yesterday",
    preview: "Is the 2pm slot open this Friday for 2?",
    unread: 0,
    cayeStatus: "replied",
    cayeNote: "Caye replied · Yesterday 9:14 PM",
  },
  {
    id: "c7",
    name: "Marvin Cartwright",
    role: "Email · Honeymoon",
    channel: "em",
    time: "Yesterday",
    preview: "Private charter quote — anniversary trip in June",
    unread: 0,
    cayeStatus: "drafted",
    cayeNote: "Caye drafted · price needs review",
  },
  {
    id: "c8",
    name: "Sandra Sweeting",
    role: "WhatsApp · Returning",
    channel: "wa",
    time: "Mon",
    preview: "Confirming for Saturday — we'll bring towels?",
    unread: 0,
    cayeStatus: "replied",
    cayeNote: "Caye replied · Mon 4:02 PM",
  },
  {
    id: "c9",
    name: "Roland Saunders",
    role: "Email · Repeat customer",
    channel: "em",
    time: "Mon",
    preview: "Group of 6 — sunset Sunday, anniversary",
    unread: 0,
    cayeStatus: "replied",
    cayeNote: "Caye replied · Mon",
  },
  {
    id: "c10",
    name: "Adina Pinder",
    role: "WhatsApp · Local",
    channel: "wa",
    time: "Sun",
    preview: "Are dogs allowed on the glass-bottom?",
    unread: 0,
    cayeStatus: "held",
    cayeNote: "Caye held — unusual question",
  },
];

// --- Contacts ---
const CONTACTS = [
  { id: "p1", name: "Anna Whitfield", channel: "wa", phone: "+1 (305) 555-0142", email: "anna.w@gmail.com", bookings: 1, lastSeen: "Today · 2:14 PM", origin: "Carnival Pride · Apr 26", tags: ["Cruise", "First-time"] },
  { id: "p2", name: "Devaughn Knowles", channel: "wa", phone: "+1 (242) 555-0188", email: "—", bookings: 4, lastSeen: "Today · 11:32 AM", origin: "Local · returning", tags: ["VIP", "Local"] },
  { id: "p3", name: "Brielle Bethel", channel: "fb", phone: "—", email: "brielle.b@outlook.com", bookings: 2, lastSeen: "Today · 10:14 AM", origin: "Nassau referral", tags: ["Local"] },
  { id: "p4", name: "Jessamyn Pyfrom", channel: "em", phone: "—", email: "j.pyfrom@msc-guest.com", bookings: 1, lastSeen: "Today · 12:08 PM", origin: "MSC Seashore · May 1", tags: ["Cruise", "Group 8"] },
  { id: "p5", name: "Marcus Ferreira", channel: "ig", phone: "—", email: "—", bookings: 0, lastSeen: "Today · 1:42 PM", origin: "Instagram ad · May", tags: ["New lead"] },
  { id: "p6", name: "Sandra Sweeting", channel: "wa", phone: "+1 (242) 555-0193", email: "ssweeting@yahoo.com", bookings: 6, lastSeen: "Mon · 4:02 PM", origin: "Word of mouth", tags: ["VIP", "Returning"] },
  { id: "p7", name: "Tianna Rolle", channel: "ig", phone: "—", email: "—", bookings: 1, lastSeen: "Yesterday", origin: "Instagram DM", tags: ["First-time"] },
  { id: "p8", name: "Marvin Cartwright", channel: "em", phone: "—", email: "marvin.c@hey.com", bookings: 0, lastSeen: "Yesterday", origin: "Website form", tags: ["New lead", "Charter"] },
  { id: "p9", name: "Roland Saunders", channel: "em", phone: "+1 (242) 555-0117", email: "rsaunders@gmail.com", bookings: 8, lastSeen: "Mon", origin: "Returning · Anniversary", tags: ["VIP", "Returning"] },
  { id: "p10", name: "Adina Pinder", channel: "wa", phone: "+1 (242) 555-0166", email: "—", bookings: 3, lastSeen: "Sun", origin: "Local · returning", tags: ["Local"] },
  { id: "p11", name: "Keshawn Rolle", channel: "wa", phone: "+1 (242) 555-0124", email: "—", bookings: 2, lastSeen: "Apr 22", origin: "Local · referral", tags: ["Local"] },
  { id: "p12", name: "Daphne Sweeting", channel: "em", phone: "—", email: "daphs@gmail.com", bookings: 5, lastSeen: "Apr 18", origin: "Returning · Family", tags: ["Returning"] },
];

const CONTACT_BOOKINGS = {
  p1: [
    { date: "Sat May 3", tour: "Snorkel + Lunch", guests: 4, status: "confirmed", source: "Caye" },
  ],
  p2: [
    { date: "Tue Apr 29", tour: "Sunset Cruise", guests: 2, status: "confirmed", source: "Caye" },
    { date: "Mar 14", tour: "Glass-Bottom Boat", guests: 2, status: "completed", source: "—" },
    { date: "Feb 02", tour: "Snorkel + Lunch", guests: 4, status: "completed", source: "—" },
    { date: "Jan 11", tour: "Sunset Cruise", guests: 2, status: "completed", source: "—" },
  ],
  p3: [
    { date: "Wed Apr 30", tour: "Snorkel + Lunch", guests: 6, status: "pending", source: "—" },
    { date: "Mar 22", tour: "Snorkel + Lunch", guests: 4, status: "completed", source: "—" },
  ],
  p6: [
    { date: "Sat May 3", tour: "Snorkel + Lunch", guests: 4, status: "confirmed", source: "Caye" },
    { date: "Apr 12", tour: "Sunset Cruise", guests: 6, status: "completed", source: "—" },
    { date: "Mar 28", tour: "Snorkel + Lunch", guests: 4, status: "completed", source: "—" },
  ],
};

// --- Calendar bookings (week of Apr 28 – May 4) ---
const WEEK_DAYS = [
  { dow: "Mon", date: "Apr 28" },
  { dow: "Tue", date: "Apr 29" },
  { dow: "Wed", date: "Apr 30" },
  { dow: "Thu", date: "May 1" },
  { dow: "Fri", date: "May 2" },
  { dow: "Sat", date: "May 3" },
  { dow: "Sun", date: "May 4" },
];

const BOOKINGS = [
  // Mon
  { day: 0, start: "11:00", end: "14:30", name: "Whitfield party", tour: "Snorkel + Lunch", guests: 4, status: "confirmed", caye: true, ship: "Carnival Pride" },
  { day: 0, start: "17:00", end: "19:00", name: "Knowles", tour: "Sunset Cruise", guests: 2, status: "pending" },
  // Tue
  { day: 1, start: "10:00", end: "11:30", name: "Pyfrom group", tour: "Glass-Bottom Boat", guests: 8, status: "confirmed", ship: "MSC Seashore" },
  { day: 1, start: "13:00", end: "16:00", name: "Walker party", tour: "Snorkel + Lunch", guests: 3, status: "confirmed", caye: true },
  // Wed
  { day: 2, start: "11:00", end: "14:30", name: "Bethel family", tour: "Snorkel + Lunch", guests: 6, status: "pending" },
  { day: 2, start: "17:00", end: "19:00", name: "Munroe", tour: "Sunset Cruise", guests: 2, status: "confirmed", caye: true },
  // Thu
  { day: 3, start: "09:00", end: "13:00", name: "Cartwright (private)", tour: "Private Charter", guests: 4, status: "pending" },
  { day: 3, start: "17:00", end: "19:00", name: "Rolle", tour: "Sunset Cruise", guests: 2, status: "confirmed" },
  // Fri
  { day: 4, start: "14:00", end: "15:30", name: "Walk-up TBD", tour: "Glass-Bottom Boat", guests: 5, status: "pending" },
  // Sat
  { day: 5, start: "11:00", end: "14:30", name: "Sweeting party", tour: "Snorkel + Lunch", guests: 4, status: "confirmed", caye: true },
  { day: 5, start: "13:00", end: "16:30", name: "Ferreira", tour: "Snorkel + Lunch", guests: 2, status: "confirmed" },
  { day: 5, start: "17:00", end: "19:00", name: "Hepburn", tour: "Sunset Cruise", guests: 6, status: "confirmed" },
  // Sun
  { day: 6, start: "10:00", end: "11:30", name: "Pinder + dog?", tour: "Glass-Bottom Boat", guests: 3, status: "pending" },
  { day: 6, start: "17:00", end: "19:00", name: "Saunders (anniv.)", tour: "Sunset Cruise", guests: 6, status: "confirmed", caye: true },
];

// --- Caye panel: held messages summary ---
const CAYE_PANEL_HELD = [
  { who: "Brielle Bethel", channel: "fb", reason: "lost earring — needs lost & found check", time: "10:14 AM" },
  { who: "Adina Pinder", channel: "wa", reason: "asked about dogs on the glass-bottom — policy decision", time: "Sun" },
  { who: "Marvin Cartwright", channel: "em", reason: "private charter quote — June, 7-hour package", time: "Yesterday" },
];

// Export everything to window so other babel scripts can use them
Object.assign(window, {
  ChannelIc,
  Avatar,
  CayeMark,
  CONVERSATIONS,
  CONTACTS,
  CONTACT_BOOKINGS,
  WEEK_DAYS,
  BOOKINGS,
  CAYE_PANEL_HELD,
});
