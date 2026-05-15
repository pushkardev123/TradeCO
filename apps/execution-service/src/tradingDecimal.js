import { Prisma } from "@prisma/client";

export function decimalString(value) {
    if (value === undefined || value === null || value === "") return null;
    try {
        const decimal = new Prisma.Decimal(String(value));
        if (!decimal.isFinite()) return null;
        return decimal.toFixed();
    } catch {
        return null;
    }
}

export function decimalOrZero(value) {
    return new Prisma.Decimal(decimalString(value) ?? "0");
}

export function isPositiveDecimal(value) {
    const normalized = decimalString(value);
    if (normalized === null) return false;
    return new Prisma.Decimal(normalized).gt(0);
}

export function addDecimalStrings(left, right) {
    return decimalOrZero(left).plus(decimalOrZero(right)).toFixed();
}

export function divideDecimalStrings(numerator, denominator) {
    const top = decimalOrZero(numerator);
    const bottom = decimalOrZero(denominator);
    if (!top.gt(0) || !bottom.gt(0)) return null;
    return top.div(bottom).toFixed();
}
