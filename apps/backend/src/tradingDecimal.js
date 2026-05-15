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

export function requiredDecimalString(value, fieldName) {
    const normalized = decimalString(value);
    if (normalized === null) {
        throw new Error(`${fieldName} must be a decimal value`);
    }
    return normalized;
}

export function decimalValuesEqual(left, right) {
    const normalizedLeft = decimalString(left);
    const normalizedRight = decimalString(right);
    if (normalizedLeft === null || normalizedRight === null) {
        return normalizedLeft === normalizedRight;
    }

    return new Prisma.Decimal(normalizedLeft).equals(normalizedRight);
}

export function isPositiveDecimalString(value) {
    const normalized = decimalString(value);
    if (normalized === null) return false;
    return new Prisma.Decimal(normalized).gt(0);
}

export function addDecimalStrings(left, right) {
    const leftDecimal = new Prisma.Decimal(decimalString(left) ?? "0");
    const rightDecimal = new Prisma.Decimal(decimalString(right) ?? "0");
    return leftDecimal.plus(rightDecimal).toFixed();
}

export function negateDecimalString(value) {
    return new Prisma.Decimal(decimalString(value) ?? "0").negated().toFixed();
}
