// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// Round rewards reported by the match host. What a round kind grants is catalog data (`round_rewards`).
//   * The first reporter of a match id claims it (etc_round_hosts, unique match_id); a report on that match from
//     anyone else is refused `forbidden`.
//   * The rewarded player is the one of the Wavedash user id, so the reward follows the Wavedash account.
//   * One ledger fact per match|round|player|kind: reporting it again answers the stored result (`applied: false`).

import { StoreError } from '../store/errors.ts'
import type { Filter, TableApi } from '../store/tables.ts'
import type { PlayerStore } from '../store/types.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Catalog, RoundReward } from './types.ts'

const ID_RE = /^[A-Za-z0-9:_.-]{1,64}$/
const MAX_ROUND = 1000

export interface RoundReport {
  match_id: string
  round: number
  /** The Wavedash user id of the rewarded player. */
  player: string
  kind: string
  granted: RoundReward
  applied: boolean
}

export interface RoundRewards {
  report(reporterId: string, matchId: string, round: number, wavedashUserId: string, kind: string): Promise<RoundReport>
}

export interface RoundRewardsDeps {
  api: TableApi
  ledger: EconomyLedger
  store: PlayerStore
  catalog: () => Catalog
  now?: () => number
}

function arg(value: unknown, name: string, max = 128): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new StoreError('bad_argument', `Invalid ${name}`)
}

export function createRoundRewards(deps: RoundRewardsDeps): RoundRewards {
  const { api, ledger, store } = deps
  const now = deps.now ?? Date.now
  const byMatch = (matchId: string): Filter[] => [{ field: 'match_id', op: 'eq', value: matchId }]

  /** The first reporter of a match becomes its host; anyone else is refused. */
  async function claimHost(matchId: string, reporterId: string): Promise<void> {
    let host = (await api.query('etc_round_hosts', { filters: byMatch(matchId), size: 1 }))[0]
    if (!host) {
      const made = await api.insert('etc_round_hosts', { match_id: matchId, player_id: reporterId, created_at: now() })
      if (made !== 'conflict') return
      host = (await api.query('etc_round_hosts', { filters: byMatch(matchId), size: 1 }))[0]
    }
    if (host?.player_id !== reporterId) throw new StoreError('forbidden', 'Another player hosts this match')
  }

  return {
    async report(reporterId, matchId, round, wavedashUserId, kind) {
      arg(reporterId, 'reporter id'); arg(matchId, 'match id'); arg(wavedashUserId, 'player')
      if (!Number.isSafeInteger(round) || round < 0 || round > MAX_ROUND) throw new StoreError('bad_argument', 'Invalid round')
      if (typeof kind !== 'string' || !ID_RE.test(kind)) throw new StoreError('bad_argument', 'Invalid round kind')
      const rewards = deps.catalog().round_rewards ?? {}
      const def = Object.hasOwn(rewards, kind) ? rewards[kind] : undefined
      if (!def) throw new StoreError('unknown_reward', 'Unknown round reward')
      await claimHost(matchId, reporterId)
      const { player } = await store.getOrCreateByIdentity({ provider: 'wavedash', external_id: wavedashUserId })
      const granted: RoundReward = { coins: def.coins, currencies: { ...def.currencies } }
      const txId = `rr:${matchId}|${round}|${wavedashUserId}|${kind}`
      const { result, applied } = await ledger.commit(player.player_id, txId, 'eco.round', [matchId, round, wavedashUserId, kind], () => ({
        fx: { coins: granted.coins, packs: {}, cards: {}, currencies: granted.currencies },
        result: { match_id: matchId, round, player: wavedashUserId, kind, granted },
      }))
      return { ...result, applied }
    },
  }
}
