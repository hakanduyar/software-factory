/**
 * Recursive freeze used at every repository write boundary so no caller can
 * hold a reference and later mutate stored domain state.
 *
 * Two hard rules, both learned from real review exploits:
 *
 * 1. A frozen ROOT proves nothing about its children. Traversal continues
 *    through already-frozen objects (with a visited set for cycle safety),
 *    because a caller can hand the store an Object.freeze()d record whose
 *    nested arrays are still mutable and then mutate durable state through a
 *    retained nested reference.
 *
 * 2. A Date can never be persisted. Freezing cannot protect it — its
 *    mutators write internal slots, not properties — so storing one would
 *    leave an append-only audit record rewritable. Use Timestamp (epoch ms)
 *    instead; see src/domain/time.ts.
 */

export class MutableStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutableStateError";
  }
}

export function deepFreeze<T>(value: T, path = "$", visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    throw new MutableStateError(
      `refusing to persist a mutable Date at ${path}: freezing cannot protect it. Use Timestamp (epoch ms) instead.`,
    );
  }
  if (visited.has(value)) {
    return value;
  }
  visited.add(value);
  // Freeze first, then recurse: do NOT skip children of already-frozen
  // objects — a pre-frozen root with mutable children was a real exploit.
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], `${path}.${key}`, visited);
  }
  return value;
}
