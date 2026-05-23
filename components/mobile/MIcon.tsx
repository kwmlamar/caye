/**
 * Mobile icon set — stroke icons drawn with currentColor.
 * Converted from the Caye Mobile design (mobile-data.jsx).
 */

export type MIconName =
  | 'home' | 'cal' | 'alert' | 'feed' | 'gear' | 'more'
  | 'chev' | 'chevL' | 'chevR' | 'chevD' | 'plus' | 'tick'
  | 'sun' | 'flag' | 'msg' | 'people' | 'spark' | 'lock'
  | 'torch' | 'camera' | 'search' | 'bell-fill' | 'weather' | 'trash'

const STROKE: React.CSSProperties = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export default function MIcon({ name, size = 20 }: { name: MIconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24' }

  switch (name) {
    case 'home':
      return <svg {...common} style={STROKE}><path d="M4 11 12 4l8 7M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" /></svg>
    case 'cal':
      return <svg {...common} style={STROKE}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3v3M16 3v3" /></svg>
    case 'alert':
      return <svg {...common} style={STROKE}><path d="M6 9a6 6 0 0 1 12 0v4l1.8 3H4.2L6 13V9zM10 19a2 2 0 0 0 4 0" /></svg>
    case 'feed':
      return <svg {...common} style={STROKE}><path d="M4 6h16M4 12h16M4 18h10" /></svg>
    case 'gear':
      return <svg {...common} style={STROKE}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5" /></svg>
    case 'more':
      return <svg {...common} style={STROKE}><circle cx="6" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="18" cy="12" r="1.5" fill="currentColor" /></svg>
    case 'chev':
    case 'chevR':
      return <svg {...common} style={STROKE}><path d="m9 6 6 6-6 6" /></svg>
    case 'chevL':
      return <svg {...common} style={STROKE}><path d="m15 6-6 6 6 6" /></svg>
    case 'chevD':
      return <svg {...common} style={STROKE}><path d="m6 9 6 6 6-6" /></svg>
    case 'plus':
      return <svg {...common} style={STROKE}><path d="M12 5v14M5 12h14" /></svg>
    case 'tick':
      return <svg {...common} style={STROKE}><path d="m5 12.5 5 5L20 7" /></svg>
    case 'sun':
      return <svg {...common} style={STROKE}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>
    case 'flag':
      return <svg {...common} style={STROKE}><path d="M5 21V4h12l-2 4 2 4H5" /></svg>
    case 'msg':
      return <svg {...common} style={STROKE}><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 4v-4H6a2 2 0 0 1-2-2V7z" /></svg>
    case 'people':
      return <svg {...common} style={STROKE}><circle cx="9" cy="9" r="3" /><path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5" /><path d="M15 5.5a3 3 0 0 1 0 6M17 14c2.5.4 4 2.4 4.5 5" /></svg>
    case 'spark':
      return <svg {...common} style={STROKE}><path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5L12 3zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9.9-2.1zM5 14l.8 1.8L7.5 16.5l-1.7.7L5 19l-.8-1.8L2.5 16.5l1.7-.7.8-1.8z" /></svg>
    case 'lock':
      return <svg {...common} style={STROKE}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
    case 'torch':
      return <svg {...common} style={STROKE}><path d="M9 4l6 4-1.5 11h-3L9 8V4zM9 4h6" /></svg>
    case 'camera':
      return <svg {...common} style={STROKE}><circle cx="12" cy="13" r="3.5" /><path d="M4 8a1 1 0 0 1 1-1h2l2-2h6l2 2h2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8z" /></svg>
    case 'search':
      return <svg {...common} style={STROKE}><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
    case 'bell-fill':
      return <svg {...common} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a6 6 0 0 0-6 6v3l-2 4h16l-2-4V8a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0" /></svg>
    case 'weather':
      return <svg {...common} style={STROKE}><circle cx="12" cy="11" r="3.5" /><path d="M12 4v1.5M12 16.5V18M4 11h1.5M18.5 11H20M6.5 5.5l1 1M16.5 16.5l1 1M6.5 16.5l1-1M16.5 5.5l1 1" /></svg>
    case 'trash':
      return <svg {...common} style={STROKE}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7M10 11v5M14 11v5" /></svg>
    default:
      return null
  }
}
