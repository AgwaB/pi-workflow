/**
 * Human-readable consent summaries. The consent itself stays bound to the full
 * preview object (shown verbatim on request); these summaries only decide what
 * fits on one screen above the choices.
 */

const LINE_WIDTH = 160;
const OBJECTIVE_LINES = 3;
const MAX_CRITERIA = 6;

export const GOAL_CONSENT_RUN = "Run this Goal";
export const GOAL_CONSENT_APPLY_EXCEPTION = "Apply this profile exception";
export const GOAL_CONSENT_DETAILS = "Show full details";
export const GOAL_CONSENT_CANCEL = "Cancel";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();
const clip = (value: string, width = LINE_WIDTH): string =>
	value.length <= width ? value : `${value.slice(0, width - 1)}…`;

/** Wrap prose to at most `lines` lines of `width`, marking the cut. */
function wrap(value: string, width: number, lines: number, indent: string): string[] {
	const words = oneLine(value).split(" ").filter(Boolean);
	const out: string[] = [];
	let current = "";
	for (const word of words) {
		if (current && current.length + 1 + word.length > width) {
			out.push(current);
			current = word;
		} else current = current ? `${current} ${word}` : word;
	}
	if (current) out.push(current);
	if (out.length > lines) {
		out.length = lines;
		out[lines - 1] = clip(`${out[lines - 1]} …`, width);
	}
	return out.map((line, index) => (index === 0 ? line : `${indent}${line}`));
}

function seconds(ms: unknown): string {
	return typeof ms === "number" && Number.isFinite(ms) ? ` (timeout ${Math.round(ms / 1000)}s)` : "";
}

function describeCriterion(criterion: unknown): string {
	if (!isRecord(criterion) || !isRecord(criterion.verifier)) return "• (unreadable criterion)";
	const id = text(criterion.id) || "(unnamed)";
	const verifier = criterion.verifier;
	const config = isRecord(verifier.config) ? verifier.config : {};
	const subject = isRecord(verifier.subject) ? verifier.subject : {};
	const slot = text(subject.resultSlot);
	const at = text(subject.path) ? ` at ${text(subject.path)}` : "";
	let what: string;
	if (verifier.producerId === "command-exit-v1") {
		const argv = Array.isArray(config.argv) ? config.argv.map(String).join(" ") : "";
		const cwd = text(config.cwd) ? ` in ${text(config.cwd)}` : "";
		what = `command passes: ${argv}${cwd}${seconds(config.timeoutMs ?? 120_000)}`;
	} else if (verifier.kind === "model-rubric") {
		const rubric = isRecord(config.rubric) ? config.rubric : {};
		const statement = text(rubric.instruction) || text(rubric.statement);
		const min = typeof config.minScore === "number" ? `, min score ${config.minScore}` : "";
		what = `model rubric${min}: ${oneLine(statement)}`;
	} else if (verifier.kind === "human") {
		const condition = isRecord(config.condition) ? Object.values(config.condition).map(String).join("; ") : "";
		what = `your judgment: ${oneLine(condition) || "accept or reject"}`;
	} else if (verifier.producerId === "json-exact-value-v1") {
		what = `exact value${at} = ${clip(JSON.stringify(config.expected) ?? "", 60)}`;
	} else {
		what = `${text(verifier.kind) || "check"} (${text(verifier.producerId)})`;
	}
	return clip(`• ${id}${slot && slot !== "result" ? ` [${slot}]` : ""} — ${what}`);
}

const EFFECT_LABELS: Record<string, string> = {
	read: "read",
	"candidate-write": "write in a separate candidate copy",
	verify: "verify",
	"origin-apply": "apply verified changes to your working tree",
	"workflow-create": "run declared child workflows",
};

/** Plain-language effects; running child workflows is listed only when some are declared. */
export function describeGoalEffects(effects: readonly string[], hasChildWorkflows: boolean): string {
	return effects
		.filter((effect) => effect !== "workflow-create" || hasChildWorkflows)
		.map((effect) => EFFECT_LABELS[effect] ?? effect)
		.join(", ");
}

function describeModels(profile: unknown): string {
	if (!isRecord(profile) || !Array.isArray(profile.roles)) return "(unknown)";
	const roles = profile.roles.filter(isRecord).map((role) => ({
		role: text(role.role),
		runtime: `${text(role.model)} · ${text(role.thinking)}`,
	}));
	const distinct = [...new Set(roles.map((role) => role.runtime))];
	if (distinct.length === 1) return `all roles ${distinct[0]}`;
	return roles.map((role) => `${role.role} ${role.runtime}`).join("; ");
}

function limitText(value: unknown, unit = ""): string {
	return typeof value === "number" ? `${value}${unit}` : "no cap";
}

