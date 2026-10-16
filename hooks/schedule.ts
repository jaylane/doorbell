import type { Config, State } from '../types'

// A gap between beats over 40s means the machine slept, so the interval no longer applies.
export const shouldPoll = (s: State, lastBeatAt: number, now: number, cfg: Config): boolean =>
  now >= s.backoffUntil &&
  (now - s.lastAttemptAt >= Math.max(cfg.pollSeconds, 30) * 1000 || (lastBeatAt > 0 && now - lastBeatAt > 40_000))
