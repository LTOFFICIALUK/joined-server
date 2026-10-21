import { Hono } from "hono"
import { z } from "zod"
import { prisma } from "../lib/prisma.js"
import { issueSession, makeNonce, readSession, verifyPhantom } from "../lib/auth.js"

export const auth = new Hono()

const loginMessage = (nonce: string) => `joined login\n${nonce}\nSign this to copy a trader.`

auth.get("/nonce", async (c) => {
  const pubkey = c.req.query("pubkey")
  if (!pubkey) return c.json({ error: "Missing pubkey" }, 400)
  const nonce = makeNonce()
  await prisma.authNonce.create({
    data: {
      pubkey,
      nonce,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  })
  return c.json({ nonce, message: loginMessage(nonce) })
})

const verifySchema = z.object({
  pubkey: z.string(),
  nonce: z.string(),
  signature: z.string(),
  evmAddress: z.string().optional(),
})

auth.post("/verify", async (c) => {
  const body = verifySchema.parse(await c.req.json())
  const row = await prisma.authNonce.findUnique({ where: { nonce: body.nonce } })
  if (!row || row.pubkey !== body.pubkey || row.expiresAt.getTime() < Date.now()) {
    return c.json({ error: "Nonce expired" }, 401)
  }
  if (!verifyPhantom(body.pubkey, loginMessage(body.nonce), body.signature)) {
    return c.json({ error: "Could not complete the connection. Refresh the page and try again." }, 401)
  }
  await prisma.authNonce.delete({ where: { nonce: body.nonce } })
  const user = await prisma.user.upsert({
    where: { phantomPubkey: body.pubkey },
    update: {},
    create: { phantomPubkey: body.pubkey },
  })
  const token = await issueSession(user.id)
  return c.json({
    token,
    user: {
      id: user.id,
      phantomPubkey: user.phantomPubkey,
      evmAddress: user.evmAddress,
    },
  })
})

auth.get("/me", async (c) => {
  const token = c.req.header("authorization")?.replace("Bearer ", "")
  const user = await readSession(token)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  return c.json({
    id: user.id,
    phantomPubkey: user.phantomPubkey,
    evmAddress: user.evmAddress,
  })
})
