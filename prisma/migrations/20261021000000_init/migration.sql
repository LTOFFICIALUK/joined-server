-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phantomPubkey" TEXT NOT NULL,
    "evmAddress" TEXT,
    "hlKeyEnc" TEXT,
    "solKeyEnc" TEXT,
    "solAddress" TEXT,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "id" TEXT NOT NULL,
    "pubkey" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intentId" TEXT,
    "depositAddress" TEXT,
    "originAsset" TEXT NOT NULL,
    "destAsset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Join" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trader" TEXT NOT NULL,
    "sizeUsd" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "seen" JSONB NOT NULL,
    "pending" JSONB NOT NULL,
    "copied" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "Join_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyAction" (
    "id" TEXT NOT NULL,
    "joinId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "traderAction" TEXT NOT NULL,
    "ourAction" TEXT NOT NULL,
    "traderSize" DOUBLE PRECISION NOT NULL,
    "traderAccountValue" DOUBLE PRECISION NOT NULL,
    "scale" DOUBLE PRECISION NOT NULL,
    "ourSize" DOUBLE PRECISION NOT NULL,
    "side" TEXT NOT NULL,
    "leverage" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phantomPubkey_key" ON "User"("phantomPubkey");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthNonce_nonce_key" ON "AuthNonce"("nonce");

-- CreateIndex
CREATE INDEX "AuthNonce_pubkey_idx" ON "AuthNonce"("pubkey");

-- CreateIndex
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Join_status_trader_idx" ON "Join"("status", "trader");

-- CreateIndex
CREATE UNIQUE INDEX "Join_userId_trader_key" ON "Join"("userId", "trader");

-- CreateIndex
CREATE INDEX "CopyAction_joinId_createdAt_idx" ON "CopyAction"("joinId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Join" ADD CONSTRAINT "Join_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyAction" ADD CONSTRAINT "CopyAction_joinId_fkey" FOREIGN KEY ("joinId") REFERENCES "Join"("id") ON DELETE CASCADE ON UPDATE CASCADE;
