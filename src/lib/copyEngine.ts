import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid"
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils"
import { Prisma } from "@prisma/client"
import { privateKeyToAccount } from "viem/accounts"
import { listMarkets, stockStateOf, type MarketRow, type StockPosition } from "./hyperliquid.js"
import { ensureLiveWallet } from "./liveWallet.js"
import { prisma } from "./prisma.js"
import { tradeError } from "./tradeError.js"

const MIN_NOTIONAL = 10
const EPS = 1e-8

export const scaledDelta = (args: {
  traderDelta: number
  traderLeverage: number
  maxLeverage: number
  userSizeUsd: number
  traderAccountValue: number
}) => {
  if (!(args.traderAccountValue > 0) || !(args.userSizeUsd > 0) || args.traderDelta === 0) {
    return { size: 0, leverage: 1, scale: 0 }
  }
  const traderLev = Math.max(1, Math.round(args.traderLeverage || 1))
  const leverage = Math.max(1, Math.min(traderLev, Math.round(args.maxLeverage || traderLev), 50))
  const scale = args.userSizeUsd / args.traderAccountValue
  const size = args.traderDelta * scale * (leverage / traderLev)
  return { size, leverage, scale }
}

const numMap = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, number>
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const next = Number(raw)
    if (Number.isFinite(next)) out[key] = next
  }
  return out
}

const traderAction = (prev: number, next: number) => {
  if (Math.abs(prev) <= EPS && Math.abs(next) > EPS) return "open"
  if (Math.abs(next) <= EPS) return "close"
  if (Math.sign(prev) !== 0 && Math.sign(next) !== 0 && Math.sign(prev) !== Math.sign(next)) return "close"
  if (Math.abs(next) > Math.abs(prev) + EPS) return "add"
  return "reduce"
}

const ourActionFor = (before: number, after: number) => {
  if (Math.abs(before) <= EPS && Math.abs(after) > EPS) return "open"
  if (Math.abs(after) <= EPS) return "close"
  if (Math.sign(before) !== Math.sign(after)) return "open"
  if (Math.abs(after) > Math.abs(before) + EPS) return "add"
  return "reduce"
}

const clientOf = (privateKey: `0x${string}`) =>
  new ExchangeClient({
    transport: new HttpTransport(),
    wallet: privateKeyToAccount(privateKey),
  })

type OrderResult = { ok: boolean; detail: string; filled: number }

const readOrder = (result: unknown, requested: number): OrderResult => {
  const json = JSON.parse(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value))) as {
    status?: string
    response?: { data?: { statuses?: Array<{ error?: string; filled?: { totalSz?: string } }> }; type?: string } | string
  }
  const response = json.response
  if (typeof response === "string") return { ok: false, detail: response, filled: 0 }
  const status = response?.data?.statuses?.[0]
  if (status?.error) return { ok: false, detail: status.error, filled: 0 }
  const filled = Number(status?.filled?.totalSz ?? requested)
  return { ok: json.status !== "err", detail: "filled", filled: Number.isFinite(filled) ? filled : requested }
}

