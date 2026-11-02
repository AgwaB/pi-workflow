import { assertGoalHostSessionIssuer, type GoalHostSessionIssuer, type GoalHostSessionLease } from "./goal-host-session.js";

/**
 * Live interactive session binding for ordinary workflow-engine Goals.
 *
 * It issues opaque, process-local tokens bound to the current host session
 * lease. Tokens are never serialized and grant no execution authority by
 * themselves; a token stops validating once its lease is no longer current.
 */
export interface WorkflowGoalEngineRuntime {
	captureWorkflowEngineSession(): object;
	assertWorkflowEngineSession(token: object): void;
}

const runtimes = new WeakSet<object>();
const runtimesBySession = new WeakMap<GoalHostSessionIssuer, WorkflowGoalEngineRuntime>();

/** One runtime per session issuer, so repeated installation keeps one identity. */
export function createWorkflowGoalEngineRuntime(session: GoalHostSessionIssuer): WorkflowGoalEngineRuntime {
	assertGoalHostSessionIssuer(session);
	const prior = runtimesBySession.get(session);
	if (prior) return prior;
	const leases = new WeakMap<object, GoalHostSessionLease>();
	const runtime: WorkflowGoalEngineRuntime = Object.freeze({
		captureWorkflowEngineSession(): object {
			const lease = session.currentLease();
			session.assertCurrent(lease);
			const token = Object.freeze(Object.create(null));
			leases.set(token, lease);
			return token;
		},
		assertWorkflowEngineSession(token: object): void {
			const lease = leases.get(token);
			if (!lease) throw new Error("Goal workflow engine session admission unavailable");
			session.assertCurrent(lease);
		},
	});
	runtimes.add(runtime);
	runtimesBySession.set(session, runtime);
	return runtime;
}

export function assertWorkflowGoalEngineRuntime(value: unknown): asserts value is WorkflowGoalEngineRuntime {
	if (!value || typeof value !== "object" || !runtimes.has(value))
		throw new Error("Goal workflow engine runtime is not an original live session runtime");
}
