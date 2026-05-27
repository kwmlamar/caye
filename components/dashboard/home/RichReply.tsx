'use client'

import React from 'react'
import { BookingCard, type BookingCardData } from './BookingCard'
import { InboxPreviewCard, type InboxRowData } from './InboxPreviewCard'
import { CalendarWeekStrip, type CalendarWeekData } from './CalendarWeekStrip'
import { ContactCard, type ContactCardData } from './ContactCard'

export type CardPayload =
  | { type: 'booking'; data: BookingCardData }
  | { type: 'inbox'; data: InboxRowData[] }
  | { type: 'calendar'; data: CalendarWeekData }
  | { type: 'contact'; data: ContactCardData }

export interface RichReplyProps {
  cards?: CardPayload[]
}

export function RichReply({ cards }: RichReplyProps) {
  if (!cards || cards.length === 0) return null

  return (
    <div className="flex flex-col gap-3.5 mt-3 w-full max-w-full items-start">
      {cards.map((card, idx) => {
        switch (card.type) {
          case 'booking':
            return <BookingCard key={idx} data={card.data} />
          case 'inbox':
            return <InboxPreviewCard key={idx} data={card.data} />
          case 'calendar':
            return <CalendarWeekStrip key={idx} data={card.data} />
          case 'contact':
            return <ContactCard key={idx} data={card.data} />
          default:
            return null
        }
      })}
    </div>
  )
}
