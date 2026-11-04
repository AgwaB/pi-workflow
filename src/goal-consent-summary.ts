/**
 * Human-readable consent summaries. The consent itself stays bound to the full
 * preview object (shown verbatim on request); these summaries only decide what
 * fits on one screen above the choices.
 */

const LINE_WIDTH = 160;
const MIN_WIDTH = 60;
/** The width the current formatter call wraps to (see withWidth). */
let lineWidth = LINE_WIDTH;

/**
 * Run a formatter at a terminal width: text pre-wrapped wider than the
 * terminal would be wrapped a second time by Pi, losing the hanging indents.
 */
function withWidth<T>(width: number | undefined, format: () => T): T {
	const previous = lineWidth;
	lineWidth = Math.max(MIN_WIDTH, Math.min(LINE_WIDTH, Math.floor(width ?? LINE_WIDTH)));
	try { return format(); } finally { lineWidth = previous; }
}
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
const clip = (value: string, width = lineWidth): string =>
	value.length <= width ? value : `${value.slice(0, width - 1)}…`;

/** A cost cap in micros (millionths of a dollar) as dollars: $0.50, $0.0025. */
export function formatCostCap(micros: number): string {
	const dollars = micros / 1_000_000;
	const fixed = dollars.toFixed(6).replace(/0+$/u, "");
	const [whole, fraction = ""] = fixed.split(".");
	return `$${whole}.${fraction.padEnd(2, "0")}`;
}

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
export function formatGoalExecutionConsent(preview: unknown, width?: number): string {
	return withWidth(width, () => executionConsent(preview));
}

function executionConsent(preview: unknown): string {
	if (!isRecord(preview) || !isRecord(preview.definition) || !isRecord(preview.definition.goal))
		return "The preview could not be summarized; open the full details before deciding.";
	const definition = preview.definition;
	const goal = definition.goal as Json;
	const lines: string[] = [];
	lines.push(clip(`Goal: ${text(definition.name) || "(unnamed)"}`));
	lines.push(`Objective (saved in the definition): ${wrap(text(goal.objective), lineWidth - 37, OBJECTIVE_LINES,
		" ".repeat(37)).join("\n")}`);
	const target = runTarget(preview);
	if (target) lines.push(clip(`This run (your request): ${oneLine(target)}`));
	const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
	lines.push(criteria.length === 1 ? "Done when this criterion holds:" : `Done when all ${criteria.length} criteria hold:`);
	for (const criterion of criteria.slice(0, MAX_CRITERIA)) lines.push(clip(`  ${describeCriterion(criterion)}`));
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
		`cost: ${typeof limits.costMicros === "number" ? formatCostCap(limits.costMicros) : "no cap"}`,
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
	lines.push(...wrap("After you confirm, the Goal plans, works, verifies and retries within this scope without asking again.",
		lineWidth, 3, ""));
	return lines.join("\n");
}

function runTarget(preview: Json): string {
	const request = text(preview.request);
	return request.includes("\n\nTarget: ") ? request.slice(request.lastIndexOf("\n\nTarget: ") + 10) : "";
}

const EXCLUSION_LABELS: Record<string, string> = {
	deployment: "deploying or publishing anything",
	credentials: "reading or using credentials",
	"protected-backend-qualification": "the retired protected Goal backend",
	"origin-apply": "changing your working tree",
	"arbitrary-commands": "running commands other than the ones written in the criteria",
	"cost-accounting": "authoritative cost accounting (costs shown are estimates)",
	"child-family-budget-accounting": "separate budgets for child workflows (they share this Goal's limits)",
	"non-deterministic-replan": "reproducible replanning (each replan is a new model decision)",
};

const ROLE_LABELS: Record<string, string> = {
	planning: "planning",
	"research-execution": "work",
	synthesis: "synthesis",
	verification: "checking (rubric)",
	"final-judgment": "final judgment",
};

function indentWrap(value: string, indent: string, width = lineWidth): string[] {
	return wrap(value, width - indent.length, 1_000, indent).map((line, index) => (index === 0 ? `${indent}${line}` : line));
}

