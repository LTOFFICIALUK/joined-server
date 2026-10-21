import { Hono } from "hono"
import { listMarkets } from "../lib/hyperliquid.js"

export const markets = new Hono()

markets.get("/", async (c) => {
  const rows = await listMarkets()
  return c.json({ markets: rows })
})
