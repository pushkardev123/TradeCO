import { decrypt } from "./crypto.js";

export const BINANCE_TESTNET_EXCHANGE = "BINANCE_SPOT_TESTNET";

export async function getActiveExchangeCredential(prisma, userId) {
    const credential = await prisma.exchangeCredential.findFirst({
        where: {
            userId,
            exchange: BINANCE_TESTNET_EXCHANGE,
            isActive: true,
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            apiKeyEnc: true,
            secretKeyEnc: true,
        },
    });

    if (!credential) {
        const err = new Error("Exchange credential not found");
        err.statusCode = 404;
        throw err;
    }

    return credential;
}

export async function getDecryptedExchangeCredential(prisma, userId) {
    const credential = await getActiveExchangeCredential(prisma, userId);
    return {
        id: credential.id,
        apiKey: decrypt(credential.apiKeyEnc),
        apiSecret: decrypt(credential.secretKeyEnc),
    };
}
