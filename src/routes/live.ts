import { Hono } from "hono"
import { z } from "zod"
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid"
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils"
import { privateKeyToAccount } from "viem/accounts"
import { prisma } from "../lib/prisma.js"
import { readSession } from "../lib/auth.js"
import { tradeError } from "../lib/tradeError.js"
import { getClearinghouse, listMarkets, getDexOpenOrders } from "../lib/hyperliquid.js"
import { ensureLiveWallet } from "../lib/liveWallet.js"
import { creditLive } from "../lib/creditLive.js"
import { ensureSolWallet, readSolTransfer } from "../lib/solWallet.js"
import { creditUsd, houseAccount, houseInventoryUsd, solMarkUsd } from "../lib/house.js"
import { advanceRelayDeposit, advanceWithdraw, withdrawProgress } from "../lib/deposits.js"
import { previewDeposit, previewWithdraw } from "../lib/swapQuote.js"
import { executeRelayWithdraw, indexRelayTx, openRelayDeposit, openRelayWithdraw } from "../lib/relay.js"

export const live = new Hono()

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const clientOf = (privateKey: `0x${string}`) =>
  new ExchangeClient({
    transport: new HttpTransport(),
    wallet: privateKeyToAccount(privateKey),
  })

const MIN_ORDER_USD = 10

const sizeForMinNotional = (size: string, px: string, szDecimals: number) => {
  const price = Number(px)
  let qty = Number(size)
  if (!(qty > 0) || !(price > 0)) return size
  const factor = 10 ** Math.max(0, szDecimals)
  while (qty * price + 1e-9 < MIN_ORDER_USD) {
    qty = (Math.round(qty * factor) + 1) / factor
  }
  return formatSize(qty, szDecimals)
}

live.get("/desk", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const sol = await ensureSolWallet(user.id)
  const [mark, inventoryUsd] = await Promise.all([solMarkUsd(), houseInventoryUsd()])
  return c.json({
    depositAddress: sol.address,
    houseAddress: houseAccount().address,
    solMark: mark,
    inventoryUsd,
    ready: inventoryUsd >= 1,
    minSol: 1 / mark,
  })
})

live.post("/deposit", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z.object({ txHash: z.string().min(32) }).parse(await c.req.json())
  const existing = await prisma.deposit.findFirst({
    where: { userId: user.id, intentId: body.txHash },
  })
  if (existing?.status === "credited") {
    return c.json({ credited: true, amountUsd: Number(asRecord(existing.raw).amountUsd ?? 0) })
  }
  const sol = await ensureSolWallet(user.id)
  const wallet = await ensureLiveWallet(user.id)
  const lamports = await readSolTransfer(body.txHash, sol.address, user.phantomPubkey)
  const mark = await solMarkUsd()
  const amountUsd = Math.floor(((lamports * mark * 0.997) / 1e9) * 100) / 100
  if (amountUsd < 1) {
    throw new Error("Send enough SOL to credit at least 1 USD to Live.")
  }
  await creditUsd(wallet.address as `0x${string}`, amountUsd)
  const packed = { txHash: body.txHash, lamports, mark, amountUsd, depositAddress: sol.address }
  if (existing) {
    await prisma.deposit.update({
      where: { id: existing.id },
      data: { status: "credited", amount: String(lamports), raw: packed },
    })
  } else {
    await prisma.deposit.create({
      data: {
        userId: user.id,
        intentId: body.txHash,
        depositAddress: sol.address,
        originAsset: "sol",
        destAsset: "live",
        amount: String(lamports),
        status: "credited",
        confidential: false,
        raw: packed,
      },
    })
  }
  return c.json({ credited: true, amountUsd, lamports, depositAddress: sol.address })
})

