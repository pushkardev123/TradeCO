import {
    buildOrderCommandDeadLetterEntry,
    parseOrderCommandStreamEntry,
} from "@tradeco/redis-stream-contracts";

const DEFAULT_BLOCK_MS = 5000;

export async function ensureOrderConsumerGroup({ redis, streamName, groupName }) {
    try {
        await redis.xGroupCreate(streamName, groupName, "0", { MKSTREAM: true });
    } catch (error) {
        if (!isBusyGroupError(error)) {
            throw error;
        }
    }
}

export function flattenRedisStreamMessages(response) {
    if (!response) return [];

    const streams = Array.isArray(response) ? response : [response];
    const messages = [];

    for (const stream of streams) {
        const streamName = stream.name || stream.key;
        const streamMessages = stream.messages || stream.entries || [];

        for (const message of streamMessages) {
            messages.push({
                streamName,
                id: message.id,
                fields: message.message || message.fields || {},
            });
        }
    }

    return messages.filter((message) => message.id);
}

export async function readNewOrderStreamMessages({
    redis,
    streamName,
    groupName,
    consumerName,
    count,
    blockMs = DEFAULT_BLOCK_MS,
}) {
    const response = await redis.xReadGroup(
        groupName,
        consumerName,
        [{ key: streamName, id: ">" }],
        { COUNT: count, BLOCK: blockMs },
    );

    return flattenRedisStreamMessages(response);
}

export async function claimIdleOrderStreamMessages({
    redis,
    streamName,
    groupName,
    consumerName,
    minIdleMs,
    count,
}) {
    if (typeof redis.xAutoClaim !== "function") {
        return [];
    }

    const response = await redis.xAutoClaim(
        streamName,
        groupName,
        consumerName,
        minIdleMs,
        "0-0",
        { COUNT: count },
    );

    if (Array.isArray(response?.messages)) {
        return flattenRedisStreamMessages({ name: streamName, messages: response.messages });
    }

    if (Array.isArray(response?.entries)) {
        return flattenRedisStreamMessages({ name: streamName, messages: response.entries });
    }

    if (Array.isArray(response) && Array.isArray(response[1])) {
        return flattenRedisStreamMessages({ name: streamName, messages: response[1] });
    }

    return [];
}

export async function handleOrderStreamMessage({
    redis,
    streamName,
    groupName,
    dlqStreamName,
    maxAttempts,
    message,
    processCommand,
    safeErrorMessage = defaultSafeErrorMessage,
    logger = null,
}) {
    let command;
    const startedAt = Date.now();

    try {
        command = parseOrderCommandStreamEntry(message.fields);
    } catch (error) {
        const attempts = await getDeliveryCount({ redis, streamName, groupName, messageId: message.id });
        await writeDeadLetterAndAck({
            redis,
            streamName,
            groupName,
            dlqStreamName,
            message,
            command: message.fields,
            attempts,
            reason: `Invalid stream command: ${safeErrorMessage(error)}`,
        });
        logStream(logger, "warn", "order_stream.message_dead_lettered", {
            streamName,
            groupName,
            streamMessageId: message.id,
            reason: "invalid",
            attempts,
            durationMs: elapsedMs(startedAt),
        });
        return { outcome: "dead-lettered", reason: "invalid", id: message.id };
    }

    const baseFields = {
        streamName,
        groupName,
        streamMessageId: message.id,
        messageType: command.messageType,
        commandId: command.commandId,
        orderId: command.orderId,
        userId: command.userId,
        symbol: command.symbol,
        requestId: command.requestId,
    };

    try {
        const result = await processCommand(command);
        await redis.xAck(streamName, groupName, message.id);
        logStream(logger, "info", "order_stream.message_acked", {
            ...baseFields,
            outcome: result?.outcome,
            durationMs: elapsedMs(startedAt),
        });
        return { outcome: "acked", id: message.id, result };
    } catch (error) {
        const attempts = await getDeliveryCount({ redis, streamName, groupName, messageId: message.id });

        if (attempts >= maxAttempts) {
            await writeDeadLetterAndAck({
                redis,
                streamName,
                groupName,
                dlqStreamName,
                message,
                command,
                attempts,
                reason: safeErrorMessage(error),
            });
            logStream(logger, "error", "order_stream.message_dead_lettered", {
                ...baseFields,
                reason: "max-attempts",
                attempts,
                error: safeErrorMessage(error),
                durationMs: elapsedMs(startedAt),
            });
            return { outcome: "dead-lettered", reason: "max-attempts", id: message.id };
        }

        logStream(logger, "warn", "order_stream.message_pending", {
            ...baseFields,
            attempts,
            error: safeErrorMessage(error),
            durationMs: elapsedMs(startedAt),
        });
        throw error;
    }
}

