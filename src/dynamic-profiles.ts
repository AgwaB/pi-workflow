export const DYNAMIC_OUTPUT_PROFILES = [
	"candidate_findings_v1",
	"verification_result_v1",
	"coverage_assessment_v1",
	"generic_summary_v1",
	"synthesis_v1",
] as const;

export type DynamicOutputProfile = (typeof DYNAMIC_OUTPUT_PROFILES)[number];

export const DYNAMIC_EXTRACTABLE_OUTPUT_PROFILES = [
	"candidate_findings_v1",
	"verification_result_v1",
	"coverage_assessment_v1",
	"generic_summary_v1",
] as const satisfies readonly DynamicOutputProfile[];

export const DYNAMIC_TERMINAL_OUTPUT_PROFILES = [
	"synthesis_v1",
] as const satisfies readonly DynamicOutputProfile[];

const OUTPUT_PROFILE_SET = new Set<string>(DYNAMIC_OUTPUT_PROFILES);
const EXTRACTABLE_OUTPUT_PROFILE_SET = new Set<string>(
	DYNAMIC_EXTRACTABLE_OUTPUT_PROFILES,
);
const TERMINAL_OUTPUT_PROFILE_SET = new Set<string>(
	DYNAMIC_TERMINAL_OUTPUT_PROFILES,
);

export function isDynamicOutputProfile(
	value: unknown,
): value is DynamicOutputProfile {
	return typeof value === "string" && OUTPUT_PROFILE_SET.has(value);
}

export function isExtractableDynamicOutputProfile(
	value: unknown,
): value is (typeof DYNAMIC_EXTRACTABLE_OUTPUT_PROFILES)[number] {
	return typeof value === "string" && EXTRACTABLE_OUTPUT_PROFILE_SET.has(value);
}

export function isTerminalDynamicOutputProfile(
	value: unknown,
): value is (typeof DYNAMIC_TERMINAL_OUTPUT_PROFILES)[number] {
	return typeof value === "string" && TERMINAL_OUTPUT_PROFILE_SET.has(value);
}

export function dynamicOutputProfileValues(): string[] {
	return [...DYNAMIC_OUTPUT_PROFILES];
}
