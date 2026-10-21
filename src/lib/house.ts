import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid"
import { keccak256, toBytes, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { env } from "./env.js"
import { getAllMids, getClearinghouse } from "./hyperliquid.js"

export const houseKey = () =>
  (env.houseHlKey || keccak256(toBytes(`joined-house-hl:${env.sessionSecret}`))) as Hex

export const houseAccount = () => privateKeyToAccount(houseKey())

const clientOf = (privateKey: Hex) =>
  new ExchangeClient({
    transport: new HttpTransport(),
    wallet: privateKeyToAccount(privateKey),
  })

export const houseInventoryUsd = async () => {
  const state = (await getClearinghouse(houseAccount().address)) as { withdrawable?: string }
  return Number(state.withdrawable ?? 0)
}

export const solMarkUsd = async () => {
  const mids = (await getAllMids()) as Record<string, string>
  const mark = Number(mids.SOL ?? mids.sol)
  if (!Number.isFinite(mark) || mark <= 0) throw new Error("SOL price is unavailable")
  return mark
}

export const creditUsd = async (destination: `0x${string}`, amountUsd: number) => {
  const free = await houseInventoryUsd()
  if (free < amountUsd) {
    throw new Error("Live inventory is too low for that send. Try a smaller amount.")
  }
  return clientOf(houseKey()).usdSend({
    destination,
    amount: amountUsd.toFixed(2),
  })
}

export const reclaimUsd = async (fromKey: Hex, amountUsd: number) =>
  clientOf(fromKey).usdSend({
    destination: houseAccount().address,
    amount: amountUsd.toFixed(2),
  })
