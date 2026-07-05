export const VERIFICATION_STATUS = Object.freeze({
	VERIFIED: "verified",
	PARTIALLY_SUPPORTED: "partially_supported",
	UNSUPPORTED: "unsupported",
	CONFLICTING: "conflicting",
	VERIFICATION_BLOCKED: "verification_blocked",
	UNVERIFIED: "unverified",
} as const);

export type VerificationStatus =
	(typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

export type TerminalVerificationStatus = Exclude<
	VerificationStatus,
	(typeof VERIFICATION_STATUS)["UNVERIFIED"]
>;

export const VERIFICATION_STATUS_VALUES = Object.freeze([
	VERIFICATION_STATUS.VERIFIED,
	VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
	VERIFICATION_STATUS.UNSUPPORTED,
	VERIFICATION_STATUS.CONFLICTING,
	VERIFICATION_STATUS.VERIFICATION_BLOCKED,
] as const satisfies readonly TerminalVerificationStatus[]);

export const VERIFICATION_STATUS_BUCKETS = Object.freeze({
	[VERIFICATION_STATUS.VERIFIED]: "verified",
	[VERIFICATION_STATUS.PARTIALLY_SUPPORTED]: "partiallySupported",
	[VERIFICATION_STATUS.UNSUPPORTED]: "unsupported",
	[VERIFICATION_STATUS.CONFLICTING]: "conflicting",
	[VERIFICATION_STATUS.VERIFICATION_BLOCKED]: "verificationBlocked",
} as const satisfies Record<TerminalVerificationStatus, string>);

export const VERIFICATION_STATUS_LABELS = Object.freeze({
	[VERIFICATION_STATUS.VERIFIED]: "verified",
	[VERIFICATION_STATUS.PARTIALLY_SUPPORTED]: "partially supported",
	[VERIFICATION_STATUS.UNSUPPORTED]: "unsupported",
	[VERIFICATION_STATUS.CONFLICTING]: "conflicting",
	[VERIFICATION_STATUS.VERIFICATION_BLOCKED]: "verification blocked",
	[VERIFICATION_STATUS.UNVERIFIED]: "unverified",
} as const satisfies Record<VerificationStatus, string>);

export function canonicalVerificationStatus(
	status: unknown,
): VerificationStatus {
	const text = String(status ?? "").trim();
	if (!text) return VERIFICATION_STATUS.UNVERIFIED;
	if (text === "partiallySupported") {
		return VERIFICATION_STATUS.PARTIALLY_SUPPORTED;
	}
	if (text === "verificationBlocked" || text === "blocked") {
		return VERIFICATION_STATUS.VERIFICATION_BLOCKED;
	}
	return Object.values(VERIFICATION_STATUS).includes(text as VerificationStatus)
		? (text as VerificationStatus)
		: VERIFICATION_STATUS.UNVERIFIED;
}

export function verificationStatusBucket(status: unknown): string {
	const canonical = canonicalVerificationStatus(status);
	return canonical in VERIFICATION_STATUS_BUCKETS
		? VERIFICATION_STATUS_BUCKETS[canonical as TerminalVerificationStatus]
		: "other";
}

export function isVerifiedStatus(status: unknown): boolean {
	return canonicalVerificationStatus(status) === VERIFICATION_STATUS.VERIFIED;
}

export function isVerificationBlockedStatus(status: unknown): boolean {
	return (
		canonicalVerificationStatus(status) ===
		VERIFICATION_STATUS.VERIFICATION_BLOCKED
	);
}

const NON_VERIFIED_TERMINAL_STATUSES = new Set<VerificationStatus>([
	VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
	VERIFICATION_STATUS.UNSUPPORTED,
	VERIFICATION_STATUS.CONFLICTING,
	VERIFICATION_STATUS.VERIFICATION_BLOCKED,
]);

export function isNonVerifiedTerminalStatus(status: unknown): boolean {
	return NON_VERIFIED_TERMINAL_STATUSES.has(
		canonicalVerificationStatus(status),
	);
}
