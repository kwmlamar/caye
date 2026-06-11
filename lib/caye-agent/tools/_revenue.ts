/**
 * Compute revenue for a single booking. Price + price_type live on
 * booking_services (not bookings — bookings have no price column).
 *
 * - 'per_person' → price × number_of_people
 * - 'fixed'      → price (party size doesn't matter)
 * - missing service / price → 0
 */
export function bookingRevenue(args: {
  servicePrice: number | null | undefined
  priceType: string | null | undefined
  guests: number | null | undefined
}): number {
  const price = args.servicePrice ?? 0
  if (!price) return 0
  if (args.priceType === 'per_person') {
    return price * (args.guests ?? 1)
  }
  return price
}

/**
 * Shared select fragment for joining service price info onto bookings.
 * Used by get_revenue, get_today_summary, get_recent_bookings,
 * get_customer_history.
 */
export const BOOKING_WITH_SERVICE_PRICE_SELECT =
  'service:booking_services(name, price, price_type)'

export interface ServiceJoin {
  name: string
  price: number | null
  price_type: string | null
}
