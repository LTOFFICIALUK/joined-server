import { Hono } from "hono"
import { readSession } from "../lib/auth.js"
import { creditLive } from "../lib/creditLive.js"
import { getClearinghouse, getStockBooks } from "../lib/hyperliquid.js"
import { ensureLiveWallet } from "../lib/liveWallet.js"

export const account = new Hono()

account.get("/live", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const wallet = await ensureLiveWallet(user.id)
  const address = wallet.address
  const credit = await creditLive(wallet.privateKey, user.phantomPubkey)
  const [cash, books] = await Promise.all([
    getClearinghouse(address),
    getStockBooks(address),
  ])
  const cashState = (cash ?? {}) as { assetPositions?: unknown }
  return c.json({
    address,
    state: { ...cashState, assetPositions: books.assetPositions },
    orders: books.orders,
    fills: books.fills,
    parkedUsdc: credit.parkedUsdc,
    creditMessage: credit.message,
    gasAddress: credit.gasAddress,
    credited: credit.credited,
  })
})
