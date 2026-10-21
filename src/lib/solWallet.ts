import { Keypair, Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js"
import bs58 from "bs58"
import { env } from "./env.js"
import { prisma } from "./prisma.js"
import { decryptSecret, encryptSecret } from "./secret.js"

export const solana = () => new Connection(env.solanaRpc, "confirmed")

export const ensureSolWallet = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error("Unknown user")
  if (user.solKeyEnc && user.solAddress) {
    const secret = decryptSecret(user.solKeyEnc)
    const keypair = Keypair.fromSecretKey(bs58.decode(secret))
    if (keypair.publicKey.toBase58() !== user.solAddress) {
      await prisma.user.update({
        where: { id: userId },
        data: { solAddress: keypair.publicKey.toBase58() },
      })
    }
    return { address: keypair.publicKey.toBase58(), keypair }
  }
  const keypair = Keypair.generate()
  const address = keypair.publicKey.toBase58()
  await prisma.user.update({
    where: { id: userId },
    data: {
      solAddress: address,
      solKeyEnc: encryptSecret(bs58.encode(keypair.secretKey)),
    },
  })
  return { address, keypair }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const readSolTransfer = async (txHash: string, to: string, from: string) => {
  const connection = solana()
  let parsed = await connection.getParsedTransaction(txHash, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  })
  for (let i = 0; i < 20 && !parsed; i += 1) {
    await sleep(400)
    parsed = await connection.getParsedTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    })
  }
  if (!parsed) throw new Error("SOL send is not confirmed yet. Wait a second and try again.")
  const instructions = [
    ...parsed.transaction.message.instructions,
    ...(parsed.meta?.innerInstructions ?? []).flatMap((row) => row.instructions),
  ]
  let lamports = 0
  for (const ix of instructions) {
    if (!("parsed" in ix) || !ix.parsed || typeof ix.parsed !== "object") continue
    const body = ix.parsed as { type?: string; info?: { destination?: string; source?: string; lamports?: number } }
    if (body.type !== "transfer") continue
    if (body.info?.destination !== to) continue
    if (body.info?.source !== from) continue
    lamports += Number(body.info.lamports ?? 0)
  }
  if (lamports <= 0) throw new Error("That transaction did not send SOL to your Stockperps trading address.")
  return lamports
}

export const sendSol = async (secret: Keypair, to: string, lamports: number) => {
  const connection = solana()
  const { blockhash } = await connection.getLatestBlockhash("confirmed")
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: secret.publicKey,
      toPubkey: new PublicKey(to),
      lamports,
    }),
  )
  tx.feePayer = secret.publicKey
  tx.recentBlockhash = blockhash
  tx.sign(secret)
  return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
}

export const solBalance = async (address: string) => solana().getBalance(new PublicKey(address), "confirmed")

export const solTxStatus = async (signature: string): Promise<"pending" | "sending" | "landed" | "failed"> => {
  try {
    const res = await solana().getSignatureStatuses([signature], { searchTransactionHistory: true })
    const row = res.value[0]
    if (!row) return "pending"
    if (row.err) return "failed"
    if (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized") return "landed"
    return "sending"
  } catch {
    return "pending"
  }
}
