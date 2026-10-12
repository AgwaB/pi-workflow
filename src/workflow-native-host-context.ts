import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./pi-agent-dir.js";

/** References only: never persist resolved MCP configuration or credentials. */
export interface WorkflowNativeHostContext {
	version: 1;
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

export const WORKFLOW_NATIVE_HOST_CONTEXT_ENV =
	"PI_WORKFLOW_NATIVE_HOST_CONTEXT";

interface WorkflowNativeHostSessionKey {
	getSessionId(): string;
}
type WorkflowNativeHostCaptureKind = "host" | "inherited";
interface WorkflowNativeHostCapture {
	kind: WorkflowNativeHostCaptureKind;
	context: WorkflowNativeHostContext;
}
interface WorkflowNativeHostSession {
	runtimeCwd: string;
	sessionId: string;
	captures: Map<symbol, WorkflowNativeHostCapture>;
}

// A session manager is the documented identity-bearing object on ExtensionContext.
// Keep it only as an opaque WeakMap key; never retain an ExtensionContext itself.
const sessions = new WeakMap<
	WorkflowNativeHostSessionKey,
	WorkflowNativeHostSession
>();
const sessionsByCwd = new Map<string, Set<WorkflowNativeHostSession>>();
const activeSessionContext = new AsyncLocalStorage<WorkflowNativeHostContext | null>();
const noopRelease = (): void => undefined;

export function assertWorkflowNativeHostContext(
	value: unknown,
): asserts value is WorkflowNativeHostContext {
	if (
		value === null ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("cwd" in value) ||
		typeof value.cwd !== "string" ||
		!isAbsolute(value.cwd) ||
		!("agentDir" in value) ||
		typeof value.agentDir !== "string" ||
		!isAbsolute(value.agentDir) ||
		!("projectTrusted" in value) ||
		typeof value.projectTrusted !== "boolean" ||
		Object.keys(value).some(
			(key) => !["version", "cwd", "agentDir", "projectTrusted"].includes(key),
		)
	)
		throw new Error("Invalid workflow native host context");
}

function workflowNativeHostSessionIdentity(
	ctx: ExtensionContext,
): { key: WorkflowNativeHostSessionKey; sessionId: string } | undefined {
	const manager = (ctx as ExtensionContext & { sessionManager?: unknown })
		.sessionManager;
	if (manager === null || typeof manager !== "object") return undefined;
	const getSessionId = (manager as { getSessionId?: unknown }).getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	const key = manager as WorkflowNativeHostSessionKey;
	const sessionId = key.getSessionId();
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	return { key, sessionId };
}

function sameWorkflowNativeHostContext(
	left: WorkflowNativeHostContext,
	right: WorkflowNativeHostContext,
): boolean {
	return (
		left.version === right.version &&
		left.cwd === right.cwd &&
		left.agentDir === right.agentDir &&
		left.projectTrusted === right.projectTrusted
	);
}

function effectiveWorkflowNativeHostSessionContext(
	session: WorkflowNativeHostSession,
): WorkflowNativeHostContext {
	const captures = [...session.captures.values()];
	const inherited = captures.filter((capture) => capture.kind === "inherited");
	const candidates = inherited.length > 0 ? inherited : captures;
	const selected = candidates[0]?.context;
	if (selected === undefined) {
		throw new Error(
			`Workflow native host context is not bound for Pi session ${session.sessionId}`,
		);
	}
	if (
		candidates.some(
			(capture) => !sameWorkflowNativeHostContext(selected, capture.context),
		)
	) {
		throw new Error(
			`Conflicting workflow native host contexts for Pi session ${session.sessionId}`,
		);
	}
	return selected;
}

function removeWorkflowNativeHostSession(
	key: WorkflowNativeHostSessionKey,
	session: WorkflowNativeHostSession,
): void {
	if (sessions.get(key) !== session) return;
	sessions.delete(key);
	const cwdSessions = sessionsByCwd.get(session.runtimeCwd);
	cwdSessions?.delete(session);
	if (cwdSessions?.size === 0) sessionsByCwd.delete(session.runtimeCwd);
}

/**
 * Bind native-host references to one live Pi session. The returned release is
 * idempotent and must be called from that extension runtime's session_shutdown.
 */
export function captureWorkflowNativeHostContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	inherited?: WorkflowNativeHostContext,
): () => void {
	// Old Pi hosts keep their existing launch behavior.
	const host = pi as ExtensionAPI & { getMcpServers?: unknown };
	const context = ctx as ExtensionContext & { isProjectTrusted?: () => boolean };
	if (
		typeof host.getMcpServers !== "function" ||
		typeof context.isProjectTrusted !== "function"
	)
		return noopRelease;
	const identity = workflowNativeHostSessionIdentity(ctx);
	if (identity === undefined) return noopRelease;

	let nativeHost: WorkflowNativeHostContext;
	if (inherited === undefined) {
		nativeHost = {
			version: 1,
			cwd: resolve(ctx.cwd),
			agentDir: resolve(piAgentDir()),
			projectTrusted: context.isProjectTrusted(),
		};
	} else {
		assertWorkflowNativeHostContext(inherited);
		nativeHost = { ...inherited };
	}

	const runtimeCwd = resolve(ctx.cwd);
	let session = sessions.get(identity.key);
	if (session !== undefined &&
		(session.runtimeCwd !== runtimeCwd || session.sessionId !== identity.sessionId)) {
		// Pi may reuse its session manager for /new or a session switch. Retire
		// the old generation; its later release callbacks cannot clear the new one.
		removeWorkflowNativeHostSession(identity.key, session);
		session = undefined;
	}
	if (session === undefined) {
		session = {
			runtimeCwd,
			sessionId: identity.sessionId,
			captures: new Map(),
		};
		sessions.set(identity.key, session);
		const cwdSessions = sessionsByCwd.get(runtimeCwd) ?? new Set();
		cwdSessions.add(session);
		sessionsByCwd.set(runtimeCwd, cwdSessions);
	}

	const token = Symbol("workflow-native-host-context");
	session.captures.set(token, {
		kind: inherited === undefined ? "host" : "inherited",
		context: nativeHost,
	});
	const capturedSession = session;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		capturedSession.captures.delete(token);
		if (capturedSession.captures.size === 0) {
			removeWorkflowNativeHostSession(identity.key, capturedSession);
		}
	};
}

