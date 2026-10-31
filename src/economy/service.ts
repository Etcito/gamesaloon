// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Etcito
// One EconomyService per game (= per mission): the state of the players, the coin shop, pack opening, rewards,
// the paid purchases (Wavedash consumables, Stripe Checkout), and the cosmetic economy of the catalog (shop, round
// rewards, commissions, inbox, gifts). All durable state is in the mission's tables; the service keeps no balance
// of its own.

import { StoreError } from '../store/errors.ts'
import type { Filter, Row, TableApi } from '../store/tables.ts'
import type { PlayerStore } from '../store/types.ts'
import { createKeyedLock } from './lock.ts'
import { createCatalog, parseProduct } from './catalog.ts'
import type { CatalogHandle } from './catalog.ts'
import { createEconomyLedger } from './ledger.ts'
import type { EconomyLedger } from './ledger.ts'
import type { Rng } from './draw.ts'
import { WavedashError } from './wavedash.ts'
import type { ReceiptClaims, Wavedash } from './wavedash.ts'
import type { StripeBridge } from './stripe.ts'
import { createShop } from './shop.ts'
import type { ShopBuyResult, ShopView } from './shop.ts'
import { createRoundRewards } from './rounds.ts'
import type { RoundReport } from './rounds.ts'
import { createCommissions } from './commissions.ts'
import type { Commission, CommissionResult } from './commissions.ts'
import { createInbox } from './inbox.ts'
import type { ClaimResult, InboxEntry } from './inbox.ts'
import { createGifts } from './gifts.ts'
import type { GiftResult } from './gifts.ts'
import { FILTER_KEY, GIFT_KEY, parseFilterSettings, parseGiftSettings } from './gameconfig.ts'
import type { BuyResult, OpenResult, OpResult, Product, ProductProvider, PurchaseResult, RewardResult } from './types.ts'

export interface EconomyView {
  coins: number
  version: number
  packs: Array<{ pack_type: string; quantity: number }>
  cards: Record<string, number>
  /** Currency balances; absent when the player has none (a game without currencies keeps the shape above). */
  balances?: Record<string, number>
}

export interface ProductView {
  provider: ProductProvider
  code: string
  label: string
  description: string
  price: number
  currency: string
  grant_coins: number
  grant_packs: Record<string, number>
}

export class EconomyUnavailable extends Error {
  constructor(what: string) {
    super(`economy: ${what} is not configured`)
    this.name = 'EconomyUnavailable'
  }
}