export function startOrderStreamConsumer({
    redis,
    streamName,
    groupName,
    consumerName,
    dlqStreamName,
    readCount,
    claimIdleMs,
    maxAttempts,
    processCommand,
    safeErrorMessage = defaultSafeErrorMessage,
    logger = null,
}) {
    let stopped = false;

    let groupReady = false;

    const done = (async () => {
        while (!stopped) {
            try {
                if (!groupReady) {
                    await ensureOrderConsumerGroup({ redis, streamName, groupName });
                    groupReady = true;
                }

                const claimed = await claimIdleOrderStreamMessages({
                    redis,
                    streamName,
                    groupName,
                    consumerName,
                    minIdleMs: claimIdleMs,
                    count: readCount,
                });
                await handleMessages({ messages: claimed });

                const fresh = await readNewOrderStreamMessages({
                    redis,
                    streamName,
                    groupName,
                    consumerName,
                    count: readCount,
                });
                await handleMessages({ messages: fresh });
            } catch (error) {
                logStream(logger, "error", "order_stream.consumer_error", {
                    streamName,
                    groupName,
                    consumerName,
                    error: safeErrorMessage(error),
                });
                await sleep(1000);
            }
        }
    })();

    async function handleMessages({ messages }) {
        for (const message of messages) {
            await handleOrderStreamMessage({
                redis,
                streamName,
                groupName,
                dlqStreamName,
                maxAttempts,
                message,
                processCommand,
                safeErrorMessage,
                logger,
            }).catch((error) => {
                logStream(logger, "warn", "order_stream.message_left_pending", {
                    streamName,
                    groupName,
                    id: message.id,
                    error: safeErrorMessage(error),
                });
            });
        }
    }

    return {
        stop() {
            stopped = true;
        },
        done,
    };
}

async function writeDeadLetterAndAck({
    redis,
    streamName,
    groupName,
    dlqStreamName,
    message,
    command,
    attempts,
    reason,
}) {
    const dlqEntry = buildOrderCommandDeadLetterEntry({
        originalStreamId: message.id,
        reason,
        command,
        attempts,
    });

    await redis.xAdd(dlqStreamName, "*", dlqEntry);
    await redis.xAck(streamName, groupName, message.id);
}

async function getDeliveryCount({ redis, streamName, groupName, messageId }) {
    if (typeof redis.xPendingRange !== "function") {
        return 1;
    }

    const rows = await redis.xPendingRange(streamName, groupName, messageId, messageId, 1);
    const row = rows?.[0];

    if (!row) return 1;

    return Number(
        row.deliveriesCounter ??
        row.deliveryCounter ??
        row.deliveryCount ??
        row.timesDelivered ??
        row[3] ??
        1
    ) || 1;
}

function isBusyGroupError(error) {
    return /BUSYGROUP/i.test(String(error?.message || error));
}

function defaultSafeErrorMessage(error) {
    return String(error?.message || error || "Unknown error");
}

function logStream(logger, level, message, fields = {}) {
    const fn = logger?.[level];
    if (typeof fn === "function") {
        fn.call(logger, message, fields);
    }
}

function elapsedMs(startedAt) {
    return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