/** Run one launch boundary with the exact native context of its Pi session. */
export function withWorkflowNativeHostContext<T>(
	ctx: ExtensionContext,
	operation: () => T,
): T {
	const identity = workflowNativeHostSessionIdentity(ctx);
	if (identity === undefined) return activeSessionContext.run(null, operation);
	const session = sessions.get(identity.key);
	if (session === undefined) return activeSessionContext.run(null, operation);
	if (
		session.runtimeCwd !== resolve(ctx.cwd) ||
		session.sessionId !== identity.sessionId
	) {
		throw new Error(
			"Pi session identity changed while resolving workflow native host context",
		);
	}
	return activeSessionContext.run(
		{ ...effectiveWorkflowNativeHostSessionContext(session) },
		operation,
	);
}

/** Freeze a direct launch's host decision, including absence, across async work. */
export function withResolvedWorkflowNativeHostContext<T>(
	cwd: string,
	operation: () => T,
): T {
	return activeSessionContext.run(
		resolveWorkflowNativeHostContext(cwd) ?? null,
		operation,
	);
}

export function resolveWorkflowNativeHostContext(
	cwd: string,
): WorkflowNativeHostContext | undefined {
	const active = activeSessionContext.getStore();
	if (active !== undefined) return active === null ? undefined : { ...active };

	// Direct callers can resolve an unambiguous live cwd. Different contexts at
	// one cwd require withWorkflowNativeHostContext rather than a guessed winner.
	const cwdSessions = sessionsByCwd.get(resolve(cwd));
	let selected: WorkflowNativeHostContext | undefined;
	if (cwdSessions !== undefined) {
		for (const session of cwdSessions) {
			const candidate = effectiveWorkflowNativeHostSessionContext(session);
			if (selected === undefined) selected = candidate;
			else if (!sameWorkflowNativeHostContext(selected, candidate)) {
				throw new Error(
					"Ambiguous workflow native host context for concurrently bound Pi sessions",
				);
			}
		}
		if (selected !== undefined) return { ...selected };
	}

	// Immutable process-start transport remains an old-host/headless fallback.
	// Session extensions never write this variable.
	const inherited = process.env[WORKFLOW_NATIVE_HOST_CONTEXT_ENV];
	if (inherited === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(inherited);
	} catch {
		throw new Error("Invalid workflow native host context");
	}
	assertWorkflowNativeHostContext(value);
	return { ...value };
}

export function buildWorkflowNativeHostExtensionWrapper(options: {
	importPath: string;
	config: WorkflowNativeHostContext;
}): string {
	assertWorkflowNativeHostContext(options.config);
	return `import { registerWorkflowNativeHost } from ${JSON.stringify(options.importPath)};\nexport default async function (pi) {\n  await registerWorkflowNativeHost(pi, ${JSON.stringify(options.config)});\n}\n`;
}

export function workflowNativeLaunchTools(
	tools: readonly string[] | undefined,
	nativeHost: WorkflowNativeHostContext | undefined,
): string[] | undefined {
	if (nativeHost === undefined || tools?.length === 0)
		return tools === undefined ? undefined : [...tools];
	// Preserve the ordinary tool selection; do not turn a read-only stage into a shell stage.
	return [
		...new Set([
			...(tools ?? ["read", "bash", "edit", "write"]),
			"codemode",
			"tool_search",
			"mcp__*",
			"list_mcp_resources",
			"list_mcp_resource_templates",
			"read_mcp_resource",
		]),
	];
}