export interface EconomyService {
  readonly game: string
  readonly catalog: CatalogHandle
  state(playerId: string): Promise<EconomyView>
  /** The active products; a player under a purchase ban sees none that costs real money. */
  products(playerId?: string): Promise<ProductView[]>
  /** Epoch ms until which this player may not buy with real money (after a refund), or null. */
  purchaseBlockedUntil(playerId: string): Promise<number | null>
  reward(playerId: string, rewardId: string): Promise<OpResult<RewardResult>>
  buy(playerId: string, opId: string, productCode: string, qty: number): Promise<OpResult<BuyResult>>
  open(playerId: string, opId: string, packType: string): Promise<OpResult<OpenResult>>
  /** A receipt forwarded by the game client of an authenticated player (optionally with the user JWT). */
  wavedashFromClient(playerId: string, receiptJwt: string, userJwt: string | undefined): Promise<PurchaseResult & { applied: boolean }>
  /** A receipt delivered by the Wavedash webhook (no session): the buyer is the player of the receipt's `sub`. Fulfills after granting. */
  wavedashFromWebhook(receiptJwt: string): Promise<PurchaseResult & { applied: boolean }>
  wavedashGameIds(): Promise<string[]>
  stripeCheckout(playerId: string, productCode: string, returnUrl: string): Promise<{ url: string; session_id: string }>
  /** A signature-verified Stripe event whose session belongs to this game. */
  stripeCompleted(session: Record<string, unknown>): Promise<(PurchaseResult & { applied: boolean }) | { status: 'ignored'; reason: string }>
  /** Reverses the purchase of this payment intent, if this game has it. false = not found here. */
  stripeRefunded(paymentIntent: string): Promise<boolean>
  hasStripe(): boolean
  /** Signature check of a raw Stripe webhook through the bridge: the event, or null when the signature is invalid. */
  stripeVerify(rawBody: string, signature: string): Promise<Record<string, unknown> | null>
  /** The cosmetic shop of the catalog with the copies left of capped items. */
  shop(): Promise<ShopView>
  /** Buys one shop item in one of its currencies. A replay of the op answers the stored result, applied:false. */
  shopBuy(playerId: string, opId: string, item: string, currency: string): Promise<ShopBuyResult & { applied: boolean }>
  /** A round reward reported by the match host; `player` is the Wavedash user id of the rewarded player. */
  roundReward(reporterId: string, matchId: string, round: number, player: string, kind: string): Promise<RoundReport>
  commission(playerId: string, opId: string, slot: string, rarity: string, description: string): Promise<CommissionResult>
  /** The player's commissions, newest first. */
  commissions(playerId: string): Promise<Commission[]>
  /** The commissions of the next shop drop (not shipped), oldest first, without player ids. */
  commissionQueue(): Promise<Commission[]>
  inbox(playerId: string): Promise<InboxEntry[]>
  claim(playerId: string, opId: string, id: string): Promise<ClaimResult>
  /** Gives one owned item to the player of the Wavedash user id `to`, through their inbox. */
  gift(playerId: string, opId: string, to: string, item: string, message: string): Promise<GiftResult>
  /** Blocks (or unblocks) the gifts of the player of the Wavedash user id `other`. */
  block(playerId: string, other: string, blocked: boolean): Promise<void>
  onChange(fn: (playerId: string) => void): void
  start(): void
  stop(): void
}

export interface EconomyServiceDeps {
  game: string
  api: TableApi
  store: PlayerStore
  wavedash?: Wavedash
  stripe?: StripeBridge | null
  now?: () => number
  rng?: Rng
  log?: (level: string, msg: string) => void
  catalogIntervalMs?: number
  maxCatalogBytes?: number
}

const CACHE_MS = 30_000
const SETTING_ALLOW_PLAYTEST = 'economy.allow_playtest'
const SETTING_REFUND_BAN_DAYS = 'economy.refund_ban_days'
const DEFAULT_REFUND_BAN_DAYS = 30
const DAY_MS = 86_400_000

