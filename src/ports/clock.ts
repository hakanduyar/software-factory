import type { Timestamp } from "../domain/time.js";

export interface Clock {
  now(): Timestamp;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Deterministic clock for tests and reproducible demo transcripts. */
export function createFixedClock(startIso: string, stepMs = 1000): Clock {
  let current = new Date(startIso).getTime();
  return {
    now(): Timestamp {
      const value = current;
      current += stepMs;
      return value;
    },
  };
}