/** One-screen summary of a Goal execution preview. */
export function formatGoalExecutionConsent(preview: unknown): string {
	if (!isRecord(preview) || !isRecord(preview.definition) || !isRecord(preview.definition.goal))
		return "The preview could not be summarized; open the full details before deciding.";
	const definition = preview.definition;
	const goal = definition.goal as Json;
	const lines: string[] = [];
	lines.push(clip(`Goal: ${text(definition.name) || "(unnamed)"}`));
	lines.push(`Objective: ${wrap(text(goal.objective), LINE_WIDTH - 11, OBJECTIVE_LINES, "           ").join("\n")}`);
	const request = text(preview.request);
	const target = request.includes("\n\nTarget: ") ? request.slice(request.lastIndexOf("\n\nTarget: ") + 10) : "";
	if (target) lines.push(clip(`This run: ${oneLine(target)}`));
	const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
	lines.push(criteria.length === 1 ? "Done when this criterion holds:" : `Done when all ${criteria.length} criteria hold:`);
	for (const criterion of criteria.slice(0, MAX_CRITERIA)) lines.push(`  ${describeCriterion(criterion)}`);
	if (criteria.length > MAX_CRITERIA) lines.push(`  … and ${criteria.length - MAX_CRITERIA} more (see full details)`);
	const authority = isRecord(goal.authority) ? goal.authority : {};
	const allowed = Array.isArray(authority.allowedPaths) ? authority.allowedPaths.map(String) : [];
	const protectedPaths = Array.isArray(authority.protectedPaths) ? authority.protectedPaths.map(String) : [];
	const effects = Array.isArray(authority.allowedEffects) ? authority.allowedEffects.map(String) : [];
	lines.push(clip(`May change: ${allowed.length ? allowed.join(", ") : "nothing (no file paths)"}`));
	if (protectedPaths.length) lines.push(clip(`Protected: ${protectedPaths.join(", ")}`));
	const workflows = Array.isArray(preview.workflows) ? preview.workflows.filter(isRecord) : [];
	lines.push(clip(`Allowed: ${describeGoalEffects(effects, workflows.length > 0)}`));
	if (!effects.includes("origin-apply") && effects.includes("candidate-write"))
		lines.push("Results stay in the candidate copy; your working tree is not changed.");
	if (workflows.length)
		lines.push(clip(`Child workflows: ${workflows.map((child) =>
			`${text(child.id)} (${isRecord(child.definition) && "goal" in child.definition ? "Goal" : "workflow"})`).join(", ")}`));
	lines.push(clip(`Models: ${describeModels(preview.profile)}`));
	const limits = isRecord(goal.limits) ? goal.limits : {};
	const defaults = isRecord(definition.defaults) ? definition.defaults : {};
	lines.push(clip([
		`Requests: ${limitText(limits.requests)}`,
		`cost: ${typeof limits.costMicros === "number" ? `${limits.costMicros} micros` : "no cap"}`,
		`attempts (plan + replans): ${limitText(preview.generationLimit)}`,
		...(defaults.fast === "on" ? ["Fast: on (priority tier)"] : []),
	].join(" · ")));
	if (isRecord(preview.recovery)) {
		const recovery = preview.recovery;
		const carried = Array.isArray(recovery.carriedCandidate) ? recovery.carriedCandidate.map(String) : [];
		lines.push(clip(`Recovers ${text(recovery.fromRunId)}: counts its ${recovery.priorGenerations ?? 0} attempt(s) and ` +
			`${recovery.priorRequests ?? 0} request(s); ` +
			(carried.length ? `starts from its last candidate (${carried.join(", ")}).`
				: text(recovery.candidateNotCarried) ? `starts from the working tree (${oneLine(text(recovery.candidateNotCarried))}).`
					: "starts from the working tree.")));
	}
	lines.push("After you confirm, the Goal plans, works, verifies and retries within this scope without asking again.");
	return lines.join("\n");
}

/** One-screen summary of a Goal profile-exception preview. */
export function formatGoalProfileExceptionConsent(preview: unknown): string {
	if (!isRecord(preview)) return "The preview could not be summarized; open the full details before deciding.";
	const runtime = (value: unknown) =>
		isRecord(value) ? `${text(value.model)} · ${text(value.thinking)}` : "(unknown)";
	const target = isRecord(preview.target) ? preview.target : {};
	const scope = isRecord(preview.scope) ? preview.scope : {};
	return [
		clip(`Run: ${text(preview.runId)}`),
		clip(`Task: ${text(target.materializedTaskId) || text(target.template)}${text(scope.role) ? ` (${text(scope.role)})` : ""}`),
		clip(`Change: ${runtime(preview.oldRuntime)} → ${runtime(preview.newRuntime)}`),
		clip(`Reason: ${oneLine(text(preview.reason))}`),
		"Only this task changes; saved profiles, other tasks and shared limits stay as they are.",
	].join("\n");
}

export function isGoalProfileExceptionPreview(preview: unknown): boolean {
	return isRecord(preview) && preview.schema === "workflow-goal-profile-exception-preview-v1";
}
