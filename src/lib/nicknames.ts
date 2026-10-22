type Side = "long" | "short"

type NamedPosition = {
  label: string
  side: Side
  leverage: number
  positionValue: number
}

type NamedTrader = {
  accountValue: number
  positions: NamedPosition[]
}

const CHIPS = new Set(["MU", "SNDK", "DRAM", "SKHX", "SKHY", "KIOXIA", "WDC"])

const PRETTY: Record<string, string> = {
  GOLD: "Gold",
  SILVER: "Silver",
  PLATINUM: "Platinum",
  PALLADIUM: "Palladium",
  COPPER: "Copper",
  NATGAS: "Gas",
  BRENTOIL: "Brent",
  CL: "Crude",
  NVDA: "Nvidia",
  TSLA: "Tesla",
  META: "Meta",
  AAPL: "Apple",
  AMZN: "Amazon",
  MSFT: "Microsoft",
  GOOGL: "Google",
  AMD: "AMD",
  INTC: "Intel",
  PLTR: "Palantir",
  COIN: "Coinbase",
  HOOD: "Robinhood",
  MSTR: "Strategy",
  TSM: "TSMC",
  NFLX: "Netflix",
  AVGO: "Broadcom",
  MU: "Micron",
  SNDK: "SanDisk",
  SKHX: "SK Hynix",
  SKHY: "SK Hynix",
  DRAM: "DRAM",
  KIOXIA: "Kioxia",
  WDC: "Western Digital",
  SP500: "Index",
  XYZ100: "Index",
  SPCX: "Space",
  CRCL: "Circle",
}

const pretty = (label: string) => PRETTY[label.toUpperCase()] ?? label

const ordered = (trader: NamedTrader) =>
  [...trader.positions].sort((a, b) => b.positionValue - a.positionValue)

export const nameCandidates = (trader: NamedTrader) => {
  const positions = ordered(trader)
  const lead = positions[0]
  if (!lead) return ["Quiet Book"]
  const name = pretty(lead.label)
  const bear = lead.side === "short"
  const side = bear ? "Bear" : "Bull"
  const dir = bear ? "Short" : "Long"
  const second = positions.find((position) => position.label !== lead.label)
  const third = positions.find((position) => position.label !== lead.label && position.label !== second?.label)
  const secondName = second ? pretty(second.label) : ""
  const thirdName = third ? pretty(third.label) : ""
  const hedge = Boolean(second && second.side !== lead.side)
  const lev = Math.max(1, Math.round(lead.leverage || 1))
  const gross = positions.reduce((sum, position) => sum + position.positionValue, 0) || 1
  const chips = positions.filter((position) => CHIPS.has(position.label.toUpperCase()))
  const chipNotional = chips.reduce((sum, position) => sum + position.positionValue, 0)
  const chipHeavy = chips.length > 0 && chipNotional / gross >= 0.35
  const chipSideShort = chips.filter((position) => position.side === "short").reduce((sum, position) => sum + position.positionValue, 0) * 2 >= chipNotional
  const exposure = trader.accountValue > 0 ? lead.positionValue / trader.accountValue : 0
  const names: string[] = []
  if (chipHeavy) names.push(chipSideShort ? "Memory Chip Bear" : "Memory Chip Bull")
  names.push(`${name} ${side}`)
  if (lev <= 3) names.push(`Patient ${name} ${dir}`)
  if (lev >= 8) names.push(`${lev}x ${name} ${side}`)
  if (hedge && secondName) names.push(`${chipHeavy ? "Chip" : name} ${side}, ${secondName} Hedge`)
  if (secondName && secondName !== name) names.push(`${name} and ${secondName} ${side}`)
  if (secondName && thirdName) names.push(`${name} ${dir}, ${secondName} and ${thirdName}`)
  if (positions.length >= 12) names.push(`Wide ${name} ${side}`)
  if (positions.length <= 2) names.push(`Focused ${name} ${dir}`)
  if (exposure >= 3) names.push(`Heavy ${name} ${side}`)
  if (exposure > 0 && exposure < 0.35) names.push(`Light ${name} ${dir}`)
  if (second && second.side === lead.side && secondName) names.push(`${name} ${dir} with ${secondName}`)
  return [...new Set(names)]
}

export const assignNicknames = <T extends NamedTrader>(traders: T[]) => {
  const used = new Set<string>()
  return traders.map((trader) => {
    const options = nameCandidates(trader)
    let nickname = options.find((name) => !used.has(name)) ?? ""
    if (!nickname) {
      const lead = ordered(trader)[0]
      const extra = ordered(trader).map((position) => pretty(position.label)).find((name) => !options[0]?.includes(name))
      nickname = extra && lead ? `${options[0] ?? pretty(lead.label)} via ${extra}` : (options[0] ?? "Quiet Book")
      let guard = 0
      while (used.has(nickname) && guard < options.length) {
        nickname = `${options[0]}, ${options[guard] ?? "Book"}`
        guard += 1
      }
    }
    used.add(nickname)
    return { ...trader, nickname }
  })
}
