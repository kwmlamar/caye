import type { Contact, ContactBooking } from '@/lib/types'

export const CONTACTS: Contact[] = [
  { id: 'p1', name: 'Anna Whitfield', channel: 'wa', phone: '+1 (305) 555-0142', email: 'anna.w@gmail.com', bookings: 1, lastSeen: 'Today · 2:14 PM', origin: 'Carnival Pride · Apr 26', tags: ['Cruise', 'First-time'] },
  { id: 'p2', name: 'Devaughn Knowles', channel: 'wa', phone: '+1 (242) 555-0188', email: '—', bookings: 4, lastSeen: 'Today · 11:32 AM', origin: 'Local · returning', tags: ['VIP', 'Local'] },
  { id: 'p3', name: 'Brielle Bethel', channel: 'fb', phone: '—', email: 'brielle.b@outlook.com', bookings: 2, lastSeen: 'Today · 10:14 AM', origin: 'Nassau referral', tags: ['Local'] },
  { id: 'p4', name: 'Jessamyn Pyfrom', channel: 'em', phone: '—', email: 'j.pyfrom@msc-guest.com', bookings: 1, lastSeen: 'Today · 12:08 PM', origin: 'MSC Seashore · May 1', tags: ['Cruise', 'Group 8'] },
  { id: 'p5', name: 'Marcus Ferreira', channel: 'ig', phone: '—', email: '—', bookings: 0, lastSeen: 'Today · 1:42 PM', origin: 'Instagram ad · May', tags: ['New lead'] },
  { id: 'p6', name: 'Sandra Sweeting', channel: 'wa', phone: '+1 (242) 555-0193', email: 'ssweeting@yahoo.com', bookings: 6, lastSeen: 'Mon · 4:02 PM', origin: 'Word of mouth', tags: ['VIP', 'Returning'] },
  { id: 'p7', name: 'Tianna Rolle', channel: 'ig', phone: '—', email: '—', bookings: 1, lastSeen: 'Yesterday', origin: 'Instagram DM', tags: ['First-time'] },
  { id: 'p8', name: 'Marvin Cartwright', channel: 'em', phone: '—', email: 'marvin.c@hey.com', bookings: 0, lastSeen: 'Yesterday', origin: 'Website form', tags: ['New lead', 'Charter'] },
  { id: 'p9', name: 'Roland Saunders', channel: 'em', phone: '+1 (242) 555-0117', email: 'rsaunders@gmail.com', bookings: 8, lastSeen: 'Mon', origin: 'Returning · Anniversary', tags: ['VIP', 'Returning'] },
  { id: 'p10', name: 'Adina Pinder', channel: 'wa', phone: '+1 (242) 555-0166', email: '—', bookings: 3, lastSeen: 'Sun', origin: 'Local · returning', tags: ['Local'] },
  { id: 'p11', name: 'Keshawn Rolle', channel: 'wa', phone: '+1 (242) 555-0124', email: '—', bookings: 2, lastSeen: 'Apr 22', origin: 'Local · referral', tags: ['Local'] },
  { id: 'p12', name: 'Daphne Sweeting', channel: 'em', phone: '—', email: 'daphs@gmail.com', bookings: 5, lastSeen: 'Apr 18', origin: 'Returning · Family', tags: ['Returning'] },
]

export const CONTACT_BOOKINGS: Record<string, ContactBooking[]> = {
  p1: [
    { date: 'Sat May 3', tour: 'Snorkel + Lunch', guests: 4, status: 'confirmed', source: 'Caye' },
  ],
  p2: [
    { date: 'Tue Apr 29', tour: 'Sunset Cruise', guests: 2, status: 'confirmed', source: 'Caye' },
    { date: 'Mar 14', tour: 'Glass-Bottom Boat', guests: 2, status: 'completed', source: '—' },
    { date: 'Feb 02', tour: 'Snorkel + Lunch', guests: 4, status: 'completed', source: '—' },
    { date: 'Jan 11', tour: 'Sunset Cruise', guests: 2, status: 'completed', source: '—' },
  ],
  p3: [
    { date: 'Wed Apr 30', tour: 'Snorkel + Lunch', guests: 6, status: 'pending', source: '—' },
    { date: 'Mar 22', tour: 'Snorkel + Lunch', guests: 4, status: 'completed', source: '—' },
  ],
  p6: [
    { date: 'Sat May 3', tour: 'Snorkel + Lunch', guests: 4, status: 'confirmed', source: 'Caye' },
    { date: 'Apr 12', tour: 'Sunset Cruise', guests: 6, status: 'completed', source: '—' },
    { date: 'Mar 28', tour: 'Snorkel + Lunch', guests: 4, status: 'completed', source: '—' },
  ],
}
