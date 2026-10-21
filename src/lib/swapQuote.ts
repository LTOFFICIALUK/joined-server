import { previewRelayDeposit, previewRelayWithdraw } from "./relay.js"

export type FundPreview = {
  side: "deposit" | "withdraw"
  feeUsd: number
  exchangeFeeUsd: number
  receiveUsd: number
  receiveSol: number
  seconds: number
  waitSeconds: number
  sendSol: number
  sendUsd: number
}

export const previewDeposit = async (phantom: string, trading: string, sol: number) => {
  const quote = await previewRelayDeposit(phantom, trading, sol)
  const preview: FundPreview = {
    side: "deposit",
    feeUsd: quote.feeUsd,
    exchangeFeeUsd: 0,
    receiveUsd: quote.receiveUsd,
    receiveSol: 0,
    seconds: quote.seconds,
    waitSeconds: 0,
    sendSol: quote.sendSol,
    sendUsd: 0,
  }
  return preview
}

export const previewWithdraw = async (phantom: string, trading: string, usd: number) => {
  const quote = await previewRelayWithdraw(phantom, trading, usd)
  const preview: FundPreview = {
    side: "withdraw",
    feeUsd: quote.feeUsd,
    exchangeFeeUsd: 0,
    receiveUsd: 0,
    receiveSol: quote.receiveSol,
    seconds: quote.seconds,
    waitSeconds: 0,
    sendSol: 0,
    sendUsd: quote.sendUsd,
  }
  return preview
}
