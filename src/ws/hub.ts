import type { IncomingMessage, Server as HttpServer } from "node:http"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { env } from "../lib/env.js"
import { isAllowedOrigin } from "../lib/origin.js"

type Client = { socket: WebSocket; coins: Set<string> }

type UpstreamMessage = {
  channel?: string
  data?: { coin?: string; s?: string }
}

export const attachHub = (server: HttpServer) => {
  const wss = new WebSocketServer({
    server,
    path: "/stream",
    verifyClient: (info: { origin: string; req: IncomingMessage }) => {
      const header = info.req.headers.origin
      const origin = info.origin || (Array.isArray(header) ? header[0] : header)
      return isAllowedOrigin(origin)
    },
  })

  const clients = new Set<Client>()
  let upstream: WebSocket | null = null
  let connecting = false
  const subscribed = new Set<string>()

  const sendUp = (payload: unknown) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload))
    }
  }

  const releaseUpstream = () => {
    const socket = upstream
    upstream = null
    connecting = false
    subscribed.clear()
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
  }

  const ensureCoin = (coin: string) => {
    if (!clients.size) return
    connectUp()
    if (subscribed.has(coin)) return
    subscribed.add(coin)
    sendUp({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } })
  }

  const connectUp = () => {
    if (!clients.size) return
    if (connecting || upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) return
    connecting = true
    const socket = new WebSocket(env.hlWsUrl)
    upstream = socket
    socket.on("open", () => {
      connecting = false
      if (!clients.size) {
        releaseUpstream()
        return
      }
      const coins = [...subscribed]
      subscribed.clear()
      for (const coin of coins) ensureCoin(coin)
    })
    socket.on("message", (raw: RawData) => {
      const text = raw.toString()
      let parsed: UpstreamMessage
      try {
        parsed = JSON.parse(text) as UpstreamMessage
      } catch {
        return
      }
      const coin = parsed.data?.coin ?? parsed.data?.s
      for (const client of clients) {
        if (client.socket.readyState !== WebSocket.OPEN) {
          clients.delete(client)
          continue
        }
        if (client.socket.bufferedAmount > 1_000_000) {
          clients.delete(client)
          client.socket.close()
          continue
        }
        if (parsed.channel === "subscriptionResponse" || (coin && client.coins.has(coin))) {
          client.socket.send(text)
        }
      }
    })
    socket.on("close", () => {
      if (upstream !== socket) return
      connecting = false
      upstream = null
      if (clients.size > 0) setTimeout(connectUp, 1500)
    })
    socket.on("error", () => socket.close())
  }

  wss.on("connection", (socket) => {
    const client: Client = { socket, coins: new Set(["xyz:NVDA"]) }
    clients.add(client)
    ensureCoin("xyz:NVDA")
    socket.on("message", (raw: RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; coin?: string }
        if (msg.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }))
          return
        }
        if (msg.type === "watch" && msg.coin) {
          client.coins.add(msg.coin)
          ensureCoin(msg.coin)
        }
      } catch {
        return
      }
    })
    socket.on("close", () => {
      clients.delete(client)
      if (!clients.size) releaseUpstream()
    })
    socket.on("error", () => {
      clients.delete(client)
      socket.close()
    })
  })
}
