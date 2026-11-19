// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Token bucket rate limiter driven by an injected clock (ms).

export class TokenBucket {
  ratePerSec: number
  burst: number
  tokens: number
  lastMs: number | null = null
  overSinceMs: number | null = null

  constructor(ratePerSec: number, burst: number) {
    this.ratePerSec = ratePerSec
    this.burst = burst
    this.tokens = burst
  }

  take(nowMs: number): boolean {
    if (this.lastMs !== null && nowMs > this.lastMs) {
      this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.lastMs) / 1000) * this.ratePerSec)
    }
    if (this.lastMs === null || nowMs > this.lastMs) this.lastMs = nowMs
    if (this.tokens < 1) {
      if (this.overSinceMs === null) this.overSinceMs = nowMs
      return false
    }
    this.tokens -= 1
    this.overSinceMs = null
    return true
  }
}

/**
 * One token bucket per key (e.g. a client IP), created lazily on first use. Idle buckets are dropped by `tick`
 * (not by `take`, so a flood of distinct keys cannot make every call pay an O(n) sweep) after `idleMs` of
 * inactivity, so a flood of distinct keys cannot grow this forever.
 */
export class KeyedRateLimiter {
  private ratePerSec: number
  private burst: number
  private idleMs: number
  private buckets = new Map<string, { bucket: TokenBucket; lastMs: number }>()

  constructor(ratePerSec: number, burst: number, idleMs = 10 * 60_000) {
    this.ratePerSec = ratePerSec
    this.burst = burst
    this.idleMs = idleMs
  }

  /** True when the action for `key` is allowed at `nowMs`; false when that key is over its rate. */
  take(key: string, nowMs: number): boolean {
    let entry = this.buckets.get(key)
    if (!entry) {
      entry = { bucket: new TokenBucket(this.ratePerSec, this.burst), lastMs: nowMs }
      this.buckets.set(key, entry)
    }
    entry.lastMs = nowMs
    return entry.bucket.take(nowMs)
  }

  /** Drops buckets idle for `idleMs` or more. Call once per server tick. */
  tick(nowMs: number): void {
    for (const [key, entry] of this.buckets) {
      if (nowMs - entry.lastMs >= this.idleMs) this.buckets.delete(key)
    }
  }

  size(): number {
    return this.buckets.size
  }
}
