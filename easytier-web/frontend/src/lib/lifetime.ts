export const MAX_JOIN_CREDENTIAL_SECONDS = 365 * 24 * 3600;
export const MAX_MANAGEMENT_TOKEN_SECONDS = 10 * MAX_JOIN_CREDENTIAL_SECONDS;

type LifetimeResult = { valid: true; seconds?: number } | { valid: false };

/** Convert custom whole days to API seconds; only management tokens may omit expiry. */
export function resolveLifetime(selection: string, days: string, maxSeconds: number, allowNoExpiry = false): LifetimeResult {
    if (selection === '' && allowNoExpiry) return { valid: true };
    const input = selection === 'custom' ? days : selection;
    const multiplier = selection === 'custom' ? 86400 : 1;
    const value = input.trim() === '' ? NaN : Number(input);
    const seconds = value * multiplier;
    if (!Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > maxSeconds) return { valid: false };
    return { valid: true, seconds };
}
