import { Hono } from "hono"
import { joinersFor, siteStats, stockMarket, stockMarkets, traderBoard, traderByAddress, traderFills, traderTape } from "../lib/traders.js"

export const traders = new Hono()

const addressOf = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value)

const remember = (c: { header: (name: string, value: string) => void }) => {
  c.header("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=120")
}

traders.get("/", async (c) => {
  const rows = await traderBoard()
  remember(c)
  return c.json({ traders: rows, asOf: Date.now() })
})

traders.get("/tape", async (c) => {
  const rows = await traderTape()
  remember(c)
  return c.json({ tape: rows, asOf: Date.now() })
})

traders.get("/markets", async (c) => {
  const rows = await stockMarkets()
  remember(c)
  return c.json({ markets: rows, asOf: Date.now() })
})

traders.get("/markets/:ticker", async (c) => {
  const market = await stockMarket(c.req.param("ticker"))
  if (!market) return c.json({ error: "No top wallet holds that market." }, 404)
  remember(c)
  return c.json({ market, asOf: Date.now() })
})

traders.get("/stats", async (c) => {
  remember(c)
  return c.json({ stats: await siteStats(), asOf: Date.now() })
})

traders.get("/:address/joiners", async (c) => {
  const address = c.req.param("address")
  if (!addressOf(address)) return c.json({ error: "Unknown trader" }, 400)
  return c.json({ joiners: await joinersFor(address) })
})

traders.get("/:address", async (c) => {
  const address = c.req.param("address")
  if (!addressOf(address)) return c.json({ error: "Unknown trader" }, 400)
  const trader = await traderByAddress(address)
  if (!trader) return c.json({ error: "No open stock positions for this wallet." }, 404)
  const fills = await traderFills(address)
  remember(c)
  return c.json({ trader, fills, asOf: Date.now() })
})
