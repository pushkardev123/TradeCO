import {
    REALTIME_EVENT_TYPES,
    getRealtimeChannelConfig,
    validateRealtimeChannelPayload,
    validateWebSocketRedisEnvelope,
} from "@tradeco/redis-stream-contracts";

export function validateBroadcastMessage({
    channel,
    message,
    channels = getRealtimeChannelConfig(process.env),
} = {}) {
    let payload;
    try {
        payload = JSON.parse(message);
        if (typeof payload === "string") payload = JSON.parse(payload);
    } catch {
        return { ok: false, payload: null, errors: ["message must parse as JSON"] };
    }

    const errors = validateRealtimeChannelPayload(channel, payload, { channels });
    return { ok: errors.length === 0, payload, errors };
}

export function createRedisWebSocketEnvelope({
    channel,
    message,
    ts = Date.now(),
    channels = getRealtimeChannelConfig(process.env),
} = {}) {
    const envelope = {
        type: REALTIME_EVENT_TYPES.redisEnvelope,
        channel,
        message,
        ts,
    };
    const errors = validateWebSocketRedisEnvelope(envelope, { channels });
    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }
    return JSON.stringify(envelope);
}