export function createEconomyService(deps: EconomyServiceDeps): EconomyService {
  const { api, game } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const catalog = createCatalog(api, { game, intervalMs: deps.catalogIntervalMs, maxBytes: deps.maxCatalogBytes, log })
  const ledger: EconomyLedger = createEconomyLedger(api, { catalog: catalog.current, now, rng: deps.rng })
  const locked = createKeyedLock()
  const listeners: Array<(playerId: string) => void> = []
  const eq = (field: string, value: unknown): Filter => ({ field, op: 'eq', value })
  const one = async (table: string, filters: Filter[]): Promise<Row | undefined> => (await api.query(table, { filters, size: 1 }))[0]
  const notify = (playerId: string): void => { for (const fn of listeners) { try { fn(playerId) } catch { /* a listener never breaks a grant */ } } }

  const cache = new Map<string, { at: number; value: unknown }>()
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_MS) return hit.value as T
    const value = await load()
    cache.set(key, { at: now(), value })
    return value
  }

  /** A JSON setting of etc_settings, parsed and cached. An invalid value is logged and fails the operation that needs it. */
  function setting<T>(key: string, parse: (text: string | null) => T | null): () => Promise<T | null> {
    return () => cached(key, async () => {
      const row = await one('etc_settings', [eq('key', key)])
      try { return parse(typeof row?.value === 'string' ? row.value : null) }
      catch (e) { log('error', `[economy] ${game}: ${(e as Error).message}`); throw e }
    })
  }

  const shop = createShop({ api, ledger, catalog: catalog.current, now })
  const rounds = createRoundRewards({ api, ledger, store: deps.store, catalog: catalog.current, now })
  const commissions = createCommissions({ api, ledger, catalog: catalog.current, filter: setting(FILTER_KEY, parseFilterSettings), now })
  const inbox = createInbox({ api, ledger, catalog: catalog.current, now })
  const gifts = createGifts({ api, ledger, inbox, store: deps.store, gifts: setting(GIFT_KEY, parseGiftSettings), now })

  async function findProduct(provider: ProductProvider, code: string, activeOnly = true): Promise<Product | null> {
    const row = await one('etc_products', [eq('provider', provider), eq('code', code)])
    const p = row ? parseProduct(row) : null
    return p && (!activeOnly || p.active) ? p : null
  }

  async function wavedashGameIds(): Promise<string[]> {
    return cached('wd-ids', async () => {
      const rows = await api.query('etc_publishers', { filters: [eq('platform', 'wavedash')], size: 50 })
      return rows.filter(r => r.enabled !== false && typeof r.external_id === 'string' && r.external_id !== '').map(r => r.external_id as string)
    })
  }
  async function allowPlaytest(): Promise<boolean> {
    return cached('allow-playtest', async () => {
      const row = await one('etc_settings', [eq('key', SETTING_ALLOW_PLAYTEST)])
      return row?.value === '1' || row?.value === 'true'
    })
  }

  // --- refund sanction -----------------------------------------------------------------------------------------

  async function refundBanDays(): Promise<number> {
    const row = await one('etc_settings', [eq('key', SETTING_REFUND_BAN_DAYS)])
    const n = row ? Number(row.value) : NaN
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REFUND_BAN_DAYS
  }

  async function blockedUntil(playerId: string): Promise<number | null> {
    let rows: Row[]
    try { rows = await api.query('etc_purchase_bans', { filters: [eq('player_id', playerId), { field: 'until', op: 'gt', value: now() }], size: 50 }) }
    catch { log('error', `[economy] ${game}: etc_purchase_bans is not readable (apply the ERD): no ban enforced`); return null }
    let max = 0
    for (const r of rows) max = Math.max(max, Number(r.until) || 0)
    return max > 0 ? max : null
  }

  /** A refund costs the player the right to buy with real money for economy.refund_ban_days days (0 = no ban). */
  async function banAfterRefund(playerId: string, ref: string): Promise<void> {
    const days = await refundBanDays()
    if (days <= 0) return
    // Never let the sanction break the refund itself (the webhook would retry a refund that is already applied).
    try { await api.insert('etc_purchase_bans', { player_id: playerId, until: now() + days * DAY_MS, reason: 'refund', purchase_ref: ref, created_at: now() }) }
    catch { log('error', `[economy] ${game}: could not record the purchase ban of ${playerId} (${ref}): apply the ERD`) }
  }

  // --- purchases ---------------------------------------------------------------------------------------------

  const purchase = (provider: string, externalId: string) => one('etc_purchases', [eq('provider', provider), eq('external_id', externalId)])

  async function openPurchase(provider: ProductProvider, externalId: string, row: Row): Promise<Row> {
    const made = await api.insert('etc_purchases', { provider, external_id: externalId, status: 'pending', created_at: now(), ...row })
    if (made !== 'conflict') return made.row
    const existing = await purchase(provider, externalId)
    if (!existing) throw new Error('purchase row vanished')
    return existing
  }

  async function markGranted(row: Row, extra: Row = {}): Promise<void> {
    if (row.status === 'granted' && Object.keys(extra).length === 0) return
    await api.update('etc_purchases', row.id as number, { status: 'granted', granted_at: row.granted_at ?? now(), ...extra })
  }

  /** The grant of a purchase: idempotent through the ledger, then the purchase row. */
  async function grant(provider: ProductProvider, externalId: string, playerId: string, product: Product, extra: Row, txId: string): Promise<PurchaseResult & { applied: boolean }> {
    return locked([`x:${provider}:${externalId}`], async () => {
      let row = await openPurchase(provider, externalId, { player_id: playerId, product_code: product.code, amount: product.price, currency: product.currency, ...extra })
      if (row.status === 'refunded') throw new StoreError('purchase_refunded', 'This purchase was refunded')
      if (row.player_id !== playerId) throw new StoreError('bad_argument', 'This purchase belongs to another player')
      const r = await ledger.grantProduct(playerId, txId, product)
      await markGranted(row, extra.payment_ref ? { payment_ref: extra.payment_ref } : {})
      row = { ...row, status: 'granted' }
      if (r.applied) notify(playerId)
      return {
        provider, external_id: externalId, product: product.code, status: 'granted', coins: (await ledger.state(playerId)).coins,
        granted: r.result, applied: r.applied,
      }
    })
  }

  /** Marks a purchase refunded and takes back what the ledger granted for it. A refund seen first blocks a later grant. */
  async function refund(provider: ProductProvider, externalId: string, txId: string, fallback?: { player_id: string; product_code: string }): Promise<void> {
    await locked([`x:${provider}:${externalId}`], async () => {
      const row = await purchase(provider, externalId)
      if (!row) {
        if (!fallback) return
        await api.insert('etc_purchases', { provider, external_id: externalId, player_id: fallback.player_id, product_code: fallback.product_code, status: 'refunded', created_at: now(), refunded_at: now() })
        await banAfterRefund(fallback.player_id, `${provider}:${externalId}`)
        return
      }
      if (row.status === 'refunded') return
      const playerId = row.player_id as string
      if (await ledger.grantedBy(txId)) {
        await ledger.reverse(playerId, `rf:${provider}:${externalId}`, txId)
        notify(playerId)
      }
      await api.update('etc_purchases', row.id as number, { status: 'refunded', refunded_at: now() })
      await banAfterRefund(playerId, `${provider}:${externalId}`)
    })
  }

  function result(r: PurchaseResult & { applied: boolean }) { return r }

  // --- Wavedash ------------------------------------------------------------------------------------------------

  async function wavedashReceipt(receiptJwt: string): Promise<ReceiptClaims> {
    if (!deps.wavedash) throw new EconomyUnavailable('wavedash')
    return deps.wavedash.verifyReceipt(receiptJwt, { gameIds: await wavedashGameIds(), allowPlaytest: await allowPlaytest() })
  }

  async function applyReceipt(claims: ReceiptClaims, playerId: string): Promise<PurchaseResult & { applied: boolean }> {
    const txId = `wd:${claims.purchaseId}`
    if (claims.event === 'purchase.refunded') {
      await refund('wavedash', claims.purchaseId, txId, { player_id: playerId, product_code: claims.contentIdentifier })
      return result({ provider: 'wavedash', external_id: claims.purchaseId, product: claims.contentIdentifier, status: 'refunded', coins: (await ledger.state(playerId)).coins, granted: { coins: 0, packs: {} }, applied: true })
    }
    const product = await findProduct('wavedash', claims.contentIdentifier)
    if (!product) throw new StoreError('unknown_product', 'Unknown product')
    return grant('wavedash', claims.purchaseId, playerId, product, { payload: JSON.stringify({ gcid: claims.gcid, env: claims.env }) }, txId)
  }

  // --- the service ---------------------------------------------------------------------------------------------

  return {
    game,
    catalog,

    async state(playerId) {
      const s = await ledger.state(playerId)
      return {
        coins: s.coins, version: s.version, packs: Object.entries(s.packs).map(([pack_type, quantity]) => ({ pack_type, quantity })), cards: s.cards,
        ...(s.balances ? { balances: s.balances } : {}),
      }
    },

    purchaseBlockedUntil: (playerId) => blockedUntil(playerId),

    async products(playerId) {
      const blocked = playerId ? (await blockedUntil(playerId)) !== null : false
      const rows = await api.query('etc_products', { filters: [eq('active', true)], sort: [{ field: 'sort_order', dir: 'asc' }, { field: 'id', dir: 'asc' }], size: 200 })
      const out: ProductView[] = []
      for (const r of rows) {
        const p = parseProduct(r)
        if (p && p.active && !(blocked && p.provider !== 'coins')) out.push({ provider: p.provider, code: p.code, label: p.label, description: typeof r.description === 'string' ? r.description : '', price: p.price, currency: p.currency, grant_coins: p.grant_coins, grant_packs: p.grant_packs })
      }
      return out
    },

    reward: (playerId, rewardId) => ledger.reward(playerId, rewardId),

    async buy(playerId, opId, productCode, qty) {
      const product = await findProduct('coins', productCode)
      if (!product) throw new StoreError('unknown_product', 'Unknown product')
      const r = await ledger.buyWithCoins(playerId, opId, product, qty)
      // The shop receipt: one purchases row per coin purchase (insert-or-ignore: a replay adds nothing).
      await openPurchase('coins', `c:${playerId}:${opId}`, {
        player_id: playerId, product_code: product.code, status: 'granted', amount: product.price * qty, currency: 'coins', granted_at: now(),
      }).catch(() => undefined)
      return r
    },

    open: (playerId, opId, packType) => ledger.openPack(playerId, opId, packType),

    async wavedashFromClient(playerId, receiptJwt, userJwt) {
      const claims = await wavedashReceipt(receiptJwt)
      if (userJwt !== undefined) {
        const user = await deps.wavedash!.verifyUser(userJwt)
        if (user.sub !== claims.sub || (user.gcid !== null && claims.gcid !== null && user.gcid !== claims.gcid)) throw new WavedashError('receipt_mismatch', 'user jwt')
      }
      const player = await deps.store.getPlayer(playerId)
      if (!player || !player.identities.some(i => i.provider === 'wavedash' && i.external_id === claims.sub)) throw new WavedashError('receipt_mismatch', 'buyer')
      return applyReceipt(claims, playerId)
    },

    async wavedashFromWebhook(receiptJwt) {
      const claims = await wavedashReceipt(receiptJwt)
      const { player } = await deps.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: claims.sub })
      const res = await applyReceipt(claims, player.player_id)
      if (claims.event === 'purchase.completed') {
        const status = await deps.wavedash!.fulfill(claims.purchaseId, receiptJwt)
        if (status === 'NOT_FOUND') log('error', `[economy] ${game}: wavedash fulfill NOT_FOUND for ${claims.purchaseId} (refunded meanwhile?)`)
      }
      return res
    },

    wavedashGameIds,

    async stripeCheckout(playerId, productCode, returnUrl) {
      if (!deps.stripe) throw new EconomyUnavailable('stripe')
      const until = await blockedUntil(playerId)
      if (until !== null) throw new StoreError('purchases_blocked', String(until))
      const product = await findProduct('stripe', productCode)
      if (!product) throw new StoreError('unknown_product', 'Unknown product')
      const sep = returnUrl.includes('?') ? '&' : '?'
      const s = await deps.stripe.checkout({
        product_code: product.code, player_id: playerId, game,
        success_url: `${returnUrl}${sep}checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnUrl}${sep}checkout=cancel`,
      })
      await openPurchase('stripe', s.session_id, { player_id: playerId, product_code: product.code, amount: product.price, currency: product.currency })
      return s
    },

    async stripeCompleted(session) {
      const id = typeof session.id === 'string' ? session.id : ''
      if (!id) return { status: 'ignored', reason: 'no session id' }
      if (session.payment_status !== 'paid') return { status: 'ignored', reason: 'not paid' }
      const meta = (typeof session.metadata === 'object' && session.metadata !== null ? session.metadata : {}) as Record<string, unknown>
      const row = await purchase('stripe', id)
      const playerId = row ? (row.player_id as string) : typeof meta.player_id === 'string' ? meta.player_id : ''
      const code = row ? (row.product_code as string) : typeof meta.product === 'string' ? meta.product : ''
      if (!playerId || !code) return { status: 'ignored', reason: 'unknown purchase' }
      if (!(await deps.store.getPlayer(playerId))) return { status: 'ignored', reason: 'unknown player' }
      // An existing row keeps working after the product is switched off; a session without a row needs an active product.
      const product = await findProduct('stripe', code, row === undefined)
      if (!product) return { status: 'ignored', reason: 'unknown product' }
      const expectAmount = row && row.amount !== null && row.amount !== undefined ? Number(row.amount) : product.price
      const expectCurrency = String(row?.currency ?? product.currency).toLowerCase()
      if (Number(session.amount_total) !== expectAmount || String(session.currency ?? '').toLowerCase() !== expectCurrency) {
        log('error', `[economy] ${game}: stripe session ${id} amount/currency does not match the product, not granting`)
        return { status: 'ignored', reason: 'amount mismatch' }
      }
      const paymentRef = typeof session.payment_intent === 'string' ? session.payment_intent : undefined
      return grant('stripe', id, playerId, product, paymentRef ? { payment_ref: paymentRef } : {}, `st:${id}`)
    },

    async stripeRefunded(paymentIntent) {
      const row = await one('etc_purchases', [eq('provider', 'stripe'), eq('payment_ref', paymentIntent)])
      if (!row) return false
      await refund('stripe', row.external_id as string, `st:${row.external_id as string}`)
      return true
    },

    hasStripe: () => !!deps.stripe,
    async stripeVerify(rawBody, signature) {
      if (!deps.stripe) throw new EconomyUnavailable('stripe')
      return deps.stripe.verify(rawBody, signature)
    },

    shop: () => shop.view(),

    async shopBuy(playerId, opId, item, currency) {
      const r = await shop.buy(playerId, opId, item, currency)
      if (r.applied) notify(playerId)
      return r
    },

    async roundReward(reporterId, matchId, round, player, kind) {
      const r = await rounds.report(reporterId, matchId, round, player, kind)
      if (r.applied) notify((await deps.store.getOrCreateByIdentity({ provider: 'wavedash', external_id: player })).player.player_id)
      return r
    },

    async commission(playerId, opId, slot, rarity, description) {
      const r = await commissions.commission(playerId, opId, slot, rarity, description)
      if (r.applied) notify(playerId)
      return r
    },

    commissions: (playerId) => commissions.mine(playerId),
    commissionQueue: () => commissions.queue(),
    inbox: (playerId) => inbox.list(playerId),

    async claim(playerId, opId, id) {
      const r = await inbox.claim(playerId, opId, id)
      if (r.applied) notify(playerId)
      return r
    },

    async gift(playerId, opId, to, item, message) {
      const r = await gifts.gift(playerId, opId, to, item, message)
      if (r.applied) {
        notify(playerId)
        // The recipient is the one the gift module resolved, recorded on its etc_gifts row (keyed by the gift's tx id).
        const row = await one('etc_gifts', [eq('tx_id', `c:${playerId}:${opId}`)])
        if (typeof row?.to_player === 'string') notify(row.to_player)
      }
      return r
    },

    block: (playerId, other, blocked) => gifts.block(playerId, other, blocked),

    onChange(fn) { listeners.push(fn) },
    start() { void catalog.refresh(); catalog.start() },
    stop() { catalog.stop() },
  }
}
