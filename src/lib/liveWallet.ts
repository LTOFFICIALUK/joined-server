import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { decryptSecret, encryptSecret } from "./secret.js"
import { prisma } from "./prisma.js"

export const ensureLiveWallet = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new Error("Unknown user")
  if (user.hlKeyEnc) {
    const privateKey = decryptSecret(user.hlKeyEnc) as `0x${string}`
    const account = privateKeyToAccount(privateKey)
    if (user.evmAddress !== account.address) {
      await prisma.user.update({
        where: { id: userId },
        data: { evmAddress: account.address },
      })
    }
    return { address: account.address, privateKey }
  }
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  await prisma.user.update({
    where: { id: userId },
    data: { evmAddress: account.address, hlKeyEnc: encryptSecret(privateKey) },
  })
  return { address: account.address, privateKey }
}