function describeCriterionDetails(criterion: unknown, index: number): string[] {
	if (!isRecord(criterion) || !isRecord(criterion.verifier)) return [`  ${index}. (unreadable criterion)`];
	const verifier = criterion.verifier;
	const config = isRecord(verifier.config) ? verifier.config : {};
	const subject = isRecord(verifier.subject) ? verifier.subject : {};
	const lines = [`  ${index}. ${text(criterion.id) || "(unnamed)"}`];
	const looksAt = `${text(subject.resultSlot) || "result"}${text(subject.path) ? ` → ${text(subject.path)}` : ""}`;
	if (verifier.producerId === "command-exit-v1") {
		const argv = Array.isArray(config.argv) ? config.argv.map(String).join(" ") : "";
		lines.push("     Checked by: running a command on a sandboxed copy of your working tree with the candidate changes",
			`     Command: ${argv}`,
			`     Working directory: ${text(config.cwd) || "."} · time limit ${Math.round(Number(config.timeoutMs ?? 120_000) / 1000)} s`,
			"     Met when: the command exits with code 0 (no network; it can write only inside the copy)");
	} else if (verifier.kind === "model-rubric") {
		const rubric = isRecord(config.rubric) ? config.rubric : {};
		lines.push(`     Checked by: a model scoring the result (needs score ${typeof config.minScore === "number" ? config.minScore : 1}) against:`,
			...indentWrap(text(rubric.instruction) || text(rubric.statement), "       "),
			`     Looks at: ${looksAt}`);
	} else if (verifier.kind === "human") {
		const condition = isRecord(config.condition) ? Object.values(config.condition).map(String).join("; ") : "";
		lines.push("     Checked by: you, with /workflow goal judge <runId> when the Goal waits for you",
			...indentWrap(`Condition: ${condition || "accept or reject"}`, "     "));
	} else if (verifier.producerId === "json-exact-value-v1") {
		lines.push(`     Checked by: comparing an exact value (${looksAt})`,
			...indentWrap(`Expected: ${JSON.stringify(config.expected)}`, "     "));
	} else {
		lines.push(`     Checked by: ${text(verifier.kind)} (${text(verifier.producerId)})`);
	}
	return lines;
}

/**
 * The complete Goal preview in plain language, for "Show full details". The
 * exact JSON the consent is bound to follows at the end.
 */
export function formatGoalExecutionDetails(preview: unknown, width?: number): string {
	return withWidth(width, () => executionDetails(preview));
}

