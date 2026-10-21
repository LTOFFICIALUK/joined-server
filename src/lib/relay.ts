import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid"
import bs58 from "bs58"
import { privateKeyToAccount } from "viem/accounts"
import { env } from "./env.js"

const RELAY = "https://api.relay.link"
const SOLANA_CHAIN_ID = 792703809
const HL_CHAIN_ID = 1337
const NATIVE_SOL = "11111111111111111111111111111111"
const PERP_USDC = "0x00000000000000000000000000000000"

export type RelayQuoteView = {
  feeUsd: number
  receiveUsd: number
  receiveSol: number
  seconds: number
  sendSol: number
  sendUsd: number
  requestId: string
}

export type RelayFill = {
  status: string
  txHash: string
  inTxHash: string
}

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const num = (value: unknown) => {
  const next = Number(value)
  return Number.isFinite(next) ? next : 0
}

const cents = (value: number) => Math.round(value * 100) / 100

const relayError = (body: unknown) => {
  const message = String(asRecord(body).message || asRecord(body).error || "")
  if (/too low|minimum|min amount/i.test(message)) return "That amount is too small."
  if (/insufficient|balance/i.test(message)) return "That is more than you can move right now."
  if (/too large|1232/i.test(message)) return "That SOL amount needs a slightly different size. Try again."
  return "Could not open that transfer right now."
}

