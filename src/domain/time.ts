/**
 * Timestamps are stored as epoch milliseconds, never as Date objects.
 *
 * `Object.freeze` does not stop `Date` mutators: a caller that retains a
 * reference to a stored `Date` can call `setFullYear` on it and silently
 * rewrite an append-only audit record. That was a real Round-2 exploit. A
 * number is a primitive and cannot be mutated through any reference, so the
 * whole class of attack disappears rather than being guarded against.
 *
 * `deepFreeze` (src/domain/freeze.ts) actively refuses to store a Date, so
 * this invariant cannot silently regress.
 */

export type Timestamp = number;

export function formatTimestamp(value: Timestamp): string {
  return new Date(value).toISOString();
}

export function timestampFromIso(iso: string): Timestamp {
  return new Date(iso).getTime();
}
