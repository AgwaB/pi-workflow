export const DYNAMIC_OUTPUT_PROFILES = [
	"candidate_findings_v1",
	"verification_result_v1",
	"coverage_assessment_v1",
	"generic_summary_v1",
	"synthesis_v1",
] as const;

export type DynamicOutputProfile = (typeof DYNAMIC_OUTPUT_PROFILES)[number];

const OUTPUT_PROFILE_SET = new Set<string>(DYNAMIC_OUTPUT_PROFILES);

export function isDynamicOutputProfile(
	value: unknown,
): value is DynamicOutputProfile {
	return typeof value === "string" && OUTPUT_PROFILE_SET.has(value);
}

export function dynamicOutputProfileValues(): DynamicOutputProfile[] {
	return [...DYNAMIC_OUTPUT_PROFILES];
}
