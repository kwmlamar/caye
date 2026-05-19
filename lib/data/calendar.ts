import type { Booking, WeekDay } from '@/lib/types'

export const WEEK_DAYS: WeekDay[] = [
  { dow: 'Mon', date: 'Apr 28' },
  { dow: 'Tue', date: 'Apr 29' },
  { dow: 'Wed', date: 'Apr 30' },
  { dow: 'Thu', date: 'May 1' },
  { dow: 'Fri', date: 'May 2' },
  { dow: 'Sat', date: 'May 3' },
  { dow: 'Sun', date: 'May 4' },
]

export const BOOKINGS: Booking[] = [
  // Mon
  { day: 0, start: '11:00', end: '14:30', name: 'Whitfield party', tour: 'Snorkel + Lunch', guests: 4, status: 'confirmed', caye: true, ship: 'Carnival Pride' },
  { day: 0, start: '17:00', end: '19:00', name: 'Knowles', tour: 'Sunset Cruise', guests: 2, status: 'pending' },
  // Tue
  { day: 1, start: '10:00', end: '11:30', name: 'Pyfrom group', tour: 'Glass-Bottom Boat', guests: 8, status: 'confirmed', ship: 'MSC Seashore' },
  { day: 1, start: '13:00', end: '16:00', name: 'Walker party', tour: 'Snorkel + Lunch', guests: 3, status: 'confirmed', caye: true },
  // Wed
  { day: 2, start: '11:00', end: '14:30', name: 'Bethel family', tour: 'Snorkel + Lunch', guests: 6, status: 'pending' },
  { day: 2, start: '17:00', end: '19:00', name: 'Munroe', tour: 'Sunset Cruise', guests: 2, status: 'confirmed', caye: true },
  // Thu
  { day: 3, start: '09:00', end: '13:00', name: 'Cartwright (private)', tour: 'Private Charter', guests: 4, status: 'pending' },
  { day: 3, start: '17:00', end: '19:00', name: 'Rolle', tour: 'Sunset Cruise', guests: 2, status: 'confirmed' },
  // Fri
  { day: 4, start: '14:00', end: '15:30', name: 'Walk-up TBD', tour: 'Glass-Bottom Boat', guests: 5, status: 'pending' },
  // Sat
  { day: 5, start: '11:00', end: '14:30', name: 'Sweeting party', tour: 'Snorkel + Lunch', guests: 4, status: 'confirmed', caye: true },
  { day: 5, start: '13:00', end: '16:30', name: 'Ferreira', tour: 'Snorkel + Lunch', guests: 2, status: 'confirmed' },
  { day: 5, start: '17:00', end: '19:00', name: 'Hepburn', tour: 'Sunset Cruise', guests: 6, status: 'confirmed' },
  // Sun
  { day: 6, start: '10:00', end: '11:30', name: 'Pinder + dog?', tour: 'Glass-Bottom Boat', guests: 3, status: 'pending' },
  { day: 6, start: '17:00', end: '19:00', name: 'Saunders (anniv.)', tour: 'Sunset Cruise', guests: 6, status: 'confirmed', caye: true },
]
