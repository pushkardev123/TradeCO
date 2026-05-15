ALTER TABLE "OrderCommand"
  ALTER COLUMN "quantity" TYPE DECIMAL(36,18) USING "quantity"::numeric,
  ALTER COLUMN "price" TYPE DECIMAL(36,18) USING "price"::numeric,
  ALTER COLUMN "stopPrice" TYPE DECIMAL(36,18) USING "stopPrice"::numeric,
  ALTER COLUMN "executedQty" TYPE DECIMAL(36,18) USING "executedQty"::numeric,
  ALTER COLUMN "executedQty" SET DEFAULT 0,
  ALTER COLUMN "cummulativeQuoteQty" TYPE DECIMAL(36,18) USING "cummulativeQuoteQty"::numeric,
  ALTER COLUMN "cummulativeQuoteQty" SET DEFAULT 0,
  ALTER COLUMN "avgFillPrice" TYPE DECIMAL(36,18) USING "avgFillPrice"::numeric,
  ALTER COLUMN "lastTradeQty" TYPE DECIMAL(36,18) USING "lastTradeQty"::numeric,
  ALTER COLUMN "lastTradePrice" TYPE DECIMAL(36,18) USING "lastTradePrice"::numeric;

ALTER TABLE "OrderEvent"
  ALTER COLUMN "price" TYPE DECIMAL(36,18) USING "price"::numeric,
  ALTER COLUMN "quantity" TYPE DECIMAL(36,18) USING "quantity"::numeric;

ALTER TABLE "Position"
  ALTER COLUMN "quantity" TYPE DECIMAL(36,18) USING "quantity"::numeric,
  ALTER COLUMN "avgPrice" TYPE DECIMAL(36,18) USING "avgPrice"::numeric,
  ALTER COLUMN "realizedPnl" TYPE DECIMAL(36,18) USING "realizedPnl"::numeric,
  ALTER COLUMN "realizedPnl" SET DEFAULT 0;
