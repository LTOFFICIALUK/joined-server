const required = (key: string, fallback?: string) => {
  const value = process.env[key] ?? fallback
  if (value === undefined) throw new Error(`Missing ${key}`)
  return value
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/joined"),
  corsOrigin: process.env.CORS_ORIGIN ?? "https://joined.fun,https://www.joined.fun,http://localhost:3000",
  sessionSecret: required("SESSION_SECRET", "joined-dev-secret-change-me"),
  hlInfoUrl: process.env.HL_INFO_URL ?? "https://api.hyperliquid.xyz/info",
  hlWsUrl: process.env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws",
  oneClickJwt: process.env.ONECLICK_JWT ?? "",
  oneClickBase: process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com",
  oneClickConfidentialJwt: process.env.ONECLICK_CONFIDENTIAL_JWT ?? "",
  oneClickConfidentialBase: process.env.ONECLICK_CONFIDENTIAL_BASE_URL ?? "",
  solanaRpc: process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com",
  arbRpc: process.env.ARB_RPC ?? "https://arb1.arbitrum.io/rpc",
  arbRelayerKey: process.env.ARB_RELAYER_KEY ?? "",
  houseHlKey: process.env.HOUSE_HL_KEY ?? "",
  adminKey: process.env.ADMIN_KEY ?? "",
}
