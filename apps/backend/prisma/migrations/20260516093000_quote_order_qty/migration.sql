ALTER TABLE "OrderCommand"
    ADD COLUMN "quoteOrderQty" DECIMAL(36, 18);

ALTER TABLE "OrderCommand"
    ALTER COLUMN "quantity" DROP NOT NULL;
