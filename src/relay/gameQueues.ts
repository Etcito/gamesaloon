// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito

export function queueKey(game: string, players: number, cadence: boolean): string {
  return `${game}|${players}|${cadence ? 1 : 0}`
}

export class GameQueues<W extends { conn: string }> {
  private lists = new Map<string, W[]>()

  has(conn: string): boolean {
    for (const list of this.lists.values()) {
      if (list.some((waiter) => waiter.conn === conn)) return true
    }
    return false
  }

  list(key: string): W[] {
    let list = this.lists.get(key)
    if (!list) {
      list = []
      this.lists.set(key, list)
    }
    return list
  }

  prune(key: string, alive: (conn: string) => boolean): void {
    const list = this.lists.get(key)
    if (!list) return
    for (let i = list.length - 1; i >= 0; i--) {
      if (!alive(list[i].conn)) list.splice(i, 1)
    }
    if (!list.length) this.lists.delete(key)
  }

  take(key: string, n: number): W[] {
    const list = this.lists.get(key)
    if (!list) return []
    const taken = list.splice(0, n)
    if (!list.length) this.lists.delete(key)
    return taken
  }

  pop(key: string): W | undefined {
    const list = this.lists.get(key)
    if (!list) return undefined
    const waiter = list.pop()
    if (!list.length) this.lists.delete(key)
    return waiter
  }

  drop(conn: string): void {
    for (const [key, list] of this.lists) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].conn === conn) list.splice(i, 1)
      }
      if (!list.length) this.lists.delete(key)
    }
  }
}
