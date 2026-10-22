import {
  getLeaderboard,
  getPortfolio,
  mapPool,
  pnlSeries,
  recentStockFills,
  stockDexNames,
  stockStateOf,
  type LeaderboardRow,
  type PnlPoint,
  type StockPosition,
} from "./hyperliquid.js"
import { assignNicknames } from "./nicknames.js"
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
    entryPx: number
    liquidation: number | null
    markPx: number
  }>
  pnl7Series: PnlPoint[]
  pnl30Series: PnlPoint[]
  pnlAllSeries: PnlPoint[]
  pnlAll: number | null
  joined: number
  winRate: number
  maxDrop: number
  score: number
  nickname: string
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
  entryPx: position.entryPx,
  liquidation: position.liquidation,
  markPx: position.size > 0 ? position.positionValue / position.size : 0,
})

const listedPositions = (positions: StockPosition[]) =>
  [...positions].sort((a, b) => b.positionValue - a.positionValue).map(publicPosition)

const readCurves = async (address: string) => {
  try {
    const portfolio = await getPortfolio(address)
    return {
      pnl7Series: pnlSeries(portfolio, "week"),
      pnl30Series: pnlSeries(portfolio, "month"),
      pnlAllSeries: pnlSeries(portfolio, "allTime"),
    }
  } catch {
    return { pnl7Series: [] as PnlPoint[], pnl30Series: [] as PnlPoint[], pnlAllSeries: [] as PnlPoint[] }
  }
}

const allTimePnl = (row: LeaderboardRow | null, series: PnlPoint[]) => {
  const found = row?.windowPerformances?.find((item) => item[0] === "allTime" || item[0] === "perpAllTime")
  if (found) return Number(found[1]?.pnl ?? 0)
  if (series.length >= 2) return (series[series.length - 1]?.v ?? 0) - (series[0]?.v ?? 0)
  return null
}

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
  const curves = withSeries ? await readCurves(address) : { pnl7Series: [], pnl30Series: [], pnlAllSeries: [] }
  return scored({
    address,
    displayName: row.displayName ?? null,
    accountValue,
    pnl7d: windowValue(row, "week", "pnl"),
    pnl30d: windowValue(row, "month", "pnl"),
    roi7d: windowValue(row, "week", "roi"),
    roi30d: windowValue(row, "month", "roi"),
    positions: listedPositions(stock.positions),
    ...curves,
    pnlAll: allTimePnl(row, curves.pnlAllSeries),
    joined,
    nickname: "",
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
    const curves = await readCurves(item.row.ethAddress)
    return scored({
      address: item.row.ethAddress,
      displayName: item.row.displayName ?? null,
      accountValue,
      pnl7d: windowValue(item.row, "week", "pnl"),
      pnl30d: windowValue(item.row, "month", "pnl"),
      roi7d: windowValue(item.row, "week", "roi"),
      roi30d: windowValue(item.row, "month", "roi"),
      positions: listedPositions(stock.positions),
      ...curves,
      pnlAll: allTimePnl(item.row, curves.pnlAllSeries),
      joined: counts.get(item.row.ethAddress.toLowerCase()) ?? 0,
      nickname: "",
    }) satisfies TraderView
  })
  return assignNicknames(traders.sort((a, b) => b.score - a.score))
}

const BOARD_MS = 20_000

