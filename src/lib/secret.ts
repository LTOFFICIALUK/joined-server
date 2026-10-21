import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { env } from "./env.js"

const key = scryptSync(env.sessionSecret, "joined-hl-wallet", 32)

export const encryptSecret = (plain: string) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const packed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${tag.toString("hex")}:${packed.toString("hex")}`
}

export const decryptSecret = (blob: string) => {
  const [ivHex, tagHex, dataHex] = blob.split(":")
  if (!ivHex || !tagHex || !dataHex) throw new Error("Secret is unreadable")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"))
  decipher.setAuthTag(Buffer.from(tagHex, "hex"))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8")
}
