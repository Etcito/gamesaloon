// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
import { MAX_ZONE_PEERS } from './protocol.ts'

/** Writes the destinations to out[0..count), leaving the rest reusable. */
export function routeMask(maskLo: number, maskHi: number, sender: number, seats: number, out: number[]): number {
  const broadcast = maskLo === 0 && maskHi === 0
  let count = 0
  for (let seat = 0; seat < seats && seat < MAX_ZONE_PEERS; seat++) {
    if (seat === sender) continue
    const mask = seat < 32 ? maskLo : maskHi
    if (broadcast || ((mask >>> (seat & 31)) & 1) !== 0) out[count++] = seat
  }
  return count
}

export class ZoneGroup {
  readonly game: string
  readonly seats: number
  private members: (string | null)[]
  private destinations: number[]

  constructor(game: string, seats: number, cap: number) {
    if (!Number.isInteger(cap) || cap < 2 || cap > MAX_ZONE_PEERS
      || !Number.isInteger(seats) || seats < 2 || seats > cap) {
      throw new RangeError('invalid zone seat count or game cap')
    }
    this.game = game
    this.seats = seats
    this.members = new Array<string | null>(seats).fill(null)
    this.destinations = new Array<number>(seats).fill(0)
  }

  set(seat: number, conn: string | null): void {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats) throw new RangeError('invalid zone seat')
    this.members[seat] = conn
  }

  /** Writes live connections to out[0..count), leaving the rest reusable. */
  route(sender: number, maskLo: number, maskHi: number, out: string[]): number {
    const destinations = routeMask(maskLo, maskHi, sender, this.seats, this.destinations)
    let count = 0
    for (let i = 0; i < destinations; i++) {
      const conn = this.members[this.destinations[i]]
      if (conn !== null) out[count++] = conn
    }
    return count
  }
}