const refreshBoard = () => {
  if (inflight) return inflight
  inflight = scanBoard()
    .then((traders) => {
      const previous = board?.traders ?? []
      const weak = previous.length >= 8 && traders.length < previous.length * 0.6
      const next = weak ? previous : traders
      board = { at: Date.now() - (weak ? 10_000 : 0), traders: next }
      return next
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export const traderBoard = async () => {
  const fresh = board && Date.now() - board.at < BOARD_MS
  if (fresh && board) return board.traders
  const pending = refreshBoard()
  if (board?.traders.length) return board.traders
  return pending
}

export const traderByAddress = async (address: string) => {
  const normalized = address.toLowerCase()
  const listed = board?.traders.find((item) => item.address.toLowerCase() === normalized)
  if (listed) return listed
  const payload = await getLeaderboard()
  const row = (payload.leaderboardRows ?? []).find((item) => item.ethAddress.toLowerCase() === normalized)
  const counts = await joinCountMap()
  if (!row) {
    const stock = await stockStateOf(address)
    if (!stock.positions.length) return null
    const curves = await readCurves(address)
    const view = scored({
      address,
      displayName: null,
      accountValue: stock.accountValue,
      pnl7d: 0,
      pnl30d: curves.pnl30Series.length >= 2 ? (curves.pnl30Series[curves.pnl30Series.length - 1]?.v ?? 0) - (curves.pnl30Series[0]?.v ?? 0) : 0,
      roi7d: 0,
      roi30d: 0,
      positions: listedPositions(stock.positions),
      ...curves,
      pnlAll: allTimePnl(null, curves.pnlAllSeries),
      joined: counts.get(normalized) ?? 0,
      nickname: "",
    })
    const known = (await traderBoard()).find((item) => item.address.toLowerCase() === normalized)
    return { ...view, nickname: known?.nickname || assignNicknames([view])[0]?.nickname || "Quiet Book" }
  }
  const view = await buildTrader(row, counts.get(normalized) ?? 0, true)
  if (!view) return null
  const known = (await traderBoard()).find((item) => item.address.toLowerCase() === normalized)
  return { ...view, nickname: known?.nickname || assignNicknames([view])[0]?.nickname || "Quiet Book" }
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
  nickname: string
  label: string
  side: "long" | "short"
  size: number
  price: number
  time: number
  dir: string
  leverage: number | null
}

let tapeCache: { at: number; rows: TapePrint[] } | null = null
let tapeInflight: Promise<TapePrint[]> | null = null

const TAPE_MS = 20_000

export const traderTape = async () => {
  const fresh = tapeCache && Date.now() - tapeCache.at < TAPE_MS
  if (fresh && tapeCache) return tapeCache.rows
  if (tapeInflight) return tapeCache?.rows.length ? tapeCache.rows : tapeInflight
  const run = async () => {
  const traders = await traderBoard()
  const batches = await mapPool(traders, 3, async (trader) => {
    const fills = await recentStockFills(trader.address).catch(() => [])
    return fills.slice(0, 3).map((fill) => {
      const label = (fill.coin ?? "").split(":").pop() ?? ""
      const held = trader.positions.find((position) => position.label === label)
      return {
        address: trader.address,
        nickname: trader.nickname,
        label,
        side: fill.side === "B" ? "long" as const : "short" as const,
        size: Number(fill.sz ?? 0),
        price: Number(fill.px ?? 0),
        time: Number(fill.time ?? 0),
        dir: fill.dir ?? "",
        leverage: held ? held.leverage : null,
      }
    })
  })
  const rows = batches.flat().filter((row) => row.size > 0 && row.price > 0).sort((a, b) => b.time - a.time).slice(0, 40)
  if (!rows.length) return tapeCache?.rows ?? []
  tapeCache = { at: Date.now(), rows }
  return rows
  }
  tapeInflight = run().finally(() => {
    tapeInflight = null
  })
  if (tapeCache?.rows.length) return tapeCache.rows
  return tapeInflight
}

export const startPublicCache = () => {
  const tick = () => {
    if (!board || Date.now() - board.at >= BOARD_MS) {
      void traderBoard().catch((err) => {
        console.error(err instanceof Error ? err.message : "Board refresh failed")
      })
    }
    if (!tapeCache || Date.now() - tapeCache.at >= TAPE_MS) {
      void traderTape().catch((err) => {
        console.error(err instanceof Error ? err.message : "Tape refresh failed")
      })
    }
  }
  tick()
  const timer = setInterval(tick, BOARD_MS)
  timer.unref()
}

export const stockMarkets = async () => {
  const traders = await traderBoard()
  const rows = new Map<string, {
    label: string
    longUsd: number
    shortUsd: number
    longWallets: number
    shortWallets: number
    biggestUsd: number
    biggestSide: "long" | "short"
  }>()
  for (const trader of traders) {
    for (const position of trader.positions) {
      const current = rows.get(position.label) ?? {
        label: position.label,
        longUsd: 0,
        shortUsd: 0,
        longWallets: 0,
        shortWallets: 0,
        biggestUsd: 0,
        biggestSide: position.side,
      }
      if (position.side === "long") {
        current.longUsd += position.positionValue
        current.longWallets += 1
      } else {
        current.shortUsd += position.positionValue
        current.shortWallets += 1
      }
      if (position.positionValue > current.biggestUsd) {
        current.biggestUsd = position.positionValue
        current.biggestSide = position.side
      }
      rows.set(position.label, current)
    }
  }
  return [...rows.values()].sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd))
}

export const stockMarket = async (ticker: string) => {
  const label = ticker.toUpperCase()
  const markets = await stockMarkets()
  const market = markets.find((row) => row.label.toUpperCase() === label)
  if (!market) return null
  const traders = await traderBoard()
  const holders = traders.flatMap((trader) => {
    const position = trader.positions.find((item) => item.label.toUpperCase() === label)
    if (!position) return []
    return [{
      address: trader.address,
      nickname: trader.nickname,
      side: position.side,
      sizeUsd: position.positionValue,
      leverage: position.leverage,
    }]
  }).sort((a, b) => b.sizeUsd - a.sizeUsd)
  const prints = (await traderTape()).filter((row) => row.label.toUpperCase() === label)
  return { ...market, holders, prints }
}

export const joinersFor = async (trader: string) => {
  const rows = await prisma.join.findMany({
    where: { trader: trader.toLowerCase(), status: { in: ["active", "paused"] } },
    include: { user: { select: { evmAddress: true } } },
  })
  return {
    count: rows.length,
    copiedUsd: rows.reduce((sum, row) => sum + row.sizeUsd, 0),
    wallets: rows.flatMap((row) => (row.user.evmAddress ? [row.user.evmAddress] : [])),
  }
}

export const siteStats = async () => {
  const [joins, deposits, actions, copiedTrades] = await Promise.all([
    prisma.join.findMany({ where: { status: { in: ["active", "paused"] } }, select: { userId: true, sizeUsd: true } }),
    prisma.deposit.findMany({ where: { status: "done" }, select: { raw: true } }),
    prisma.copyAction.findMany({
      where: { status: "done" },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { join: { select: { trader: true, user: { select: { evmAddress: true } } } } },
    }),
    prisma.copyAction.count({ where: { status: "done" } }),
  ])
  return {
    walletsJoined: new Set(joins.map((row) => row.userId)).size,
    copiedUsd: joins.reduce((sum, row) => sum + row.sizeUsd, 0),
    copiedTrades,
    depositsUsd: deposits.reduce((sum, row) => {
      const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw as { amountUsd?: unknown } : {}
      const usd = Number(raw.amountUsd ?? 0)
      return sum + (Number.isFinite(usd) ? usd : 0)
    }, 0),
    recent: actions.map((row) => ({
      id: row.id,
      trader: row.join.trader,
      coin: row.coin,
      detail: row.detail,
      traderAction: row.traderAction,
      ourAction: row.ourAction,
      ourSize: row.ourSize,
      side: row.side,
      evmAddress: row.join.user.evmAddress,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}

export const accountValueFor = async (address: string) => {
  const stock = await stockStateOf(address)
  if (stock.accountValue > 0) return { accountValue: stock.accountValue, positions: stock.positions }
  const payload = await getLeaderboard().catch(() => ({ leaderboardRows: [] as LeaderboardRow[] }))
  const row = (payload.leaderboardRows ?? []).find((item) => item.ethAddress.toLowerCase() === address.toLowerCase())
  return { accountValue: Number(row?.accountValue ?? 0), positions: stock.positions }
}
