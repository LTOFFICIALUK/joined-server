import { Hono } from "hono"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { readSession } from "../lib/auth.js"
import { closeCopied } from "../lib/copyEngine.js"
import { stockStateOf } from "../lib/hyperliquid.js"
import { ensureLiveWallet } from "../lib/liveWallet.js"
import { prisma } from "../lib/prisma.js"
import { accountValueFor, traderByAddress } from "../lib/traders.js"

export const joins = new Hono()

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/)

const numMap = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, number>
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const next = Number(raw)
    if (Number.isFinite(next)) out[key] = next
  }
  return out
}

joins.get("/", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const rows = await prisma.join.findMany({
    where: { userId: user.id, status: "active" },
    orderBy: { createdAt: "desc" },
    include: { actions: { orderBy: { createdAt: "desc" }, take: 12 } },
  })
  const wallet = rows.length ? await ensureLiveWallet(user.id) : null
  const mine = wallet ? await stockStateOf(wallet.address).catch(() => ({ positions: [], accountValue: 0 })) : { positions: [], accountValue: 0 }
  const joinsOut = await Promise.all(rows.map(async (row) => {
    const copied = numMap(row.copied)
    const trader = await traderByAddress(row.trader).catch(() => null)
    const positions = mine.positions
      .filter((position) => Math.abs(copied[position.coin] ?? 0) > 1e-8)
      .map((position) => ({
        coin: position.coin,
        label: position.label,
        side: position.side,
        size: position.size,
        leverage: position.leverage,
        entryPx: position.entryPx,
        positionValue: position.positionValue,
        unrealizedPnl: position.unrealizedPnl,
        copiedSize: Math.abs(copied[position.coin] ?? 0),
      }))
    return {
      id: row.id,
      trader: row.trader,
      sizeUsd: row.sizeUsd,
      createdAt: row.createdAt,
      traderPnl7d: trader?.pnl7d ?? null,
      traderAccountValue: trader?.accountValue ?? null,
      maxLeverage: row.maxLeverage,
      positions,
      actions: row.actions.map((action) => ({
        id: action.id,
        coin: action.coin,
        traderAction: action.traderAction,
        ourAction: action.ourAction,
        ourSize: action.ourSize,
        side: action.side,
        leverage: action.leverage,
        status: action.status,
        detail: action.detail,
        createdAt: action.createdAt,
      })),
    }
  }))
  return c.json({ joins: joinsOut })
})

joins.post("/", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body = z.object({
    trader: addressSchema,
    sizeUsd: z.number().positive(),
    maxLeverage: z.number().int().min(1).max(50).nullable().optional(),
  }).parse(await c.req.json())
  if (body.sizeUsd < 10) return c.json({ error: "Minimum join size is $10." }, 400)
  if (body.sizeUsd > 1_000_000) return c.json({ error: "Maximum join size is $1,000,000." }, 400)
  const trader = body.trader.toLowerCase()
  const profile = await traderByAddress(trader)
  if (!profile) return c.json({ error: "That wallet is not a stock trader on the leaderboard." }, 400)
  const state = await accountValueFor(trader)
  const seen: Record<string, number> = {}
  for (const position of state.positions) seen[position.coin] = position.signedSize
  const existing = await prisma.join.findUnique({ where: { userId_trader: { userId: user.id, trader } } })
  if (existing?.status === "active") return c.json({ error: "You already joined this trader." }, 409)
  await ensureLiveWallet(user.id)
  const saved = existing
    ? await prisma.join.update({
      where: { id: existing.id },
      data: {
        sizeUsd: body.sizeUsd,
        maxLeverage: body.maxLeverage ?? null,
        status: "active",
        seen: seen as Prisma.InputJsonValue,
        pending: {},
        copied: {},
        stoppedAt: null,
      },
    })
    : await prisma.join.create({
      data: {
        userId: user.id,
        trader,
        sizeUsd: body.sizeUsd,
        maxLeverage: body.maxLeverage ?? null,
        seen: seen as Prisma.InputJsonValue,
        pending: {},
        copied: {},
      },
    })
  return c.json({ id: saved.id, trader: saved.trader, sizeUsd: saved.sizeUsd, maxLeverage: saved.maxLeverage, status: saved.status })
})

joins.post("/:id/stop", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const row = await prisma.join.findFirst({ where: { id: c.req.param("id"), userId: user.id } })
  if (!row) return c.json({ error: "Unknown copy" }, 404)
  const saved = await prisma.join.update({
    where: { id: row.id },
    data: { status: "stopped", stoppedAt: new Date() },
  })
  return c.json({ id: saved.id, status: saved.status })
})

joins.post("/:id/close", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  try {
    await closeCopied(c.req.param("id"), user.id)
    return c.json({ id: c.req.param("id"), status: "stopped" })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not close"
    const status = message === "Unknown copy" ? 404 : 400
    return c.json({ error: message }, status)
  }
})
