'use client'

import TopBar from '@/components/dashboard/TopBar'
import ChatsScreen from '@/components/dashboard/chats/ChatsScreen'
import ContactsScreen from '@/components/dashboard/contacts/ContactsScreen'
import CalendarScreen from '@/components/dashboard/calendar/CalendarScreen'
import { useDashboard } from '@/lib/dashboard-context'

export default function DashboardPage() {
  const { screen, setCayeOpen } = useDashboard()

  return (
    <>
      <TopBar screen={screen} />
      <main className="tc-content">
        {screen === 'chats' && (
          <ChatsScreen openCaye={() => setCayeOpen(true)} />
        )}
        {screen === 'contacts' && <ContactsScreen />}
        {screen === 'calendar' && <CalendarScreen />}
      </main>
    </>
  )
}