const matchingExitOids = (
  open: Array<{ coin?: string; side?: string; oid?: number; limitPx?: string }>,
  coin: string,
  closeIsBuy: boolean,
  posLong: boolean,
  mark: number,
  wantProfit: boolean,
) =>
  open.flatMap((order) => {
    if (order.coin !== coin || typeof order.oid !== "number") return []
    const isBuy = order.side === "B" || order.side === "Buy"
    if (isBuy !== closeIsBuy) return []
    const px = Number(order.limitPx ?? 0)
    const profit = posLong ? px > mark : px < mark
    if (wantProfit !== profit) return []
    return [order.oid]
  })

live.post("/order", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z
    .object({
      coin: z.string(),
      side: z.enum(["long", "short"]),
      type: z.enum(["market", "limit"]),
      size: z.number().positive(),
      price: z.number().optional(),
      mark: z.number(),
      leverage: z.number().int().min(1).max(50),
      reduce: z.boolean().optional(),
      trigger: z
        .object({
          tpsl: z.enum(["tp", "sl"]),
          isMarket: z.boolean().optional(),
        })
        .optional(),
    })
    .parse(await c.req.json())

  const markets = await listMarkets()
  const market = markets.find((row) => row.coin === body.coin)
  if (!market) return c.json({ error: "Unknown market" }, 400)
  const wallet = await ensureLiveWallet(user.id)
  const client = clientOf(wallet.privateKey)
  if (!body.reduce) {
    const leverage = Math.min(body.leverage, market.maxLeverage)
    await client
      .updateLeverage({
        asset: market.assetId,
        isCross: true,
        leverage,
      })
      .catch(() => undefined)
  }
  const triggerPx = body.price ?? body.mark
  const rawPx = body.trigger?.isMarket
    ? body.side === "long"
      ? triggerPx * 1.05
      : triggerPx * 0.95
    : body.price ?? (body.side === "long" ? body.mark * 1.05 : body.mark * 0.95)
  const limitPx = formatPrice(rawPx, market.szDecimals)
  const size = body.reduce
    ? formatSize(body.size, market.szDecimals)
    : sizeForMinNotional(formatSize(body.size, market.szDecimals), limitPx, market.szDecimals)
  if (body.reduce && (body.trigger || body.type === "limit")) {
    const open = (await getDexOpenOrders(wallet.address).catch(() => [])) as Array<{
      coin?: string
      side?: string
      oid?: number
      limitPx?: string
    }>
    const closeIsBuy = body.side === "long"
    const posLong = body.side === "short"
    const wantProfit = !body.trigger
    const oids = matchingExitOids(open, body.coin, closeIsBuy, posLong, body.mark, wantProfit)
    if (oids.length) {
      await client
        .cancel({
          cancels: oids.map((oid) => ({ a: market.assetId, o: oid })),
        })
        .catch(() => undefined)
    }
  }
  const orderType = body.trigger
    ? {
        trigger: {
          isMarket: body.trigger.isMarket ?? body.trigger.tpsl === "sl",
          triggerPx: formatPrice(triggerPx, market.szDecimals),
          tpsl: body.trigger.tpsl,
        },
      }
    : { limit: { tif: (body.type === "market" ? "Ioc" : "Gtc") as "Ioc" | "Gtc" } }
  try {
    const result = await client.order({
      orders: [
        {
          a: market.assetId,
          b: body.side === "long",
          p: limitPx,
          s: size,
          r: Boolean(body.reduce),
          t: orderType,
        },
      ],
      grouping: body.trigger ? "positionTpsl" : "na",
    })
    return c.json({
      result: JSON.parse(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value))),
      address: wallet.address,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message.trim() : ""
    if (!message || message === "null" || message === "undefined") {
      return c.json({ result: { status: "ok" }, address: wallet.address })
    }
    return c.json({ error: tradeError(message) }, 400)
  }
})

