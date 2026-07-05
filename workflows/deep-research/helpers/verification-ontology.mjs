// Bundle-local compatibility surface for the package verification ontology.
//
// Workflow support helpers are bundled from the workflow spec directory, so this
// dependency-free helper intentionally lives inside the deep-research bundle.
// Keep it in semantic parity with src/verification-ontology.ts.

export const VERIFICATION_STATUS = Object.freeze({
	VERIFIED: "verified",
	PARTIALLY_SUPPORTED: "partially_supported",
	UNSUPPORTED: "unsupported",
	CONFLICTING: "conflicting",
	VERIFICATION_BLOCKED: "verification_blocked",
	UNVERIFIED: "unverified",
});

export const VERIFICATION_STATUS_VALUES = Object.freeze([
	VERIFICATION_STATUS.VERIFIED,
	VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
	VERIFICATION_STATUS.UNSUPPORTED,
	VERIFICATION_STATUS.CONFLICTING,
	VERIFICATION_STATUS.VERIFICATION_BLOCKED,
]);

export const VERIFICATION_STATUS_BUCKETS = Object.freeze({
	[VERIFICATION_STATUS.VERIFIED]: "verified",
	[VERIFICATION_STATUS.PARTIALLY_SUPPORTED]: "partiallySupported",
	[VERIFICATION_STATUS.UNSUPPORTED]: "unsupported",
	[VERIFICATION_STATUS.CONFLICTING]: "conflicting",
	[VERIFICATION_STATUS.VERIFICATION_BLOCKED]: "verificationBlocked",
});

export const VERIFICATION_STATUS_LABELS = Object.freeze({
	[VERIFICATION_STATUS.VERIFIED]: "verified",
	[VERIFICATION_STATUS.PARTIALLY_SUPPORTED]: "partially supported",
	[VERIFICATION_STATUS.UNSUPPORTED]: "unsupported",
	[VERIFICATION_STATUS.CONFLICTING]: "conflicting",
	[VERIFICATION_STATUS.VERIFICATION_BLOCKED]: "verification blocked",
	[VERIFICATION_STATUS.UNVERIFIED]: "unverified",
});

export function canonicalVerificationStatus(status) {
	const text = String(status ?? "").trim();
	if (!text) return VERIFICATION_STATUS.UNVERIFIED;
	if (text === "partiallySupported")
		return VERIFICATION_STATUS.PARTIALLY_SUPPORTED;
	if (text === "verificationBlocked" || text === "blocked")
		return VERIFICATION_STATUS.VERIFICATION_BLOCKED;
	return Object.values(VERIFICATION_STATUS).includes(text)
		? text
		: VERIFICATION_STATUS.UNVERIFIED;
}

export function verificationStatusBucket(status) {
	return (
		VERIFICATION_STATUS_BUCKETS[canonicalVerificationStatus(status)] ?? "other"
	);
}

export function isVerifiedStatus(status) {
	return canonicalVerificationStatus(status) === VERIFICATION_STATUS.VERIFIED;
}

export function isVerificationBlockedStatus(status) {
	return (
		canonicalVerificationStatus(status) ===
		VERIFICATION_STATUS.VERIFICATION_BLOCKED
	);
}

export function isNonVerifiedTerminalStatus(status) {
	return [
		VERIFICATION_STATUS.PARTIALLY_SUPPORTED,
		VERIFICATION_STATUS.UNSUPPORTED,
		VERIFICATION_STATUS.CONFLICTING,
		VERIFICATION_STATUS.VERIFICATION_BLOCKED,
	].includes(canonicalVerificationStatus(status));
}
