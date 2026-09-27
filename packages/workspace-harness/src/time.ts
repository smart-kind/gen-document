/** Current time as an ISO-8601 string; the single timestamp source for stored records. */
export function nowIso(): string {
  return new Date().toISOString()
}