live.post("/cancel", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z
    .object({
      coin: z.string(),
      kind: z.enum(["tp", "sl"]),
      mark: z.number(),
      side: z.enum(["long", "short"]),
    })
    .parse(await c.req.json())
  const markets = await listMarkets()
  const market = markets.find((row) => row.coin === body.coin)
  if (!market) return c.json({ error: "Unknown market" }, 400)
  const wallet = await ensureLiveWallet(user.id)
  const client = clientOf(wallet.privateKey)
  const closeIsBuy = body.side === "short"
  const posLong = body.side === "long"
  const open = (await getDexOpenOrders(wallet.address).catch(() => [])) as Array<{
    coin?: string
    side?: string
    oid?: number
    limitPx?: string
  }>
  const oids = matchingExitOids(open, body.coin, closeIsBuy, posLong, body.mark, body.kind === "tp")
  if (!oids.length) return c.json({ canceled: 0, address: wallet.address })
  await client.cancel({
    cancels: oids.map((oid) => ({ a: market.assetId, o: oid })),
  })
  return c.json({ canceled: oids.length, address: wallet.address })
})

const loadWithdraw = async (id: string) => {
  const row = await prisma.deposit.findUnique({ where: { id } })
  if (!row) throw new Error("Unknown withdrawal")
  const advanced = await advanceWithdraw(row)
  return withdrawProgress({ ...row, raw: advanced.raw }, advanced.status)
}

const withdrawToPhantom = async (user: { id: string; phantomPubkey: string }, amountUsd: number) => {
  const wallet = await ensureLiveWallet(user.id)
  const state = (await getClearinghouse(wallet.address)) as { withdrawable?: string }
  const free = Number(state.withdrawable ?? 0)
  if (!Number.isFinite(free) || amountUsd > free + 0.009) {
    throw new Error("That is more than you can withdraw right now.")
  }
  const opened = await openRelayWithdraw(user.phantomPubkey, wallet.address, amountUsd)
  const baseRaw = {
    kind: "withdraw" as const,
    amountUsd,
    sol: opened.view.receiveSol,
    destination: user.phantomPubkey,
    route: "relay" as const,
    requestId: opened.view.requestId,
    feeUsd: opened.view.feeUsd,
    exchangeFeeUsd: 0,
    message: "SOL is on the way to this Phantom. This usually takes a few seconds.",
  }
  const created = await prisma.deposit.create({
    data: {
      userId: user.id,
      depositAddress: user.phantomPubkey,
      originAsset: "live",
      destAsset: "sol",
      amount: String(Math.round(opened.view.receiveSol * 1e9)),
      status: "reclaiming",
      confidential: false,
      raw: baseRaw,
    },
  })
  try {
    await executeRelayWithdraw(wallet.privateKey, opened.quote)
    await prisma.deposit.update({
      where: { id: created.id },
      data: { status: "sending", raw: baseRaw },
    })
    return loadWithdraw(created.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : "The withdrawal did not finish."
    await prisma.deposit.update({
      where: { id: created.id },
      data: { status: "failed", raw: { ...baseRaw, message } },
    })
    throw new Error(message)
  }
}

live.post("/preview", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z
    .object({
      side: z.enum(["deposit", "withdraw"]),
      sol: z.number().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .parse(await c.req.json())
  const wallet = await ensureLiveWallet(user.id)
  if (body.side === "deposit") {
    if (!body.sol) return c.json({ error: "Enter how much SOL you want to send." }, 400)
    return c.json(await previewDeposit(user.phantomPubkey, wallet.address, body.sol))
  }
  if (!body.usd) return c.json({ error: "Enter how much USD you want to withdraw." }, 400)
  const state = (await getClearinghouse(wallet.address)) as { withdrawable?: string }
  const free = Number(state.withdrawable ?? 0)
  if (Number.isFinite(free) && body.usd > free + 0.009) {
    return c.json({ error: "That is more than you can withdraw right now." }, 400)
  }
  return c.json(await previewWithdraw(user.phantomPubkey, wallet.address, body.usd))
})

live.post("/deposit/open", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z.object({ sol: z.number().positive() }).parse(await c.req.json())
  const wallet = await ensureLiveWallet(user.id)
  const opened = await openRelayDeposit(user.phantomPubkey, wallet.address, body.sol)
  const created = await prisma.deposit.create({
    data: {
      userId: user.id,
      intentId: opened.requestId,
      depositAddress: user.phantomPubkey,
      originAsset: "sol",
      destAsset: "live",
      amount: String(Math.round(opened.sendSol * 1e9)),
      status: "confirming",
      confidential: false,
      raw: {
        kind: "deposit",
        route: "relay",
        requestId: opened.requestId,
        amountUsd: opened.receiveUsd,
        feeUsd: opened.feeUsd,
        sol: opened.sendSol,
        message: "Confirm the SOL send in Phantom.",
      },
    },
  })
  return c.json({
    id: created.id,
    tx: opened.tx,
    feeUsd: opened.feeUsd,
    receiveUsd: opened.receiveUsd,
    seconds: opened.seconds,
  })
})

live.post("/deposit/:id/sent", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z.object({ txHash: z.string().min(32) }).parse(await c.req.json())
  const row = await prisma.deposit.findFirst({ where: { id: c.req.param("id"), userId: user.id } })
  if (!row || asRecord(row.raw).route !== "relay") return c.json({ error: "Unknown deposit" }, 404)
  const current = asRecord(row.raw)
  const requestId = typeof current.requestId === "string" ? current.requestId : ""
  const raw = { ...current, txHash: body.txHash, message: "SOL is on the way. Live is usually ready in a few seconds." }
  await prisma.deposit.update({
    where: { id: row.id },
    data: { status: "bridging", raw },
  })
  if (requestId) await indexRelayTx(body.txHash, requestId)
  return c.json({ id: row.id, stage: "swap" })
})

