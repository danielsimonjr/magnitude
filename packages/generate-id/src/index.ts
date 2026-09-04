import { init } from '@paralleldrive/cuid2'

/**
 * cuid2 defaults to `Math.random`, which is predictable. Feed it the platform
 * CSPRNG so IDs cannot be guessed even where they end up guarding something.
 * These IDs are still not a substitute for a secret: use `node:crypto`
 * (`randomBytes`, `randomUUID`) for tokens, nonces, and capability handles.
 */
const secureRandom = (): number => {
  const [value] = crypto.getRandomValues(new Uint32Array(1))
  return (value ?? 0) / 2 ** 32
}

export const createId = init({ length: 12, random: secureRandom })
export const createShortId = init({ length: 8, random: secureRandom })

/**
 * Generates a lexicographically sortable ID based on the current timestamp.
 * Uses base36-encoded epoch milliseconds, producing ~8 character alphanumeric strings.
 * Alphabetical sort order equals chronological order. Not unique within a
 * millisecond and never suitable as a secret.
 */
export function generateSortableId(): string {
  return Date.now().toString(36)
}