function executionDetails(preview: unknown): string {
	const raw = JSON.stringify(preview, null, 2);
	if (!isRecord(preview) || !isRecord(preview.definition) || !isRecord(preview.definition.goal))
		return `The preview could not be described; its exact content follows.\n\n${raw}`;
	const definition = preview.definition;
	const goal = definition.goal as Json;
	const lines: string[] = [`Goal: ${text(definition.name) || "(unnamed)"}`, "",
		"Objective (saved in the definition)", ...indentWrap(text(goal.objective), "  ")];
	const target = runTarget(preview);
	if (target) lines.push("", "This run (your request)", ...indentWrap(target, "  "));
	const criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
	lines.push("", `Completion criteria — the Goal is achieved only when ${criteria.length === 1 ? "this holds" : `all ${criteria.length} hold`}`);
	criteria.forEach((criterion, index) => lines.push(...describeCriterionDetails(criterion, index + 1)));
	const authority = isRecord(goal.authority) ? goal.authority : {};
	const allowed = Array.isArray(authority.allowedPaths) ? authority.allowedPaths.map(String) : [];
	const protectedPaths = Array.isArray(authority.protectedPaths) ? authority.protectedPaths.map(String) : [];
	const effects = Array.isArray(authority.allowedEffects) ? authority.allowedEffects.map(String) : [];
	const workflows = Array.isArray(preview.workflows) ? preview.workflows.filter(isRecord) : [];
	lines.push("", "Scope",
		`  May change: ${allowed.length ? allowed.join(", ") : "nothing (no file paths)"}`,
		`  Protected (never changed): ${protectedPaths.length ? protectedPaths.join(", ") : "none"}`,
		"  Allowed:", ...effects
			.filter((effect) => effect !== "workflow-create" || workflows.length > 0)
			.map((effect) => `    • ${EFFECT_LABELS[effect] ?? effect}`));
	const exclusions = Array.isArray(preview.exclusions) ? preview.exclusions.map(String) : [];
	if (exclusions.length)
		lines.push("  Not part of this consent:", ...exclusions.map((item) => `    • ${EXCLUSION_LABELS[item] ?? item}`));
	const profile = isRecord(preview.profile) ? preview.profile : {};
	const roles = Array.isArray(profile.roles) ? profile.roles.filter(isRecord) : [];
	const defaults = isRecord(definition.defaults) ? definition.defaults : {};
	lines.push("", `Models (profile ${text(profile.name) || "unknown"})`,
		...roles.map((role) => `  ${(ROLE_LABELS[text(role.role)] ?? text(role.role)).padEnd(18)} ${text(role.model)} · ${text(role.thinking)}`),
		`  Fast: ${defaults.fast === "on" ? "on (OpenAI priority tier for every request)" : "off"}`);
	const limits = isRecord(goal.limits) ? goal.limits : {};
	const nesting = isRecord(goal.nesting) ? goal.nesting : {};
	lines.push("", "Limits",
		`  Model requests: ${limitText(limits.requests)} · estimated cost: ${typeof limits.costMicros === "number" ? formatCostCap(limits.costMicros) : "no cap"}`,
		`  Attempts (first plan + replans): ${limitText(preview.generationLimit)}`,
		`  Nested Goal depth: ${typeof nesting.maxDepth === "number" ? nesting.maxDepth : 3}`);
	if (workflows.length) {
		lines.push("", "Child workflows the Goal may run");
		for (const child of workflows) {
			const childDefinition = isRecord(child.definition) ? child.definition : {};
			const childGoal = isRecord(childDefinition.goal) ? childDefinition.goal : undefined;
			lines.push(`  • ${text(child.id)} — ${childGoal ? "Goal" : "workflow"} ${text(childDefinition.name)} (${text(child.uses)})`);
			if (childGoal) lines.push(...indentWrap(`Objective: ${text(childGoal.objective)}`, "      "));
		}
	}
	if (isRecord(preview.recovery)) {
		const recovery = preview.recovery;
		const carried = Array.isArray(recovery.carriedCandidate) ? recovery.carriedCandidate.map(String) : [];
		lines.push("", `Recovery of ${text(recovery.fromRunId)}`,
			`  Counts its ${recovery.priorGenerations ?? 0} attempt(s) and ${recovery.priorRequests ?? 0} request(s) against the limits`,
			`  ${carried.length ? `Starts from its last candidate: ${carried.join(", ")}` : "Starts from the working tree"}`);
		const feedback = Array.isArray(recovery.feedbackCriteria) ? recovery.feedbackCriteria.map(String) : [];
		if (feedback.length) lines.push(`  Last verdicts passed to the planner: ${feedback.join(", ")}`);
	}
	lines.push("", "After you confirm, the Goal plans, works, verifies and retries within this scope without asking again.");
	return [...lines.flatMap(fitLine), "", "─".repeat(40), "Exact preview this consent is bound to (JSON)", raw].join("\n");
}

/** Wrap one long line under its own indent (and after a bullet or number). */
function fitLine(line: string): string[] {
	if (line.length <= lineWidth) return [line];
	const lead = /^(\s*)((?:•|\d+\.)\s+)?/u.exec(line)!;
	const indent = " ".repeat(lead[0].length || 2);
	const first = line.slice(lead[0].length);
	return [lead[0] + wrap(first, lineWidth - lead[0].length, 1_000, indent).join("\n")].flatMap(part => part.split("\n"));
}

/** One-screen summary of a Goal profile-exception preview. */
export function formatGoalProfileExceptionConsent(preview: unknown, width?: number): string {
	return withWidth(width, () => profileExceptionConsent(preview));
}

function profileExceptionConsent(preview: unknown): string {
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
