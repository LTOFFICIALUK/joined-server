import { env } from "./env.js"
import { creditLive, usdcBalance } from "./creditLive.js"
import { hlInfo } from "./hyperliquid.js"
import { getStatus, submitDeposit } from "./intents.js"
import { ensureLiveWallet } from "./liveWallet.js"
import { prisma } from "./prisma.js"
import { relayFill } from "./relay.js"
import { solTxStatus } from "./solWallet.js"

export const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const pickStatus = (live: unknown) => {
  if (typeof live === "string") return live
  const rec = asRecord(live)
  const raw = rec.status ?? rec.swapStatus ?? rec.state
  if (typeof raw === "string") return raw
  const inner = asRecord(raw).status
  return typeof inner === "string" ? inner : ""
}

export const pickRefundTo = (raw: unknown, fallback: string) => {
  const rec = asRecord(raw)
  const quote = asRecord(rec.quoteResponse ?? rec.quote)
  const value = rec.refundTo ?? quote.refundTo
  return typeof value === "string" && value ? value : fallback
}

export const pickRecipient = (raw: unknown, fallback: string) => {
  const rec = asRecord(raw)
  const quote = asRecord(rec.quoteResponse ?? rec.quote)
  const value = rec.recipient ?? quote.recipient
  return typeof value === "string" && value ? value : fallback
}

const hashFrom = (value: unknown) => {
  if (typeof value === "string" && value) return value
  const hash = asRecord(value).hash ?? asRecord(value).txHash
  return typeof hash === "string" && hash ? hash : ""
}

export const pickChainTx = (raw: unknown, key: "originChainTxHashes" | "destinationChainTxHashes") => {
  const rec = asRecord(raw)
  const details = asRecord(rec.swapDetails)
  for (const list of [rec[key], details[key]]) {
    if (!Array.isArray(list) || !list.length) continue
    const hash = hashFrom(list[0])
    if (hash) return hash
  }
  return ""
}

export const pickTxHash = (raw: unknown, extra?: string) => {
  if (extra) return extra
  const rec = asRecord(raw)
  if (typeof rec.txHash === "string" && rec.txHash) return rec.txHash
  return pickChainTx(raw, "originChainTxHashes")
}

export type WithdrawStage = "taking" | "sending" | "waiting" | "landed" | "failed" | "refunding"

export type WithdrawProgress = {
  id: string
  stage: WithdrawStage
  instant: boolean
  amountUsd: number
  sol: number
  txHash: string
  destination: string
  message: string
}

const isWithdrawRow = (row: { originAsset: string; destAsset: string; raw: unknown }) =>
  asRecord(row.raw).kind === "withdraw" || (row.originAsset === "live" && row.destAsset === "sol")

const stageFor = (status: string, route: string): WithdrawStage => {
  if (status === "failed") return "failed"
  if (status === "returned" || status === "refunding") return "refunding"
  if (status === "landed" || status === "credited") return "landed"
  if (status === "reclaiming") return "taking"
  if (status === "bridging" || (route === "bridge" && status !== "sending")) return "waiting"
  return "sending"
}

const messageFor = (stage: WithdrawStage, raw: Record<string, unknown>) => {
  const stored = typeof raw.message === "string" ? raw.message.trim() : ""
  if (stage === "failed") return stored || "The withdrawal did not finish."
  if (stage === "refunding") return stored || "This USD is returning to Live."
  if (stage === "landed") return "SOL is in this Phantom."
  if (raw.route === "relay") return "SOL is on the way to this Phantom. This usually takes a few seconds."
  return "SOL is on the way to this Phantom. This usually takes about 5 minutes."
}

export const withdrawProgress = (
  row: { id: string; amount: string; depositAddress: string | null; raw: unknown },
  status: string,
): WithdrawProgress => {
  const raw = asRecord(row.raw)
  const route = raw.route === "relay" ? "relay" : raw.route === "bridge" ? "bridge" : "sol"
  const stage = stageFor(status, route)
  const usd = Number(raw.amountUsd)
  const lamports = Number(row.amount)
  const sol = Number(raw.sol)
  const txHash = typeof raw.txHash === "string" ? raw.txHash : ""
  return {
    id: row.id,
    stage,
    instant: route === "sol" || route === "relay",
    amountUsd: Number.isFinite(usd) ? usd : 0,
    sol: Number.isFinite(sol) && sol > 0 ? sol : Number.isFinite(lamports) ? lamports / 1e9 : 0,
    txHash,
    destination: typeof raw.destination === "string" ? raw.destination : row.depositAddress ?? "",
    message: messageFor(stage, raw),
  }
}

