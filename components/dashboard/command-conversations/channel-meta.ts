// Shared channel display metadata for the Inbox — one place so the row
// list, thread header, and composer placeholder can't drift on what a
// channel is called.
export const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Mail',
  instagram: 'Instagram',
  messenger: 'Messenger',
  sms: 'SMS',
}

export function channelLabel(channelType: string): string {
  return CHANNEL_LABEL[channelType] ?? channelType
}
