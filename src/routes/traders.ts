import { Hono } from "hono"
import { traderBoard, traderByAddress, traderFills } from "../lib/traders.js"

export const traders = new Hono()

const addressOf = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value)

traders.get("/", async (c) => {
  const rows = await traderBoard()
  return c.json({ traders: rows, asOf: Date.now() })
})

traders.get("/:address", async (c) => {
  const address = c.req.param("address")
  if (!addressOf(address)) return c.json({ error: "Unknown trader" }, 400)
  const trader = await traderByAddress(address)
  if (!trader) return c.json({ error: "No open stock positions for this wallet." }, 404)
  const fills = await traderFills(address)
  return c.json({ trader, fills, asOf: Date.now() })
})
