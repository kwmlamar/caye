import type { ChCode } from '@/lib/data/mobile'

const LABEL: Record<ChCode, string> = { wa: 'W', ig: 'IG', fb: 'M', em: '@' }

/** Small channel badge — WhatsApp / Instagram / Messenger / Email. */
export default function ChannelPip({ ch, size }: { ch: ChCode; size?: 'sm' }) {
  return <span className={'ch-pip ch-' + ch + (size ? ' ' + size : '')}>{LABEL[ch]}</span>
}