const postQuote = async (body: Record<string, unknown>) => {
  const res = await fetch(`${RELAY}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as unknown
  if (!res.ok) throw new Error(relayError(json))
  return asRecord(json)
}

const viewOf = (quote: Record<string, unknown>, side: "deposit" | "withdraw"): RelayQuoteView => {
  const details = asRecord(quote.details)
  const currencyIn = asRecord(details.currencyIn)
  const currencyOut = asRecord(details.currencyOut)
  const impact = Math.abs(num(asRecord(details.totalImpact).usd))
  const relayer = num(asRecord(asRecord(quote.fees).relayer).amountUsd)
  const steps = Array.isArray(quote.steps) ? quote.steps : []
  const requestId = String(asRecord(steps[0]).requestId || "")
  if (!requestId) throw new Error("Could not open that transfer right now.")
  return {
    feeUsd: cents(impact || relayer),
    receiveUsd: side === "deposit" ? num(currencyOut.amountFormatted) || num(currencyOut.amountUsd) : 0,
    receiveSol: side === "withdraw" ? num(currencyOut.amountFormatted) : 0,
    seconds: Math.max(2, Math.round(num(details.timeEstimate) || 2)),
    sendSol: side === "deposit" ? num(currencyIn.amountFormatted) : 0,
    sendUsd: side === "withdraw" ? num(currencyIn.amountFormatted) : 0,
    requestId,
  }
}

export const previewRelayDeposit = async (phantom: string, trading: string, sol: number) => {
  if (!Number.isFinite(sol) || sol <= 0) throw new Error("Enter how much SOL you want to send.")
  const quote = await postQuote({
    user: phantom,
    recipient: trading,
    refundTo: phantom,
    originChainId: SOLANA_CHAIN_ID,
    destinationChainId: HL_CHAIN_ID,
    originCurrency: NATIVE_SOL,
    destinationCurrency: PERP_USDC,
    tradeType: "EXACT_INPUT",
    amount: String(Math.round(sol * 1e9)),
  })
  return viewOf(quote, "deposit")
}

export const previewRelayWithdraw = async (phantom: string, trading: string, usd: number) => {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("Enter how much USD you want to withdraw.")
  const quote = await postQuote({
    user: trading,
    recipient: phantom,
    refundTo: trading,
    originChainId: HL_CHAIN_ID,
    destinationChainId: SOLANA_CHAIN_ID,
    originCurrency: PERP_USDC,
    destinationCurrency: NATIVE_SOL,
    tradeType: "EXACT_INPUT",
    amount: String(Math.round(usd * 1e8)),
    protocolVersion: "v2",
  })
  return viewOf(quote, "withdraw")
}

const instructionData = (data: string) => {
  if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) return Buffer.from(data, "hex")
  return Buffer.from(bs58.decode(data))
}

const solanaTx = async (quote: Record<string, unknown>, phantom: string) => {
  const steps = Array.isArray(quote.steps) ? quote.steps : []
  const deposit = steps.map(asRecord).find((step) => step.id === "deposit") || asRecord(steps[0])
  const item = asRecord((Array.isArray(deposit.items) ? deposit.items : [])[0])
  const data = asRecord(item.data)
  const instructions = Array.isArray(data.instructions) ? data.instructions.map(asRecord) : []
  if (!instructions.length) throw new Error("Could not prepare the SOL transfer.")
  const compiled = instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(String(ix.programId)),
        keys: (Array.isArray(ix.keys) ? ix.keys : []).map((key) => {
          const account = asRecord(key)
          return {
            pubkey: new PublicKey(String(account.pubkey)),
            isSigner: Boolean(account.isSigner),
            isWritable: Boolean(account.isWritable),
          }
        }),
        data: instructionData(String(ix.data || "")),
      }),
  )
  const connection = new Connection(env.solanaRpc, "confirmed")
  const lookups: AddressLookupTableAccount[] = []
  for (const address of Array.isArray(data.addressLookupTableAddresses) ? data.addressLookupTableAddresses : []) {
    const found = await connection.getAddressLookupTable(new PublicKey(String(address)))
    if (!found.value) throw new Error("Could not prepare the SOL transfer.")
    lookups.push(found.value)
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed")
  const message = new TransactionMessage({
    payerKey: new PublicKey(phantom),
    recentBlockhash: blockhash,
    instructions: compiled,
  }).compileToV0Message(lookups)
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64")
}

export const openRelayDeposit = async (phantom: string, trading: string, sol: number) => {
  const quote = await postQuote({
    user: phantom,
    recipient: trading,
    refundTo: phantom,
    originChainId: SOLANA_CHAIN_ID,
    destinationChainId: HL_CHAIN_ID,
    originCurrency: NATIVE_SOL,
    destinationCurrency: PERP_USDC,
    tradeType: "EXACT_INPUT",
    amount: String(Math.round(sol * 1e9)),
  })
  const view = viewOf(quote, "deposit")
  const tx = await solanaTx(quote, phantom)
  return { ...view, tx }
}

const stepData = (quote: Record<string, unknown>, id: string) => {
  const steps = Array.isArray(quote.steps) ? quote.steps.map(asRecord) : []
  const step = steps.find((item) => item.id === id)
  const first = asRecord((Array.isArray(step?.items) ? step.items : [])[0])
  return asRecord(first.data)
}

const authorizeRelay = async (privateKey: `0x${string}`, quote: Record<string, unknown>) => {
  const data = stepData(quote, "authorize")
  const sign = asRecord(data.sign)
  const post = asRecord(data.post)
  const domain = asRecord(sign.domain)
  const types = asRecord(sign.types) as Record<string, Array<{ name: string; type: string }>>
  const primaryType = String(sign.primaryType || "NonceMapping")
  const value = { ...asRecord(sign.value) }
  for (const field of types[primaryType] || []) {
    if (field.type.startsWith("uint") && (typeof value[field.name] === "number" || typeof value[field.name] === "string")) {
      value[field.name] = BigInt(value[field.name] as string | number)
    }
  }
  const account = privateKeyToAccount(privateKey)
  const signature = await account.signTypedData({
    domain: {
      name: String(domain.name),
      version: String(domain.version),
      chainId: Number(domain.chainId),
      verifyingContract: String(domain.verifyingContract) as `0x${string}`,
    },
    types,
    primaryType,
    message: value,
  })
  const endpoint = String(post.endpoint || "/authorize")
  const url = new URL(endpoint, RELAY)
  url.searchParams.set("signature", signature)
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(asRecord(post.body)),
  })
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as unknown
    console.error("relay authorize", res.status, asRecord(json).message || "")
    throw new Error(relayError(json))
  }
}

export const executeRelayWithdraw = async (privateKey: `0x${string}`, quote: Record<string, unknown>) => {
  await authorizeRelay(privateKey, quote)
  const data = stepData(quote, "deposit")
  const action = asRecord(asRecord(data.action).parameters)
  const nonce = num(data.nonce || action.nonce)
  if (!nonce) throw new Error("Could not open that transfer right now.")
  const client = new ExchangeClient({
    transport: new HttpTransport(),
    wallet: privateKeyToAccount(privateKey),
    nonceManager: () => nonce,
  })
  await client.sendAsset({
    destination: String(action.destination) as `0x${string}`,
    sourceDex: String(action.sourceDex ?? ""),
    destinationDex: String(action.destinationDex ?? ""),
    token: String(action.token),
    amount: String(action.amount),
    fromSubAccount: (String(action.fromSubAccount || "") || "") as "" | `0x${string}`,
  })
}

export const openRelayWithdraw = async (phantom: string, trading: string, usd: number) => {
  const quote = await postQuote({
    user: trading,
    recipient: phantom,
    refundTo: trading,
    originChainId: HL_CHAIN_ID,
    destinationChainId: SOLANA_CHAIN_ID,
    originCurrency: PERP_USDC,
    destinationCurrency: NATIVE_SOL,
    tradeType: "EXACT_INPUT",
    amount: String(Math.round(usd * 1e8)),
    protocolVersion: "v2",
  })
  return { view: viewOf(quote, "withdraw"), quote }
}

export const indexRelayTx = async (txHash: string, requestId: string) => {
  await fetch(`${RELAY}/transactions/index`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: String(SOLANA_CHAIN_ID), txHash, requestId }),
  }).catch(() => undefined)
}

export const relayFill = async (requestId: string): Promise<RelayFill> => {
  const res = await fetch(`${RELAY}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`)
  const json = asRecord(await res.json().catch(() => ({})))
  const txHashes = Array.isArray(json.txHashes) ? json.txHashes : []
  const inTxHashes = Array.isArray(json.inTxHashes) ? json.inTxHashes : []
  return {
    status: String(json.status || "").toLowerCase(),
    txHash: String(txHashes[0] || ""),
    inTxHash: String(inTxHashes[0] || ""),
  }
}
