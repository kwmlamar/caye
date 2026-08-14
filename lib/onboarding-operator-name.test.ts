import { describe, expect, it } from 'vitest'
import { parseOnboardingNameAndEmail, shouldSyncOnboardingOperatorName } from './onboarding-operator-name'

describe('onboarding operator name', () => {
  it('extracts the owner name and email from the fixed second onboarding answer', () => {
    expect(parseOnboardingNameAndEmail('Racquel carey bowe\nInfo@bowcarbahamas.com')).toEqual({
      fullName: 'Racquel carey bowe',
      email: 'Info@bowcarbahamas.com',
    })
  })

  it.each([
    [null, 'Bowcar Rentals'],
    ['Operator', 'Bowcar Rentals'],
    ['Bowcar Rentals', 'Bowcar Rentals'],
  ])('repairs a %s placeholder with the onboarding name', (currentName, businessName) => {
    expect(shouldSyncOnboardingOperatorName(currentName, 'Racquel Carey Bowe', businessName)).toBe(true)
  })

  it('preserves an explicitly set personal name', () => {
    expect(shouldSyncOnboardingOperatorName('Raquel', 'Racquel Carey Bowe', 'Bowcar Rentals')).toBe(false)
  })
})
