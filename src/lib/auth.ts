import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { prisma } from "./prisma.js"
import { env } from "./env.js"

const SESSION_MS = 1000 * 60 * 60 * 24 * 14

export const makeNonce = () => randomBytes(24).toString("hex")

export const hashToken = (token: string) =>
  createHash("sha256").update(`${env.sessionSecret}:${token}`).digest("hex")

export const signSession = () => randomBytes(32).toString("hex")

export const verifyPhantom = (pubkey: string, message: string, signature: string) => {
  const publicKey = bs58.decode(pubkey)
  const sig = Buffer.from(signature, "base64")
  const msg = new TextEncoder().encode(message)
  return nacl.sign.detached.verify(msg, sig, publicKey)
}

export const issueSession = async (userId: string) => {
  const token = signSession()
  await prisma.session.create({
    data: {
      token: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_MS),
    },
  })
  return token
}

export const readSession = async (token: string | undefined) => {
  if (!token) return null
  const row = await prisma.session.findUnique({
    where: { token: hashToken(token) },
    include: { user: true },
  })
  if (!row || row.expiresAt.getTime() < Date.now()) return null
  return row.user
}

export const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
