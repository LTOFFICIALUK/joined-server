# joined server

API and copy engine for joined.fun.

Phantom sign in, SOL deposits that land as USDC, stock perp orders, positions, and withdrawals. A worker copies stock perp trades for every active join.

## Env

Copy `.env.example`.

- `DATABASE_URL` from the joined Railway Postgres
- `SESSION_SECRET` a long random string
- `CORS_ORIGIN` https://joined.fun

Hyperliquid public info does not need a key.
