import seed from "./seed.json" with { type: "json" };

const EXPECTED_SEED = Object.freeze({
	schema: "built-engine-frozen-bundle-seed-v1",
	campaignId: "paid-campaign-regression",
	holdoutAccess: false,
	audience: ["alpha", "bravo"],
	nonce: "seed-20260716",
});

const RECEIPT = Object.freeze({
	schema: "built-engine-frozen-bundle-guard-receipt-v1",
	digest: "frozen-bundle-pass",
	seedCampaignId: EXPECTED_SEED.campaignId,
	seedNonce: EXPECTED_SEED.nonce,
	providerDispatch: "shutdown-before-provider-send",
});

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function validateFrozenBundleGuard() {
	if (stableJson(seed) !== stableJson(EXPECTED_SEED)) {
		throw new Error("frozen bundle seed content mismatch");
	}
	return { ...RECEIPT };
}

export default function generatedFrozenBundleGuardExtension() {
	return validateFrozenBundleGuard();
}
