import {
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  toBytes,
  type Hex,
} from "viem"
import { arbitrum } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { env } from "./env.js"
import { houseKey } from "./house.js"
import { intentsReady, quoteSwap } from "./intents.js"

export const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const
export const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const
export const MIN_HL_USDC = 5_000_000n
export const MIN_QUOTE_USDC = 6_000_000n

const erc20 = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function nonces(address owner) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
])

const bridge = parseAbi([
  "function batchedDepositWithPermit((address user, uint64 usd, uint64 deadline, (uint256 r, uint256 s, uint8 v) signature)[] deposits)",
])

const inflight = new Map<string, Promise<CreditResult>>()

export type CreditResult = {
  tradingAddress: string
  gasAddress: string
  parkedUsdc: number
  credited: boolean
  txHash: string
  message: string
}

const rpc = () =>
  createPublicClient({
    chain: arbitrum,
    transport: http(env.arbRpc),
  })

export const gasKey = () =>
  (env.arbRelayerKey || keccak256(toBytes(`joined-arb-gas:${env.sessionSecret}`))) as Hex

export const gasAddress = () => privateKeyToAccount(gasKey()).address

export const usdcBalance = async (address: `0x${string}`) =>
  (await rpc().readContract({
    address: USDC,
    abi: erc20,
    functionName: "balanceOf",
    args: [address],
  })) as bigint

const hasGas = async (address: `0x${string}`) =>
  (await rpc().getBalance({ address })) > 200_000_000_000_000n

const walletOf = (key: Hex) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    chain: arbitrum,
    transport: http(env.arbRpc),
  })

const signUsdcPermit = async (userKey: Hex, spender: `0x${string}`, amount: bigint, deadline: bigint) => {
  const user = privateKeyToAccount(userKey)
  const nonce = (await rpc().readContract({
    address: USDC,
    abi: erc20,
    functionName: "nonces",
    args: [user.address],
  })) as bigint
  const signed = await user.signTypedData({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 42161,
      verifyingContract: USDC,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: user.address,
      spender,
      value: amount,
      nonce,
      deadline,
    },
  })
  const parsed = parseSignature(signed)
  return {
    v: Number(parsed.v ?? (parsed.yParity ? 28 : 27)),
    r: parsed.r,
    s: parsed.s,
    rInt: hexToBigInt(parsed.r),
    sInt: hexToBigInt(parsed.s),
  }
}

const pullUsdc = async (userKey: Hex, payerKey: Hex, to: `0x${string}`, amount: bigint) => {
  const user = privateKeyToAccount(userKey)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30)
  const permit = await signUsdcPermit(userKey, privateKeyToAccount(payerKey).address, amount, deadline)
  const payer = walletOf(payerKey)
  await payer.writeContract({
    address: USDC,
    abi: erc20,
    functionName: "permit",
    args: [user.address, privateKeyToAccount(payerKey).address, amount, deadline, permit.v, permit.r, permit.s],
  })
  return payer.writeContract({
    address: USDC,
    abi: erc20,
    functionName: "transferFrom",
    args: [user.address, to, amount],
  })
}

const sendUsdc = async (userKey: Hex, payerKey: Hex, to: `0x${string}`, amount: bigint) => {
  if (await hasGas(privateKeyToAccount(userKey).address)) {
    return walletOf(userKey).writeContract({
      address: USDC,
      abi: erc20,
      functionName: "transfer",
      args: [to, amount],
    })
  }
  return pullUsdc(userKey, payerKey, to, amount)
}

const permitBridge = async (userKey: Hex, payerKey: Hex, amount: bigint) => {
  const user = privateKeyToAccount(userKey)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30)
  const permit = await signUsdcPermit(userKey, HL_BRIDGE, amount, deadline)
  return walletOf(payerKey).writeContract({
    address: HL_BRIDGE,
    abi: bridge,
    functionName: "batchedDepositWithPermit",
    args: [
      [
        {
          user: user.address,
          usd: amount,
          deadline,
          signature: { r: permit.rInt, s: permit.sInt, v: permit.v },
        },
      ],
    ],
  })
}

const refundUsdcToPhantom = async (userKey: Hex, amount: bigint, phantomPubkey: string, payerKey: Hex) => {
  const user = privateKeyToAccount(userKey)
  const quote = (await quoteSwap(
    {
      originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      destinationAsset: "nep141:sol.omft.near",
      amount: amount.toString(),
      recipient: phantomPubkey,
      refundTo: user.address,
    },
    intentsReady(true),
  )) as Record<string, unknown>
  const packed = (quote.quote as Record<string, unknown> | undefined) ?? quote
  const next = String(packed.depositAddress ?? quote.depositAddress ?? "")
  if (!next.startsWith("0x") || next.length !== 42) {
    throw new Error("Could not open a SOL refund route")
  }
  return sendUsdc(userKey, payerKey, next as `0x${string}`, amount)
}

const runCredit = async (userKey: Hex, phantomPubkey: string): Promise<CreditResult> => {
  const user = privateKeyToAccount(userKey)
  const relayer = gasKey()
  const house = houseKey()
  const parked = await usdcBalance(user.address)
  const parkedUsdc = Number(parked) / 1e6
  const payerKey = (await hasGas(user.address))
    ? userKey
    : (await hasGas(privateKeyToAccount(relayer).address))
      ? relayer
      : house
  const base = {
    tradingAddress: user.address,
    gasAddress: privateKeyToAccount(payerKey).address,
    parkedUsdc,
    credited: false,
    txHash: "",
  }
  if (parked <= 0n) return { ...base, message: "" }

  if (!(await hasGas(privateKeyToAccount(payerKey).address))) {
    return {
      ...base,
      message: `Your 0.1 SOL is ${parkedUsdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC on ${user.address}. It cannot move until that address has a little ETH on Arbitrum. Send ETH there, then tap Return funds.`,
    }
  }

  try {
    if (parked < MIN_HL_USDC) {
      const txHash = await refundUsdcToPhantom(userKey, parked, phantomPubkey, payerKey)
      await rpc().waitForTransactionReceipt({ hash: txHash })
      return {
        ...base,
        parkedUsdc: 0,
        credited: true,
        txHash,
        message: "This send was under the 5 USD Hyperliquid floor. USDC is going back to Phantom as SOL.",
      }
    }
    const txHash =
      payerKey === userKey
        ? await sendUsdc(userKey, payerKey, HL_BRIDGE, parked)
        : await permitBridge(userKey, payerKey, parked)
    await rpc().waitForTransactionReceipt({ hash: txHash })
    return {
      ...base,
      parkedUsdc: 0,
      credited: true,
      txHash,
      message: "USDC is being credited to Live. Wait about a minute.",
    }
  } catch (err) {
    return {
      ...base,
      message: err instanceof Error ? err.message : "Could not credit Live from parked USDC",
    }
  }
}

export const creditLive = (userKey: Hex, phantomPubkey: string) => {
  const user = privateKeyToAccount(userKey)
  const pending = inflight.get(user.address)
  if (pending) return pending
  const task = runCredit(userKey, phantomPubkey).finally(() => inflight.delete(user.address))
  inflight.set(user.address, task)
  return task
}

export const quoteUsdcOut = (packed: Record<string, unknown>) => {
  const raw = packed.amountOut ?? packed.minAmountOut ?? packed.dstAmount
  try {
    return BigInt(String(raw ?? "0"))
  } catch {
    return 0n
  }
}
