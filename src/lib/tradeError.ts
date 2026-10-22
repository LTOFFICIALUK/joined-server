export const tradeError = (value: unknown) => {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : ""
  const text = message.trim()
  if (!text || text === "null" || text === "undefined" || /unexpected error/i.test(text)) {
    return "The trade did not land. Try again."
  }
  if (/does not exist/i.test(text)) return "Fund the account first. A trade can land after USDC arrives."
  if (/insufficient margin|not enough margin|insufficient balance/i.test(text)) return "Not enough free USDC for that trade."
  return text
}
