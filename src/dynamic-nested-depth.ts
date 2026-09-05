import { readDynamicEvents } from "./dynamic-events.js";
import { readRunRecord } from "./store.js";

/** Remaining descendant edges, relative to this controller and every ancestor.
 * The parent-owned ledger identifies the launching controller; child-authored
 * configuration, projection caches and rootRunId are not depth authority.
 * Incomplete legacy ancestry is readable, but cannot authorize new descendants.
 */
export async function remainingDynamicNestedWorkflowDepth(
	cwd: string,
	runId: string,
	configuredDepth: number,
): Promise<number> {
	let remaining = configuredDepth;
	let distance = 0;
	const visited = new Set<string>();
	try {
		while (true) {
			if (visited.has(runId)) return 0;
			visited.add(runId);
			const run = await readRunRecord(cwd, runId);
			if (run.runId !== runId) return 0;
			if (!run.parentRunId) {
				if (run.rootRunId && run.rootRunId !== runId) return 0;
				return Math.max(0, remaining);
			}
			const events = await readDynamicEvents(cwd, run.parentRunId);
			const starts = events.filter(
				(event) =>
					event.type === "workflow.started" && event.payload.runId === runId,
			);
			const owners = new Set(starts.map((event) => event.controllerSpecId));
			if (owners.size !== 1) return 0;
			const owner = starts[0].controllerSpecId;
			const initializations = events.filter(
				(event) =>
					event.type === "controller.initialized" &&
					event.controllerSpecId === owner &&
					event.seq < starts[0].seq,
			);
			if (initializations.length !== 1) return 0;
			const budget = initializations[0].payload.budget as
				| { maxNestedWorkflowDepth?: unknown }
				| undefined;
			const limit = budget?.maxNestedWorkflowDepth;
			if (
				typeof limit !== "number" ||
				!Number.isSafeInteger(limit) ||
				limit < 0
			) return 0;
			distance += 1;
			remaining = Math.min(remaining, limit - distance);
			runId = run.parentRunId;
		}
	} catch {
		// Missing/pruned/corrupt ancestry must not fall back to a child's limit.
		return 0;
	}
}

/** Historical maximum descendant depth, not the number of sibling launches.
 * Include durable reservations even before the child record exists. This is
 * observational only: remaining depth is derived from ancestry above.
 */
export async function observedDynamicNestedWorkflowDepth(
	cwd: string,
	runId: string,
	childRunIds: readonly string[],
): Promise<number> {
	const visited = new Set([runId]);
	const pending = childRunIds.map((child) => ({ runId: child, depth: 1 }));
	let deepest = 0;
	while (pending.length > 0) {
		const child = pending.pop()!;
		if (visited.has(child.runId)) continue;
		visited.add(child.runId);
		deepest = Math.max(deepest, child.depth);
		const record = await readRunRecord(cwd, child.runId).catch(() => undefined);
		if (!record) continue;
		const events = await readDynamicEvents(cwd, child.runId);
		for (const event of events) {
			if (
				event.type !== "workflow.started" ||
				typeof event.payload.runId !== "string"
			) continue;
			pending.push({ runId: event.payload.runId, depth: child.depth + 1 });
		}
	}
	return deepest;
}