const place = async (
  client: ReturnType<typeof clientOf>,
  market: MarketRow,
  signedSize: number,
  reduce: boolean,
  leverage: number,
) => {
  const qty = Math.abs(signedSize)
  const sideLong = signedSize > 0
  if (!reduce) {
    await client.updateLeverage({
      asset: market.assetId,
      isCross: !market.onlyIsolated,
      leverage,
    }).catch(() => undefined)
  }
  const rawPx = sideLong ? market.markPx * 1.05 : market.markPx * 0.95
  if (!(market.markPx > 0)) throw new Error("Mark price is unavailable")
  const limitPx = formatPrice(rawPx, market.szDecimals)
  const size = formatSize(qty, market.szDecimals)
  if (!(Number(size) > 0)) throw new Error("Size rounds to zero")
  const result = await client.order({
    orders: [
      {
        a: market.assetId,
        b: sideLong,
        p: limitPx,
        s: size,
        r: reduce,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  })
  return readOrder(result, Number(size))
}

type JoinRow = {
  id: string
  userId: string
  trader: string
  sizeUsd: number
  seen: unknown
  pending: unknown
  copied: unknown
}

const logAction = async (args: {
  joinId: string
  coin: string
  traderAction: string
  ourAction: string
  traderSize: number
  traderAccountValue: number
  scale: number
  ourSize: number
  side: string
  leverage: number
  status: string
  detail: string
}) => {
  if (args.status === "failed" || args.status === "skipped") {
    const recent = await prisma.copyAction.findFirst({
      where: {
        joinId: args.joinId,
        coin: args.coin,
        status: args.status,
        detail: args.detail,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    })
    if (recent) return
  }
  await prisma.copyAction.create({ data: args })
}

const saveJoin = async (id: string, seen: Record<string, number>, pending: Record<string, number>, copied: Record<string, number>) => {
  await prisma.join.update({
    where: { id },
    data: {
      seen: seen as Prisma.InputJsonValue,
      pending: pending as Prisma.InputJsonValue,
      copied: copied as Prisma.InputJsonValue,
    },
  })
}

const syncJoin = async (
  join: JoinRow,
  positions: StockPosition[],
  accountValue: number,
  markets: MarketRow[],
  privateKey: `0x${string}`,
) => {
  const seen = numMap(join.seen)
  const pending = numMap(join.pending)
  const copied = numMap(join.copied)
  const current = new Map(positions.map((position) => [position.coin, position]))
  const coins = new Set([...Object.keys(seen), ...Object.keys(pending), ...current.keys()])
  const client = clientOf(privateKey)
  let changed = false

  for (const coin of coins) {
    const prev = seen[coin] ?? 0
    const next = current.get(coin)?.signedSize ?? 0
    const delta = next - prev
    const queued = (pending[coin] ?? 0) + (Math.abs(delta) > EPS ? delta : 0)
    if (Math.abs(queued) <= EPS) {
      if (Math.abs(pending[coin] ?? 0) > EPS) {
        pending[coin] = 0
        seen[coin] = next
        changed = true
      }
      continue
    }
    const position = current.get(coin)
    const market = markets.find((row) => row.coin === coin)
    const traderLev = position?.leverage ?? market?.maxLeverage ?? 1
    const scaled = scaledDelta({
      traderDelta: queued,
      traderLeverage: traderLev,
      maxLeverage: market?.maxLeverage ?? traderLev,
      userSizeUsd: join.sizeUsd,
      traderAccountValue: accountValue,
    })
    const side = scaled.size >= 0 ? "long" : "short"
    const action = traderAction(prev, next)
    const notional = market ? Math.abs(scaled.size) * market.markPx : 0
    const before = copied[coin] ?? 0
    const target = before + scaled.size
    const flattening = Math.abs(target) <= EPS || Math.abs(next) <= EPS

    if (!(accountValue > 0)) {
      await logAction({
        joinId: join.id,
        coin,
        traderAction: action,
        ourAction: "fail",
        traderSize: queued,
        traderAccountValue: accountValue,
        scale: 0,
        ourSize: 0,
        side,
        leverage: 1,
        status: "failed",
        detail: "Trader account value is empty",
      })
      continue
    }

    if (!market) {
      await logAction({
        joinId: join.id,
        coin,
        traderAction: action,
        ourAction: "fail",
        traderSize: queued,
        traderAccountValue: accountValue,
        scale: scaled.scale,
        ourSize: 0,
        side,
        leverage: scaled.leverage,
        status: "failed",
        detail: "That stock market is not listed",
      })
      continue
    }

    if (!flattening && notional < MIN_NOTIONAL) {
      if (Math.abs(delta) <= EPS) continue
      pending[coin] = queued
      seen[coin] = next
      changed = true
      await logAction({
        joinId: join.id,
        coin,
        traderAction: action,
        ourAction: "skip",
        traderSize: queued,
        traderAccountValue: accountValue,
        scale: scaled.scale,
        ourSize: scaled.size,
        side,
        leverage: scaled.leverage,
        status: "skipped",
        detail: "Under the $10 minimum. It will send when the copied size is large enough.",
      })
      await saveJoin(join.id, seen, pending, copied)
      continue
    }

    const reduce = Math.abs(target) + EPS < Math.abs(before) && (Math.abs(target) <= EPS || Math.sign(target) === Math.sign(before))
    try {
      const sent = await place(client, market, scaled.size, reduce || flattening, scaled.leverage)
      if (!sent.ok) throw new Error(sent.detail || "Order rejected")
      const signedFilled = (scaled.size >= 0 ? 1 : -1) * Math.min(Math.abs(scaled.size), sent.filled || Math.abs(scaled.size))
      copied[coin] = before + signedFilled
      if (Math.abs(copied[coin]) <= EPS) copied[coin] = 0
      pending[coin] = 0
      seen[coin] = next
      changed = true
      await logAction({
        joinId: join.id,
        coin,
        traderAction: action,
        ourAction: ourActionFor(before, copied[coin]),
        traderSize: queued,
        traderAccountValue: accountValue,
        scale: scaled.scale,
        ourSize: signedFilled,
        side: signedFilled >= 0 ? "long" : "short",
        leverage: scaled.leverage,
        status: "placed",
        detail: `${action} copied`,
      })
      await saveJoin(join.id, seen, pending, copied)
    } catch (err) {
      const detail = tradeError(err)
      await logAction({
        joinId: join.id,
        coin,
        traderAction: action,
        ourAction: "fail",
        traderSize: queued,
        traderAccountValue: accountValue,
        scale: scaled.scale,
        ourSize: scaled.size,
        side,
        leverage: scaled.leverage,
        status: "failed",
        detail,
      })
    }
  }

  if (changed) await saveJoin(join.id, seen, pending, copied)
}

let running = false

export const runCopyTick = async () => {
  if (running) return
  running = true
  try {
    const joins = await prisma.join.findMany({ where: { status: "active" } })
    if (!joins.length) return
    const markets = await listMarkets()
    const byTrader = new Map<string, typeof joins>()
    for (const join of joins) {
      const key = join.trader.toLowerCase()
      const list = byTrader.get(key) ?? []
      list.push(join)
      byTrader.set(key, list)
    }
    for (const [trader, group] of byTrader) {
      const stock = await stockStateOf(trader).catch(() => null)
      if (!stock) continue
      const accountValue = stock.accountValue
      for (const join of group) {
        const wallet = await ensureLiveWallet(join.userId)
        await syncJoin(join, stock.positions, accountValue, markets, wallet.privateKey)
      }
    }
  } finally {
    running = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export const startCopyEngine = () => {
  if (timer) return
  const tick = () => {
    void runCopyTick().catch((err) => {
      console.error("copy tick", err instanceof Error ? err.message : "failed")
    })
  }
  tick()
  timer = setInterval(tick, 4000)
}

export const closeCopied = async (joinId: string, userId: string) => {
  const join = await prisma.join.findFirst({ where: { id: joinId, userId } })
  if (!join) throw new Error("Unknown copy")
  const copied = numMap(join.copied)
  const markets = await listMarkets()
  const wallet = await ensureLiveWallet(userId)
  const client = clientOf(wallet.privateKey)
  const stock = await stockStateOf(wallet.address)
  const live = new Map(stock.positions.map((position) => [position.coin, position.signedSize]))
  const errors: string[] = []
  for (const [coin, size] of Object.entries(copied)) {
    if (Math.abs(size) <= EPS) continue
    const market = markets.find((row) => row.coin === coin)
    if (!market) {
      errors.push(`${coin} is not listed`)
      continue
    }
    const liveSize = live.get(coin) ?? 0
    const sameWay = Math.sign(liveSize) === Math.sign(size) || Math.abs(liveSize) <= EPS
    const qty = sameWay ? Math.min(Math.abs(size), Math.abs(liveSize) || Math.abs(size)) : Math.abs(size)
    if (!(qty > 0)) {
      copied[coin] = 0
      continue
    }
    const closing = -Math.sign(size) * qty
    try {
      const sent = await place(client, market, closing, true, Math.min(market.maxLeverage, 5))
      if (!sent.ok) throw new Error(sent.detail || "Close rejected")
      copied[coin] = 0
      await prisma.copyAction.create({
        data: {
          joinId: join.id,
          coin,
          traderAction: "close",
          ourAction: "close",
          traderSize: 0,
          traderAccountValue: 0,
          scale: 0,
          ourSize: closing,
          side: closing > 0 ? "long" : "short",
          leverage: market.maxLeverage,
          status: "placed",
          detail: "Stopped and closed",
        },
      })
    } catch (err) {
      errors.push(tradeError(err instanceof Error ? err.message : "Could not close"))
    }
  }
  if (errors.length) {
    await prisma.join.update({
      where: { id: join.id },
      data: { copied: copied as Prisma.InputJsonValue },
    })
    throw new Error(errors[0] ?? "Could not close")
  }
  await prisma.join.update({
    where: { id: join.id },
    data: {
      status: "stopped",
      stoppedAt: new Date(),
      copied: copied as Prisma.InputJsonValue,
    },
  })
}
