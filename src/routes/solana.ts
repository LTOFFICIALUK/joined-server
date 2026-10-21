import { Hono } from "hono"
import { env } from "../lib/env.js"
import { readSession } from "../lib/auth.js"

export const solana = new Hono()

solana.get("/blockhash", async (c) => {
  const user = await readSession(c.req.header("authorization")?.replace("Bearer ", ""))
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const res = await fetch(env.solanaRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestBlockhash",
      params: [{ commitment: "confirmed" }],
    }),
  })
  const json = (await res.json()) as {
    error?: { message?: string }
    result?: { value?: { blockhash?: string; lastValidBlockHeight?: number } }
  }
  const blockhash = json.result?.value?.blockhash
  if (!res.ok || json.error || !blockhash) {
    return c.json({ error: json.error?.message || "Could not get a Solana blockhash" }, 502)
  }
  return c.json({
    blockhash,
    lastValidBlockHeight: json.result?.value?.lastValidBlockHeight ?? 0,
  })
})