const saveWithdraw = async (
  id: string,
  status: string,
  raw: Record<string, unknown>,
) => {
  await prisma.deposit.update({
    where: { id },
    data: { status, raw: raw as object },
  })
}

const recoverShortWithdrawal = async (userId: string | undefined, since: number) => {
  if (!userId) return "waiting" as const
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return "waiting" as const
  const wallet = await ensureLiveWallet(user.id)
  const parked = await usdcBalance(wallet.address)
  if (parked >= 5_000_000n) {
    const credit = await creditLive(wallet.privateKey, user.phantomPubkey)
    return credit.credited ? ("bridging" as const) : ("waiting" as const)
  }
  const ledger = (await hlInfo({ type: "userNonFundingLedgerUpdates", user: wallet.address }).catch(() => [])) as Array<{
    time?: number
    delta?: { type?: string }
  }>
  const cameBack = ledger.some((item) => item.delta?.type === "deposit" && Number(item.time) > since)
  return cameBack ? ("back" as const) : ("waiting" as const)
}

export const advanceRelayDeposit = async (row: {
  id: string
  status: string
  createdAt: Date
  raw: unknown
}) => {
  let status = row.status
  let raw = asRecord(row.raw)
  if (raw.route !== "relay" || raw.kind === "withdraw") return { status, raw }
  if (status === "credited" || status === "failed") return { status, raw }
  const requestId = typeof raw.requestId === "string" ? raw.requestId : ""
  const age = Date.now() - row.createdAt.getTime()
  if (!requestId || status === "confirming") {
    if (age > 10 * 60 * 1000) {
      status = "failed"
      raw = { ...raw, message: "Phantom did not send this deposit." }
      await saveWithdraw(row.id, status, raw)
    }
    return { status, raw }
  }
  try {
    const fill = await relayFill(requestId)
    if (fill.status === "success") {
      status = "credited"
      raw = { ...raw, txHash: fill.txHash || fill.inTxHash, message: "Live is ready." }
    } else if (fill.status === "failure" || fill.status === "refund") {
      status = "failed"
      raw = { ...raw, message: "The deposit did not finish. SOL returns to Phantom if it was sent." }
    } else if (age > 10 * 60 * 1000) {
      status = "failed"
      raw = { ...raw, message: "The deposit did not finish. SOL returns to Phantom if it was sent." }
    } else {
      status = "bridging"
    }
  } catch {
    undefined
  }
  if (status !== row.status || JSON.stringify(raw) !== JSON.stringify(asRecord(row.raw))) {
    await saveWithdraw(row.id, status, raw)
  }
  return { status, raw }
}

