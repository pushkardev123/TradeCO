-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "parentId" TEXT,
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "label" TEXT,
    "apiKeyEnc" TEXT NOT NULL,
    "secretKeyEnc" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeCredential_pkey" PRIMARY KEY ("id")
);

-- Migrate existing encrypted Binance Testnet keys out of User before dropping those columns.
INSERT INTO "ExchangeCredential" (
    "id",
    "userId",
    "exchange",
    "label",
    "apiKeyEnc",
    "secretKeyEnc",
    "isActive",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('migrated_', "id"),
    "id",
    'BINANCE_SPOT_TESTNET',
    'Binance Spot Testnet',
    "binanceApiKeyEnc",
    "binanceSecretKeyEnc",
    true,
    "createdAt",
    CURRENT_TIMESTAMP
FROM "User";

-- Drop legacy credential columns from User. Credentials now live in ExchangeCredential.
ALTER TABLE "User" DROP COLUMN "binanceApiKeyEnc";
ALTER TABLE "User" DROP COLUMN "binanceSecretKeyEnc";

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "ExchangeCredential_userId_exchange_idx" ON "ExchangeCredential"("userId", "exchange");

-- CreateIndex
CREATE INDEX "ExchangeCredential_userId_isActive_idx" ON "ExchangeCredential"("userId", "isActive");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeCredential" ADD CONSTRAINT "ExchangeCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
