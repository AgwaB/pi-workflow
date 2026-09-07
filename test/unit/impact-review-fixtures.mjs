export const impactLedgerStages = [
	"change-scope",
	"implementation-map",
	"validation-map",
	"api-contract-impact",
	"state-data-impact",
	"validation-impact",
	"docs-release-impact",
	"security-performance-impact",
	"contract-consistency",
	"regression-risk",
	"ship-readiness",
	"impact-synthesis",
];

export const impactOriginalFields = {
	"change-scope": ["changeInputs", "affectedFiles", "affectedComponents", "publicSurfaces", "assumptions", "outOfScope"],
	"implementation-map": ["components", "entryPoints", "dataFlows", "unknowns"],
	"validation-map": ["tests", "docs", "releaseArtifacts", "validationCommandsMentioned", "knownGaps"],
	"validation-impact": ["coveredAreas", "missingValidation", "recommendedCommands", "assumptions"],
	"api-contract-impact": ["impacts", "assumptions"],
	"state-data-impact": ["impacts", "assumptions"],
	"docs-release-impact": ["impacts", "assumptions"],
	"security-performance-impact": ["impacts", "assumptions"],
	"contract-consistency": ["issues", "confirmedConsistencies"],
	"regression-risk": ["risks", "riskReducers"],
	"ship-readiness": ["requiredBeforeShip", "niceToHave", "assumptions"],
	"impact-synthesis": ["blockingIssues", "nonBlockingIssues", "confirmedSafeAreas", "recommendedNextActions", "validationToRun", "needsHuman"],
};

export function impactSourceStatuses({ statusByStage = {}, taskPrefix = "task-" } = {}) {
	return impactLedgerStages.map((stage, index) => ({
		source: `impact-analysis.${stage}`,
		specId: `impact-analysis.${stage}.main`,
		stageId: stage,
		taskId: `${taskPrefix}${index + 1}`,
		status: statusByStage[stage] ?? "completed",
	}));
}

export function blankImpactSource(stage, overrides = {}) {
	const value = {
		schema: "stage-control-v1",
		digest: `${stage}-digest`,
	};
	for (const field of impactOriginalFields[stage] ?? []) value[field] = [];
	return Object.assign(value, overrides);
}

export function blankImpactSources(overrides = {}) {
	return Object.fromEntries(
		impactLedgerStages.map((stage) => [
			`impact-analysis.${stage}`,
			blankImpactSource(stage, overrides[stage] ?? {}),
		]),
	);
}
