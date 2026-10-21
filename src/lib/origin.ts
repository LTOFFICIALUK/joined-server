import { env } from "./env.js"

export const isAllowedOrigin = (origin: string | undefined | null): boolean => {
  if (!origin) return true
  const listed = env.corsOrigin.split(",").map((item) => item.trim()).filter(Boolean)
  if (listed.includes("*") || listed.includes(origin)) return true
  if (
    origin === "https://joined.fun" ||
    origin === "https://www.joined.fun" ||
    origin.endsWith(".vercel.app") ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return true
  }
  return false
}
