import { env } from "./env.js"

const headers = (confidential: boolean) => {
  const jwt = confidential && env.oneClickConfidentialJwt
    ? env.oneClickConfidentialJwt
    : env.oneClickJwt
  if (!jwt) return null
  return {
    "content-type": "application/json",
    authorization: `Bearer ${jwt}`,
    "X-API-Key": jwt,
  }
}

const base = (confidential: boolean) => {
  if (confidential && env.oneClickConfidentialBase) return env.oneClickConfidentialBase
  return env.oneClickBase
}

export const intentsReady = (confidential = false) =>
  Boolean(headers(confidential))

const call = async (path: string, init: RequestInit, confidential: boolean) => {
  const h = headers(confidential)
  if (!h) {
    const err = new Error("NEAR Intents is not configured. Add ONECLICK_JWT.")
    ;(err as Error & { code?: string }).code = "INTENTS_UNCONFIGURED"
    throw err
  }
  const res = await fetch(`${base(confidential)}${path}`, {
    ...init,
    headers: { ...h, ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let json: unknown = text
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const payload = json && typeof json === "object" ? (json as Record<string, unknown>) : {}
    const apiMessage = String(payload.message ?? payload.error ?? "")
    const err = new Error(apiMessage || `Intents ${res.status}`)
    ;(err as Error & { payload?: unknown }).payload = json
    throw err
  }
  return json
}

export const listTokens = (confidential = false) =>
  call("/v0/tokens", { method: "GET" }, confidential)

export const getQuote = (body: Record<string, unknown>, confidential = false) =>
  call("/v0/quote", { method: "POST", body: JSON.stringify(body) }, confidential)

export const quoteSwap = (
  input: {
    originAsset: string
    destinationAsset: string
    amount: string
    recipient: string
    refundTo: string
    refundType?: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS"
    recipientType?: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS"
    dry?: boolean
  },
  confidential = false,
) =>
  getQuote(
    {
      dry: input.dry ?? false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: input.originAsset,
      destinationAsset: input.destinationAsset,
      amount: input.amount,
      recipient: input.recipient,
      recipientType: input.recipientType ?? "DESTINATION_CHAIN",
      refundTo: input.refundTo,
      refundType: input.refundType ?? "ORIGIN_CHAIN",
      depositType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    },
    confidential,
  )

export const submitDeposit = (body: Record<string, unknown>, confidential = false) =>
  call("/v0/deposit/submit", { method: "POST", body: JSON.stringify(body) }, confidential)

export const getStatus = (query: string, confidential = false) =>
  call(`/v0/status?${query}`, { method: "GET" }, confidential)