export const advanceWithdraw = async (row: {
  id: string
  status: string
  depositAddress: string | null
  confidential: boolean
  originAsset: string
  destAsset: string
  createdAt: Date
  raw: unknown
  userId?: string
}) => {
  if (!isWithdrawRow(row)) return { status: row.status, raw: row.raw }
  let status = row.status
  let raw = asRecord(row.raw)
  if (status === "credited" || status === "returned") return { status, raw }
  const route = raw.route === "relay" ? "relay" : raw.route === "bridge" ? "bridge" : "sol"
  const retryRefund = status === "failed" && route === "bridge" && raw.recovered !== true
  if ((status === "landed" || status === "failed") && !retryRefund) return { status, raw }
  const txHash = typeof raw.txHash === "string" ? raw.txHash : ""
  const age = Date.now() - row.createdAt.getTime()

  if (route === "sol") {
    if (!txHash) {
      if (age > 120_000) {
        status = "failed"
        raw = { ...raw, message: "Withdrawal stopped before SOL was sent." }
        await saveWithdraw(row.id, status, raw)
      }
      return { status, raw }
    }
    const chain = await solTxStatus(txHash)
    const next = chain === "landed" ? "landed" : chain === "failed" ? "failed" : "sending"
    if (next !== status) {
      status = next
      if (next === "failed") raw = { ...raw, message: "The SOL transfer failed." }
      if (next === "landed") raw = { ...raw, message: "SOL is in Phantom." }
      await saveWithdraw(row.id, status, raw)
    }
    return { status, raw }
  }

  if (route === "relay") {
    const requestId = typeof raw.requestId === "string" ? raw.requestId : ""
    if (!requestId) {
      if (age > 120_000) {
        status = "failed"
        raw = { ...raw, message: "The withdrawal did not finish." }
        await saveWithdraw(row.id, status, raw)
      }
      return { status, raw }
    }
    try {
      const fill = await relayFill(requestId)
      if (fill.txHash) raw = { ...raw, txHash: fill.txHash }
      if (fill.status === "success") {
        status = "landed"
        raw = { ...raw, message: "SOL is in this Phantom." }
      } else if (fill.status === "failure" || fill.status === "refund") {
        status = "refunding"
        raw = { ...raw, message: "SOL did not arrive. The USD returns to Live." }
      } else if (age > 10 * 60 * 1000) {
        status = "refunding"
        raw = { ...raw, message: "SOL is still on the way to this Phantom." }
      } else {
        status = "sending"
      }
    } catch {
      undefined
    }
    if (status !== row.status || JSON.stringify(raw) !== JSON.stringify(asRecord(row.raw))) {
      await saveWithdraw(row.id, status, raw)
    }
    return { status, raw }
  }

  if (!row.depositAddress) {
    status = "failed"
    raw = { ...raw, message: "No route back to Phantom was opened." }
    await saveWithdraw(row.id, status, raw)
    return { status, raw }
  }

  try {
    const live = await getStatus(
      `depositAddress=${encodeURIComponent(row.depositAddress)}`,
      row.confidential,
    )
    const reported = pickStatus(live).toUpperCase()
    const destTx = pickChainTx(live, "destinationChainTxHashes") || pickChainTx(raw, "destinationChainTxHashes")
    raw = { ...raw, ...asRecord(live), route: "bridge", txHash: destTx || txHash }
    if (/INCOMPLETE|REFUND|PARTIAL/.test(reported)) {
      const recovered = await recoverShortWithdrawal(row.userId, row.createdAt.getTime()).catch(() => "waiting" as const)
      status = recovered === "waiting" ? "refunding" : "returned"
      raw = {
        ...raw,
        recovered: recovered !== "waiting",
        message:
          recovered === "back"
            ? "This USD is back on Live."
            : recovered === "bridging"
              ? "This USD is returning to Live. It should show in about a minute."
              : "This USD is returning to Live.",
      }
    } else if (/FAIL|ERROR/.test(reported)) {
      status = "failed"
      raw = { ...raw, message: "The withdrawal did not finish." }
    } else if (destTx && !destTx.startsWith("0x")) {
      const chain = await solTxStatus(destTx)
      status = chain === "landed" ? "landed" : chain === "failed" ? "failed" : "sending"
      if (status === "landed") raw = { ...raw, message: "SOL is in Phantom." }
      if (status === "failed") raw = { ...raw, message: "The SOL transfer failed." }
    } else if (/SUCCESS|COMPLETED|SETTLED/.test(reported)) {
      status = "landed"
      raw = { ...raw, message: "SOL is in Phantom." }
    } else if (age > 30 * 60 * 1000) {
      status = "failed"
      raw = { ...raw, message: "SOL did not reach Phantom. The bridge timed out." }
    } else {
      status = "bridging"
    }
  } catch {
    if (age > 30 * 60 * 1000) {
      status = "failed"
      raw = { ...raw, message: "SOL did not reach Phantom. The bridge timed out." }
    }
  }
  if (status !== row.status || JSON.stringify(raw) !== JSON.stringify(asRecord(row.raw))) {
    await saveWithdraw(row.id, status, raw)
  }
  return { status, raw }
}

export const solLamports = async (address: string) => {
  try {
    const res = await fetch(env.solanaRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address, { commitment: "confirmed" }],
      }),
    })
    const json = (await res.json()) as { result?: { value?: number } }
    return Number(json.result?.value ?? 0)
  } catch {
    return 0
  }
}

export const labelStatus = (
  status: string,
  ctx?: { parkedUsdc?: number; liveUsd?: number },
) => {
  const value = status.toUpperCase()
  if (/SUCCESS|COMPLETED|SETTLED/.test(value)) {
    if ((ctx?.parkedUsdc ?? 0) > 0) return "Parked"
    if ((ctx?.liveUsd ?? 0) > 0) return "Live"
    return "Crediting"
  }
  if (/REFUND/.test(value)) return "Refunded"
  if (/FAIL|ERROR/.test(value)) return "Failed"
  if (/INCOMPLETE/.test(value)) return "Incomplete"
  if (/CREDIT|LIVE/.test(value)) return "Live"
  if (/SUBMIT|PENDING|PROCESS|KNOWN/.test(value)) return "Sent"
  if (/QUOTE/.test(value)) return "Quoted"
  return status || "Pending"
}

