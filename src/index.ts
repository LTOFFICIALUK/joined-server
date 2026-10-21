import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { startCopyEngine } from "./lib/copyEngine.js"
import { env } from "./lib/env.js"
import { account } from "./routes/account.js"
import { auth } from "./routes/auth.js"
import { joins } from "./routes/joins.js"
import { live } from "./routes/live.js"
import { markets } from "./routes/markets.js"
import { solana } from "./routes/solana.js"
import { traders } from "./routes/traders.js"

const app = new Hono()

app.use("*", logger())
const listedOrigins = env.corsOrigin.split(",").map((item) => item.trim()).filter(Boolean)

const allowOrigin = (origin: string): string => {
  if (listedOrigins.includes("*") || listedOrigins.includes(origin)) return origin
  if (
    origin === "https://joined.fun" ||
    origin === "https://www.joined.fun" ||
    origin.endsWith(".vercel.app") ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return origin
  }
  return listedOrigins[0] || origin
}

app.use(
  "*",
  cors({
    origin: (origin) => (origin ? allowOrigin(origin) : "*"),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
)

app.onError((err, c) => {
  console.error(err instanceof Error ? err.message : "Server error")
  const message = err instanceof Error ? err.message.trim() : ""
  return c.json(
    { error: !message || message === "null" || message === "undefined" ? "Server error" : message },
    500,
  )
})

app.get("/health", (c) =>
  c.json({
    ok: true,
    name: "joined",
    hl: true,
  }),
)

app.route("/auth", auth)
app.route("/markets", markets)
app.route("/account", account)
app.route("/live", live)
app.route("/solana", solana)
app.route("/traders", traders)
app.route("/joins", joins)

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`joined server on ${info.port}`)
  startCopyEngine()
})