live.get("/deposit/:id", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const row = await prisma.deposit.findFirst({ where: { id: c.req.param("id"), userId: user.id } })
  if (!row || asRecord(row.raw).route !== "relay") return c.json({ error: "Unknown deposit" }, 404)
  const advanced = await advanceRelayDeposit(row)
  const raw = asRecord(advanced.raw)
  const stage = advanced.status === "credited" ? "done" : advanced.status === "failed" ? "failed" : "swap"
  return c.json({
    id: row.id,
    stage,
    message: typeof raw.message === "string" ? raw.message : "SOL is on the way. Live is usually ready in a few seconds.",
    receiveUsd: Number(raw.amountUsd ?? 0),
  })
})

live.get("/activity", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const rows = await prisma.deposit.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  })
  return c.json({
    activity: rows.map((row) => {
      const raw = asRecord(row.raw)
      const kind = raw.kind === "withdraw" || row.originAsset === "live" ? "withdraw" : "deposit"
      return {
        id: row.id,
        kind,
        status: row.status,
        amountUsd: Number(raw.amountUsd ?? 0),
        sol: Number(raw.sol ?? 0),
        message: typeof raw.message === "string" ? raw.message : "",
        createdAt: row.createdAt,
      }
    }),
  })
})

live.post("/withdraw", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z.object({ amountUsd: z.number().positive() }).parse(await c.req.json())
  return c.json(await withdrawToPhantom(user, body.amountUsd))
})

live.get("/withdraw/:id", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const row = await prisma.deposit.findFirst({
    where: { id: c.req.param("id"), userId: user.id },
  })
  if (!row || asRecord(row.raw).kind !== "withdraw") return c.json({ error: "Unknown withdrawal" }, 404)
  return c.json(await loadWithdraw(row.id))
})

live.post("/return", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const wallet = await ensureLiveWallet(user.id)
  const credit = await creditLive(wallet.privateKey, user.phantomPubkey)
  const state = (await getClearinghouse(wallet.address)) as {
    withdrawable?: string
    marginSummary?: { accountValue?: string }
  }
  const free = Number(state.withdrawable ?? 0)
  if (!Number.isFinite(free) || free < 1) {
    return c.json({
      returned: false,
      withdrawableUsd: free,
      parkedUsdc: credit.parkedUsdc,
      message:
        credit.message ||
        "No free USDC to return yet.",
    })
  }
  const amountUsd = Math.floor(free * 100) / 100
  const sent = await withdrawToPhantom(user, amountUsd)
  return c.json({
    returned: true,
    withdrawableUsd: amountUsd,
    ...sent,
  })
})