export const refreshDeposit = async (
  row: {
    id: string
    status: string
    depositAddress: string | null
    confidential: boolean
    originAsset: string
    destAsset: string
    amount: string
    createdAt: Date
    raw: unknown
    userId?: string
  },
  phantomPubkey: string,
  tradingAddress: string,
  nudge = false,
  ctx?: { parkedUsdc?: number; liveUsd?: number; creditMessage?: string },
) => {
  let status = row.status
  let raw = row.raw
  const house = row.destAsset === "live" || row.originAsset === "live"
  if (!house && row.depositAddress && row.destAsset !== "live" && row.originAsset !== "sol") {
    try {
      const live = await getStatus(
        `depositAddress=${encodeURIComponent(row.depositAddress)}`,
        row.confidential,
      )
      const next = pickStatus(live)
      const txHash = pickTxHash(raw) || pickTxHash(live)
      if (nudge && txHash && row.depositAddress && !/SUCCESS|REFUNDED|FAILED/i.test(next || status)) {
        try {
          await submitDeposit(
            { txHash, depositAddress: row.depositAddress },
            row.confidential,
          )
        } catch {
          undefined
        }
      }
      if (next) status = next
      raw = { ...asRecord(raw), ...asRecord(live), txHash }
      await prisma.deposit.update({
        where: { id: row.id },
        data: { status, raw: raw as object },
      })
    } catch {
      undefined
    }
  }
  if (asRecord(raw).route === "relay" && !isWithdrawRow({ ...row, raw })) {
    const advanced = await advanceRelayDeposit({ ...row, status, raw })
    status = advanced.status
    raw = advanced.raw
  }
  if (isWithdrawRow({ ...row, raw })) {
    const advanced = await advanceWithdraw({ ...row, status, raw, userId: row.userId })
    status = advanced.status
    raw = advanced.raw
  }
  const solIn = house ? row.originAsset === "sol" : /sol/i.test(row.originAsset)
  const withdraw = isWithdrawRow({ ...row, raw })
  const progress = withdraw ? withdrawProgress({ ...row, amount: row.amount, raw }, status) : null
  const packed = asRecord(raw)
  const amountNum = Number(row.amount)
  const usd = Number(packed.amountUsd)
  const solLabel = `${(Number.isFinite(amountNum) ? amountNum / 1e9 : 0).toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL`
  const usdLabel = `$${(Number.isFinite(usd) && usd > 0 ? usd : Number.isFinite(amountNum) ? amountNum / 1e6 : 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  const amountLabel = progress
    ? progress.sol > 0
      ? `$${progress.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}, ${progress.sol.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`
      : `$${progress.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : house
      ? solIn
        ? Number.isFinite(usd) && usd > 0
          ? `${solLabel}, ${usdLabel}`
          : solLabel
        : Number.isFinite(usd) && usd > 0
          ? usdLabel
          : solLabel
      : solIn
        ? solLabel
        : `$${(Number.isFinite(amountNum) ? amountNum / 1e6 : 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
  const withdrawLabel =
    status === "returned"
      ? "Returned"
      : progress?.stage === "refunding"
        ? "Coming back"
        : progress?.stage === "landed"
          ? "Sent"
          : progress?.stage === "failed"
            ? "Failed"
            : progress
              ? "On the way"
              : ""
  const refundTo = pickRefundTo(raw, solIn ? phantomPubkey : tradingAddress)
  const recipient = pickRecipient(raw, solIn ? tradingAddress : phantomPubkey)
  const heldLamports = !house && row.depositAddress && solIn ? await solLamports(row.depositAddress) : 0
  const details = asRecord(asRecord(raw).swapDetails)
  const refunded =
    typeof details.refundedAmountFormatted === "string"
      ? details.refundedAmountFormatted
      : typeof asRecord(raw).refundedAmountFormatted === "string"
        ? String(asRecord(raw).refundedAmountFormatted)
        : ""
  return {
    id: row.id,
    kind: withdraw || !solIn ? ("withdraw" as const) : ("deposit" as const),
    status,
    statusLabel: withdrawLabel || labelStatus(status, ctx),
    amountLabel,
    txHash: progress?.txHash || pickTxHash(raw),
    stage: progress?.stage ?? "",
    message: progress?.message ?? "",
    createdAt: row.createdAt.toISOString(),
    depositAddress: row.depositAddress,
    refundTo,
    recipient,
    heldLamports,
    refundedAmount: refunded,
    holder: house ? "Stockperps" : "NEAR Intents",
    parkedUsdc: ctx?.parkedUsdc ?? 0,
    liveUsd: ctx?.liveUsd ?? 0,
    creditMessage: ctx?.creditMessage ?? "",
  }
}
