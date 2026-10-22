import {
  getLeaderboard,
  getPortfolio,
  mapPool,
  monthPnlSeries,
  recentStockFills,
  stockDexNames,
  stockStateOf,
  type LeaderboardRow,
  type PnlPoint,
  type StockPosition,
} from "./hyperliquid.js"
import { prisma } from "./prisma.js"

export type TraderView = {
  address: string
  displayName: string | null
  accountValue: number
  pnl7d: number
  pnl30d: number
  roi7d: number
  roi30d: number
  positions: Array<{
    coin: string
    label: string
    side: "long" | "short"
    size: number
    leverage: number
    positionValue: number
    unrealizedPnl: number
  }>
  pnl30Series: PnlPoint[]
  joined: number
  winRate: number
  maxDrop: number
  score: number
}

const monthStats = (series: PnlPoint[]) => {
  if (series.length < 2) return { winRate: 0.5, maxDrop: 0 }
  let up = 0
  let down = 0
  let peak = series[0]?.v ?? 0
  let maxDrop = 0
  for (let index = 1; index < series.length; index += 1) {
    const prev = series[index - 1]?.v ?? 0
    const next = series[index]?.v ?? 0
    if (next > prev) up += 1
    else if (next < prev) down += 1
    peak = Math.max(peak, next)
    maxDrop = Math.max(maxDrop, peak - next)
  }
  const steps = up + down
  return { winRate: steps ? up / steps : 0.5, maxDrop }
}

const copyScore = (pnl30d: number, winRate: number, maxDrop: number, accountValue: number) => {
  const quality = 0.4 + 0.6 * Math.min(1, Math.max(0, winRate))
  const base = accountValue > 0 ? accountValue : Math.max(Math.abs(pnl30d), 1)
  return pnl30d * quality * (1 / (1 + maxDrop / base))
}

const scored = <T extends { pnl30d: number; accountValue: number; pnl30Series: PnlPoint[] }>(row: T) => {
  const stats = monthStats(row.pnl30Series)
  return {
    ...row,
    winRate: stats.winRate,
    maxDrop: stats.maxDrop,
    score: copyScore(row.pnl30d, stats.winRate, stats.maxDrop, row.accountValue),
  }
}

const windowValue = (row: LeaderboardRow, name: string, key: "pnl" | "roi") => {
  const found = row.windowPerformances?.find((item) => item[0] === name)
  return Number(found?.[1]?.[key] ?? 0)
}

const publicPosition = (position: StockPosition) => ({
  coin: position.coin,
  label: position.label,
  side: position.side,
  size: position.size,
  leverage: position.leverage,
  positionValue: position.positionValue,
  unrealizedPnl: position.unrealizedPnl,
})

const joinCountMap = async () => {
  try {
    const rows = await prisma.join.groupBy({
      by: ["trader"],
      where: { status: "active" },
      _count: { _all: true },
    })
    return new Map(rows.map((row) => [row.trader.toLowerCase(), row._count._all]))
  } catch {
    return new Map<string, number>()
  }
}

const buildTrader = async (
  row: LeaderboardRow,
  joined: number,
  withSeries: boolean,
): Promise<TraderView | null> => {
  const address = row.ethAddress
  let stock: Awaited<ReturnType<typeof stockStateOf>>
  try {
    stock = await stockStateOf(address)
  } catch {
    return null
  }
  if (!stock.positions.length) return null
  const accountValue = stock.accountValue > 0 ? stock.accountValue : Number(row.accountValue ?? 0)
  let series: PnlPoint[] = []
  if (withSeries) {
    try {
      series = monthPnlSeries(await getPortfolio(address))
    } catch {
      series = []
    }
  }
  return scored({
    address,
    displayName: row.displayName ?? null,
    accountValue,
    pnl7d: windowValue(row, "week", "pnl"),
    pnl30d: windowValue(row, "month", "pnl"),
    roi7d: windowValue(row, "week", "roi"),
    roi30d: windowValue(row, "month", "roi"),
    positions: stock.positions.map(publicPosition),
    pnl30Series: series,
    joined,
  })
}

let board: { at: number; traders: TraderView[] } | null = null
let inflight: Promise<TraderView[]> | null = null

