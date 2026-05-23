export default function SIcon({ name, size = 16 }: { name: string; size?: number }) {
  const s = size
  const st = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'biz':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M3.5 16.5h13M5 16.5v-9l5-3 5 3v9M8 16.5v-4h4v4M8.5 8.5h.01M11.5 8.5h.01" /></svg>
    case 'ch':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M4 7.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.5L6 17v-2.5a2 2 0 0 1-2-2v-5z" /></svg>
    case 'caye':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M10 3.5l1.7 4 4.3.5-3.2 2.9.9 4.2L10 13l-3.7 2.1.9-4.2L4 8l4.3-.5L10 3.5z" /></svg>
    case 'bell':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M6 9a4 4 0 0 1 8 0v3l1.5 2.5h-11L6 12V9zM8.5 16.5a1.5 1.5 0 0 0 3 0" /></svg>
    case 'ppl':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><circle cx="8" cy="7.5" r="2.5" /><path d="M3.5 16c.5-2.5 2.4-4 4.5-4s4 1.5 4.5 4" /><path d="M13 4.5a2.5 2.5 0 0 1 0 5M14 12c2 .2 3 1.6 3.5 4" /></svg>
    case 'card':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><rect x="3" y="5.5" width="14" height="10" rx="2" /><path d="M3 8.5h14M6 12.5h3" /></svg>
    case 'chev':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="m7 5 5 5-5 5" /></svg>
    case 'upload':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M10 13.5V4.5m0 0L6.5 8M10 4.5 13.5 8M4 14v1.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V14" /></svg>
    case 'plus':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M10 4.5v11M4.5 10h11" /></svg>
    case 'tick':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="m5 10.5 3 3 7-7" /></svg>
    case 'lock':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><rect x="5" y="9.5" width="10" height="7" rx="1.5" /><path d="M7 9.5V7a3 3 0 0 1 6 0v2.5" /></svg>
    case 'more':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><circle cx="5" cy="10" r="1" fill="currentColor" /><circle cx="10" cy="10" r="1" fill="currentColor" /><circle cx="15" cy="10" r="1" fill="currentColor" /></svg>
    case 'external':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M11.5 4.5h4v4M15.5 4.5 9 11M14 11.5v3a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>
    case 'warn':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M10 3.5 17 16H3l7-12.5zM10 8.5v3.5M10 13.5h.01" /></svg>
    case 'svc':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><rect x="3.5" y="5.5" width="13" height="10" rx="1.5" /><path d="M7 5.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5M10 9v4M8 11h4" /></svg>
    default:
      return null
  }
}
