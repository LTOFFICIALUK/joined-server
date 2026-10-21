import { env } from "./env.js"

type CacheEntry = { at: number; ttl: number; data: unknown }
const cache = new Map<string, CacheEntry>()

const remember = async <T>(key: string, ttlMs: number, fn: () => Promise<T>) => {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < hit.ttl) return hit.data as T
  const data = await fn()
  for (const [entryKey, entry] of cache) {
    if (now - entry.at >= entry.ttl) cache.delete(entryKey)
  }
  cache.set(key, { at: now, ttl: ttlMs, data })
  return data
}

export const mapPool = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) => {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return out
}

export const hlInfo = async (body: Record<string, unknown>) => {
  const res = await fetch(env.hlInfoUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Hyperliquid ${res.status}`)
  }
  return res.json()
}

export const STOCK_DEX = "xyz"

const CRYPTO = new Set([
  "BTC", "ETH", "SOL", "HYPE", "DOGE", "XRP", "BNB", "ADA", "AVAX", "LINK", "SUI", "LTC", "BCH",
  "ENA", "FARTCOIN", "PUMP", "XPL", "ZEC", "IP", "LIT", "BASED", "XMR", "USDE", "kPEPE", "AAVE",
  "WLD", "TIA", "ONDO", "JUP", "WIF", "POPCAT", "TRUMP", "MELANIA", "KAITO", "S", "FART",
])

type DexRow = { name?: string; assetToStreamingOiCap?: Array<[string, string]> } | null

export const getPerpDexs = () =>
  remember("perpDexs", 5 * 60_000, () => hlInfo({ type: "perpDexs" }) as Promise<DexRow[]>)

const symbolOf = (coin: string) => coin.split(":").pop() ?? coin

export const stockDexNames = async () => {
  const dexs = await getPerpDexs()
  return dexs.flatMap((row) => {
    if (!row?.name) return []
    const symbols = (row.assetToStreamingOiCap ?? []).map(([coin]) => symbolOf(coin))
    if (!symbols.length) return []
    const cryptoCount = symbols.filter((symbol) => CRYPTO.has(symbol)).length
    if (cryptoCount / symbols.length >= 0.5) return []
    return [row.name]
  })
}

const dexIndexOf = async (name: string) => {
  const dexs = await getPerpDexs()
  const index = dexs.findIndex((row) => row?.name === name)
  if (index < 0) throw new Error(`The ${name} market list is not available`)
  return index
}

export const getAllMids = () =>
  remember("allMids", 750, () => hlInfo({ type: "allMids" }))

export const getStockMids = () =>
  remember("allMids:xyz", 750, () => hlInfo({ type: "allMids", dex: STOCK_DEX }))

export const getL2 = (coin: string) =>
  hlInfo({ type: "l2Book", coin, nSigFigs: 5 })

export const getClearinghouse = (user: string) =>
  hlInfo({ type: "clearinghouseState", user })

export const getDexClearinghouse = (user: string, dex = STOCK_DEX) =>
  hlInfo({ type: "clearinghouseState", user, dex })

export const getOpenOrders = (user: string) =>
  hlInfo({ type: "openOrders", user })

export const getDexOpenOrders = (user: string, dex = STOCK_DEX) =>
  hlInfo({ type: "openOrders", user, dex })

export const getUserFills = (user: string, dex?: string) =>
  hlInfo(dex ? { type: "userFills", user, dex } : { type: "userFills", user })

export const getDexUserFills = (user: string, dex = STOCK_DEX) =>
  hlInfo({ type: "userFills", user, dex })

export const getPortfolio = (user: string) =>
  hlInfo({ type: "portfolio", user })

export const getLeaderboard = () =>
  remember("leaderboard", 60_000, async () => {
    const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")
    if (!res.ok) throw new Error("The Hyperliquid leaderboard is unavailable")
    return res.json() as Promise<{ leaderboardRows?: LeaderboardRow[] }>
  })

export type LeaderboardRow = {
  ethAddress: string
  accountValue: string
  displayName?: string | null
  windowPerformances?: Array<[string, { pnl?: string; roi?: string; vlm?: string }]>
}

export type MarketGroup = "stocks" | "indexes" | "commodities" | "fx"

export type MarketRow = {
  coin: string
  label: string
  dex: string
  group: MarketGroup
  assetId: number
  szDecimals: number
  maxLeverage: number
  onlyIsolated: boolean
  markPx: number
  midPx: number
  oraclePx: number
  funding: number
  openInterest: number
  dayNtlVlm: number
  prevDayPx: number
  change24h: number
}

const INDEXES = new Set([
  "XYZ100", "SP500", "JP225", "KR200", "NIFTY", "IBOV", "VIX",
  "EWY", "EWJ", "EWZ", "EWT", "XLE", "SMH", "SPCX", "USA500", "USA100", "US500", "USTECH",
  "SMALL2000", "MAG7", "KWEB",
])
const COMMODITIES = new Set([
  "GOLD", "SILVER", "CL", "COPPER", "NATGAS", "URANIUM", "ALUMINIUM",
  "PLATINUM", "PALLADIUM", "BRENTOIL", "CORN", "WHEAT", "TTF", "HO", "OIL", "WTI", "GAS",
  "GOLDJM", "SILVERJM", "SOY",
])
const FX = new Set(["JPY", "EUR", "GBP", "KRW", "DXY"])

export const marketGroup = (coin: string): MarketGroup => {
  const symbol = symbolOf(coin)
  if (FX.has(symbol)) return "fx"
  if (COMMODITIES.has(symbol)) return "commodities"
  if (INDEXES.has(symbol)) return "indexes"
  return "stocks"
}

type MetaCtx = [
  { universe: Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }> },
  Array<{
    markPx?: string
    midPx?: string
    oraclePx?: string
    funding?: string
    openInterest?: string
    dayNtlVlm?: string
    prevDayPx?: string
  }>,
]

const metaFor = (dex: string) =>
  remember(`meta:${dex}`, 4000, () => hlInfo({ type: "metaAndAssetCtxs", dex }) as Promise<MetaCtx>)

export const listMarkets = async (): Promise<MarketRow[]> => {
  const names = await stockDexNames()
  const groups = await mapPool(names, 4, async (dex) => {
    const dexIndex = await dexIndexOf(dex)
    const [meta, ctxs] = await metaFor(dex)
    return meta.universe.map((universe, index) => {
      const ctx = ctxs[index]
      const mark = Number(ctx?.markPx ?? 0)
      const prev = Number(ctx?.prevDayPx ?? 0)
      return {
        coin: universe.name,
        label: symbolOf(universe.name),
        dex,
        group: marketGroup(universe.name),
        assetId: 100_000 + dexIndex * 10_000 + index,
        szDecimals: universe.szDecimals,
        maxLeverage: universe.maxLeverage,
        onlyIsolated: Boolean(universe.onlyIsolated),
        markPx: mark,
        midPx: Number(ctx?.midPx ?? mark),
        oraclePx: Number(ctx?.oraclePx ?? mark),
        funding: Number(ctx?.funding ?? 0),
        openInterest: Number(ctx?.openInterest ?? 0),
        dayNtlVlm: Number(ctx?.dayNtlVlm ?? 0),
        prevDayPx: prev,
        change24h: prev ? ((mark - prev) / prev) * 100 : 0,
      }
    })
  })
  return groups.flat()
}

export type ClearinghouseState = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string; totalNtlPos?: string }
  withdrawable?: string
  assetPositions?: Array<{
    position: {
      coin: string
      szi: string
      entryPx: string | null
      positionValue: string
      unrealizedPnl: string
      liquidationPx: string | null
      marginUsed: string
      leverage?: { value?: number; type?: string }
    }
  }>
}

export type StockPosition = {
  coin: string
  label: string
  dex: string
  side: "long" | "short"
  signedSize: number
  size: number
  entryPx: number
  positionValue: number
  unrealizedPnl: number
  leverage: number
  liquidation: number | null
}

const positionsFrom = (dex: string, state: ClearinghouseState | null): StockPosition[] => {
  if (!state?.assetPositions) return []
  return state.assetPositions.flatMap(({ position }) => {
    const signedSize = Number(position.szi)
    if (!Number.isFinite(signedSize) || Math.abs(signedSize) === 0) return []
    return [{
      coin: position.coin,
      label: symbolOf(position.coin),
      dex,
      side: signedSize >= 0 ? "long" as const : "short" as const,
      signedSize,
      size: Math.abs(signedSize),
      entryPx: Number(position.entryPx ?? 0),
      positionValue: Math.abs(Number(position.positionValue ?? 0)),
      unrealizedPnl: Number(position.unrealizedPnl ?? 0),
      leverage: Number(position.leverage?.value ?? 1),
      liquidation: position.liquidationPx ? Number(position.liquidationPx) : null,
    }]
  })
}

export const stockStateOf = async (user: string, only?: string[]) => {
  const dexs = only ?? await stockDexNames()
  const cacheKey = `stock:${user.toLowerCase()}:${dexs.join(",")}`
  return remember(cacheKey, 3000, () => loadStockState(user, dexs))
}

const loadStockState = async (user: string, dexs: string[]) => {
  const states = await mapPool(dexs, 4, async (dex) => {
    try {
      const state = (await getDexClearinghouse(user, dex)) as ClearinghouseState
      return { dex, state }
    } catch {
      return { dex, state: null as ClearinghouseState | null }
    }
  })
  if (states.length && states.every((row) => row.state === null)) {
    throw new Error("Hyperliquid did not return positions")
  }
  const positions = states.flatMap((row) => positionsFrom(row.dex, row.state))
  const accountValue = states.reduce((total, row) => {
    const has = positionsFrom(row.dex, row.state).length > 0
    if (!has) return total
    return total + Number(row.state?.marginSummary?.accountValue ?? 0)
  }, 0)
  return { positions, accountValue }
}

export const getStockBooks = async (user: string) => {
  const stock = await stockStateOf(user)
  const positions = stock.positions
  const orders: unknown[] = []
  const fills: unknown[] = []
  const assetPositions = positions.map((position) => ({
    position: {
      coin: position.coin,
      szi: String(position.signedSize),
      entryPx: String(position.entryPx),
      positionValue: String(position.side === "short" ? -position.positionValue : position.positionValue),
      unrealizedPnl: String(position.unrealizedPnl),
      liquidationPx: position.liquidation === null ? null : String(position.liquidation),
      marginUsed: "0",
      leverage: { value: position.leverage, type: "cross" },
    },
  }))
  return { assetPositions, orders, fills, positions }
}

export type PnlPoint = { t: number; v: number }

export const monthPnlSeries = (portfolio: unknown): PnlPoint[] => {
  if (!Array.isArray(portfolio)) return []
  const rows = portfolio as Array<[string, { pnlHistory?: Array<[number, string]> }]>
  const month = rows.find((row) => row[0] === "month") ?? rows.find((row) => row[0] === "perpMonth")
  const history = month?.[1]?.pnlHistory
  if (!Array.isArray(history)) return []
  const points = history.flatMap((point) => {
    const t = Number(point?.[0])
    const v = Number(point?.[1])
    if (!Number.isFinite(t) || !Number.isFinite(v)) return []
    return [{ t, v }]
  })
  if (points.length <= 48) return points
  const step = Math.ceil(points.length / 48)
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
}

export type RawFill = {
  coin?: string
  side?: string
  px?: string
  sz?: string
  fee?: string
  closedPnl?: string
  time?: number
  tid?: number
  dir?: string
}

const loadRecentStockFills = async (user: string) => {
  const found: RawFill[] = []
  let end = Date.now()
  const floor = end - 30 * 24 * 60 * 60 * 1000
  for (let page = 0; page < 4 && found.length < 30; page += 1) {
    const batch = (await hlInfo({
      type: "userFillsByTime",
      user,
      startTime: floor,
      endTime: end,
    }).catch(() => [])) as RawFill[] | null
    const rows = Array.isArray(batch) ? batch : []
    if (!rows.length) break
    for (const fill of rows) {
      if ((fill.coin ?? "").includes(":")) found.push(fill)
    }
    const oldest = Math.min(...rows.map((row) => Number(row.time ?? end)))
    if (rows.length < 2000 || oldest <= floor) break
    end = oldest - 1
  }
  return found.sort((a, b) => Number(b.time ?? 0) - Number(a.time ?? 0)).slice(0, 30)
}

export const recentStockFills = (user: string) =>
  remember(`fills:${user.toLowerCase()}`, 20_000, () => loadRecentStockFills(user))