const scanBoard = async () => {
  const payload = await getLeaderboard()
  const rows = payload.leaderboardRows ?? []
  const ranked = [...rows].sort((a, b) => windowValue(b, "month", "pnl") - windowValue(a, "month", "pnl"))
  const candidates = ranked.slice(0, 80)
  const counts = await joinCountMap()
  const probed = await mapPool(candidates, 6, async (row) => {
    try {
      const stock = await stockStateOf(row.ethAddress, ["xyz"])
      return stock.positions.length ? { row, stock } : { row, stock: null }
    } catch {
      return { row, stock: null }
    }
  })
  const rest = probed.filter((item) => !item.stock).slice(0, 16)
  const otherDexs = (await stockDexNames()).filter((name) => name !== "xyz")
  const others = await mapPool(rest, 3, async (item) => {
    try {
      const stock = await stockStateOf(item.row.ethAddress, otherDexs)
      if (!stock.positions.length) return null
      return { row: item.row, stock }
    } catch {
      return null
    }
  })
  const found = [
    ...probed.flatMap((item) => (item.stock ? [item as { row: LeaderboardRow; stock: NonNullable<typeof item.stock> }] : [])),
    ...others.flatMap((item) => (item ? [item] : [])),
  ]
    .sort((a, b) => windowValue(b.row, "month", "pnl") - windowValue(a.row, "month", "pnl"))
    .slice(0, 24)
  const traders = await mapPool(found, 4, async (item) => {
    const stock = item.stock
    const accountValue = stock.accountValue > 0 ? stock.accountValue : Number(item.row.accountValue ?? 0)
    let series: PnlPoint[] = []
    try {
      series = monthPnlSeries(await getPortfolio(item.row.ethAddress))
    } catch {
      series = []
    }
    return scored({
      address: item.row.ethAddress,
      displayName: item.row.displayName ?? null,
      accountValue,
      pnl7d: windowValue(item.row, "week", "pnl"),
      pnl30d: windowValue(item.row, "month", "pnl"),
      roi7d: windowValue(item.row, "week", "roi"),
      roi30d: windowValue(item.row, "month", "roi"),
      positions: stock.positions.map(publicPosition),
      pnl30Series: series,
      joined: counts.get(item.row.ethAddress.toLowerCase()) ?? 0,
    }) satisfies TraderView
  })
  return traders.sort((a, b) => b.score - a.score)
}

export const traderBoard = async () => {
  if (board && Date.now() - board.at < 15_000) return board.traders
  if (!inflight) {
    inflight = scanBoard()
      .then((traders) => {
        board = { at: Date.now(), traders }
        return traders
      })
      .finally(() => {
        inflight = null
      })
  }
  if (board) return board.traders
  return inflight
}

export const traderByAddress = async (address: string) => {
  const normalized = address.toLowerCase()
  const payload = await getLeaderboard()
  const row = (payload.leaderboardRows ?? []).find((item) => item.ethAddress.toLowerCase() === normalized)
  const counts = await joinCountMap()
  if (!row) {
    const stock = await stockStateOf(address)
    if (!stock.positions.length) return null
    let series: PnlPoint[] = []
    try {
      series = monthPnlSeries(await getPortfolio(address))
    } catch {
      series = []
    }
    return scored({
      address,
      displayName: null,
      accountValue: stock.accountValue,
      pnl7d: 0,
      pnl30d: series.length ? series[series.length - 1].v - series[0].v : 0,
      roi7d: 0,
      roi30d: 0,
      positions: stock.positions.map(publicPosition),
      pnl30Series: series,
      joined: counts.get(normalized) ?? 0,
    }) satisfies TraderView
  }
  return buildTrader(row, counts.get(normalized) ?? 0, true)
}

export const traderFills = async (address: string) => {
  const fills = await recentStockFills(address)
  return fills.map((fill) => ({
    id: String(fill.tid ?? fill.time ?? ""),
    coin: fill.coin ?? "",
    label: (fill.coin ?? "").split(":").pop() ?? "",
    side: fill.side === "B" ? "long" as const : "short" as const,
    size: Number(fill.sz ?? 0),
    price: Number(fill.px ?? 0),
    fee: Number(fill.fee ?? 0),
    pnl: Number(fill.closedPnl ?? 0),
    dir: fill.dir ?? "",
    time: Number(fill.time ?? 0),
  }))
}

export type TapePrint = {
  address: string
  label: string
  side: "long" | "short"
  size: number
  price: number
  time: number
}

let tapeCache: { at: number; rows: TapePrint[] } | null = null

export const traderTape = async () => {
  if (tapeCache && Date.now() - tapeCache.at < 20_000) return tapeCache.rows
  const traders = (await traderBoard()).slice(0, 6)
  const batches = await mapPool(traders, 3, async (trader) => {
    const fills = await recentStockFills(trader.address).catch(() => [])
    return fills.slice(0, 8).map((fill) => ({
      address: trader.address,
      label: (fill.coin ?? "").split(":").pop() ?? "",
      side: fill.side === "B" ? "long" as const : "short" as const,
      size: Number(fill.sz ?? 0),
      price: Number(fill.px ?? 0),
      time: Number(fill.time ?? 0),
    }))
  })
  const rows = batches.flat().filter((row) => row.size > 0 && row.price > 0).sort((a, b) => b.time - a.time).slice(0, 40)
  tapeCache = { at: Date.now(), rows }
  return rows
}

export const accountValueFor = async (address: string) => {
  const stock = await stockStateOf(address)
  if (stock.accountValue > 0) return { accountValue: stock.accountValue, positions: stock.positions }
  const payload = await getLeaderboard().catch(() => ({ leaderboardRows: [] as LeaderboardRow[] }))
  const row = (payload.leaderboardRows ?? []).find((item) => item.ethAddress.toLowerCase() === address.toLowerCase())
  return { accountValue: Number(row?.accountValue ?? 0), positions: stock.positions }
}
