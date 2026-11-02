import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const goalHostSessionLeaseBrand: unique symbol = Symbol(
	"goal-host-session-lease",
);
const trustedGoalHostSessionIssuers = new WeakSet<object>();

/**
 * Opaque, process-local evidence that a host-installed Pi extension lifecycle
 * callback observed the current foreground session.
 *
 * This is only a session fence. It grants no Goal, broker, workspace, actor,
 * launch, or qualification authority.
 */
export interface GoalHostSessionLease {
	readonly [goalHostSessionLeaseBrand]: never;
}

export type GoalHostSessionFenceReason =
	| "new"
	| "resume"
	| "fork"
	| "tree"
	| "quit"
	| "reload"
	| "lifecycle-mismatch";

/** Serializable notification data is descriptive only and is never authority. */
export interface GoalHostSessionFenceEvent {
	readonly reason: GoalHostSessionFenceReason;
	readonly targetSessionFile?: string;
}

export type GoalHostSessionFence = (
	event: GoalHostSessionFenceEvent,
) => void | Promise<void>;

/**
 * Narrow handle retained by trusted host code installed in the extension
 * factory. `currentLease()` returns an already-minted object; it never mints.
 */
export interface GoalHostSessionIssuer {
	currentLease(): GoalHostSessionLease;
	assertCurrent(lease: unknown): asserts lease is GoalHostSessionLease;
	/** Admit one operation before a lifecycle fence, abort it when fencing starts,
	 * and join both its drain and the immediately-started fence callbacks. */
	runCurrent<T>(
		lease: GoalHostSessionLease,
		action: (fenceSignal: AbortSignal) => Promise<T>,
	): Promise<T>;
	bindFence(lease: GoalHostSessionLease, fence: GoalHostSessionFence): void;
}

/** Process-local identity check; copied methods or structural lookalikes are not issuers. */
export function assertGoalHostSessionIssuer(
	value: unknown,
): asserts value is GoalHostSessionIssuer {
	if (
		value === null ||
		typeof value !== "object" ||
		!trustedGoalHostSessionIssuers.has(value)
	)
		throw new Error("Goal host session issuer is untrusted");
}

type ReadonlySessionManager = ExtensionContext["sessionManager"];

type SessionIdentity = Readonly<{
	manager: ReadonlySessionManager;
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
}>;

type LeaseRecord = {
	readonly lease: GoalHostSessionLease;
	readonly identity: SessionIdentity;
	readonly fences: Set<GoalHostSessionFence>;
	readonly drainWaiters: Set<() => void>;
	readonly fenceController: AbortController;
	valid: boolean;
	inflight: number;
};

type Phase =
	| "awaiting-start"
	| "active"
	| "fenced"
	| "tree-pending"
	| "transition-pending"
	| "closed";

function captureIdentity(ctx: ExtensionContext): SessionIdentity {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	const cwd = manager.getCwd();
	const sessionFile = manager.getSessionFile();
	if (!sessionId || !cwd || cwd !== ctx.cwd)
		throw new Error("Pi foreground session context is inconsistent");
	return Object.freeze({ manager, sessionId, sessionFile, cwd });
}

function identityStillValid(identity: SessionIdentity): boolean {
	try {
		return (
			identity.manager.getSessionId() === identity.sessionId &&
			identity.manager.getSessionFile() === identity.sessionFile &&
			identity.manager.getCwd() === identity.cwd
		);
	} catch {
		return false;
	}
}

function identityMatches(
	identity: SessionIdentity,
	ctx: ExtensionContext,
): boolean {
	return (
		ctx.sessionManager === identity.manager &&
		ctx.cwd === identity.cwd &&
		identityStillValid(identity)
	);
}

/**
 * Install the source-only foreground-session issuer directly on the
 * ExtensionAPI supplied to a trusted Pi extension factory.
 *
 * The boundary is deliberately process-local. Pi extensions are arbitrary
 * same-process code with full system access, so this does not defend against a
 * malicious extension or code that steals this issuer/its exact lease. It only
 * prevents serialized, copied, digested, or old-session values from crossing
 * the session fence. It is not Goal/broker authorization or qualification.
 *
 * Pi 0.84.4 swallows extension-handler exceptions. Consequently every
 * cancellable before-event handler below converts internal/fence failures into
 * `{ cancel: true }`; shutdown cannot be vetoed by Pi, but its lease is made
 * stale synchronously before any asynchronous fence work is awaited.
 */
export function installGoalHostSessionIssuer(
	pi: ExtensionAPI,
): GoalHostSessionIssuer {
	let phase: Phase = "awaiting-start";
	let active: LeaseRecord | undefined;
	let boundIdentity: SessionIdentity | undefined;
	let blocked = false;
	let shutdown = false;
	let fencePromise: Promise<void> | undefined;

	const hardFence = (): void => {
		if (active) void beginFence("lifecycle-mismatch");
		active = undefined;
		blocked = true;
		if (!shutdown) phase = "fenced";
	};

	const mintFromCallback = (ctx: ExtensionContext): void => {
		if (shutdown) throw new Error("Pi foreground session issuer is closed");
		const identity = captureIdentity(ctx);
		const lease = Object.freeze(
			Object.create(null) as object,
		) as GoalHostSessionLease;
		active = {
			lease,
			identity,
			fences: new Set(),
			drainWaiters: new Set(),
			fenceController: new AbortController(),
			valid: true,
			inflight: 0,
		};
		boundIdentity = identity;
		fencePromise = undefined;
		blocked = false;
		phase = "active";
	};

	const beginFence = (
		reason: GoalHostSessionFenceReason,
		targetSessionFile?: string,
	): Promise<void> => {
		if (fencePromise) return fencePromise;
		const record = active;
		if (!record) {
			blocked = true;
			return Promise.resolve();
		}

		// Permanent invalidation occurs before user fence code can run or await.
		record.valid = false;
		active = undefined;
		if (!shutdown) phase = "fenced";
		const event = Object.freeze({
			reason,
			...(targetSessionFile === undefined ? {} : { targetSessionFile }),
		});
		const fences = [...record.fences];
		record.fenceController.abort(
			new Error(`Goal host foreground session fenced: ${reason}`),
		);
		// A fence callback may own the stop that releases an admitted operation.
		// Start it now, not after waiting for that same operation to drain.
		const callbacks = Promise.allSettled(
			fences.map(async (fence) => fence(event)),
		);
		fencePromise = (async () => {
			if (record.inflight > 0)
				await new Promise<void>((resolve) => record.drainWaiters.add(resolve));
			const results = await callbacks;
			if (results.some((result) => result.status === "rejected")) blocked = true;
		})();
		return fencePromise;
	};

	const beforeTransition = async (
		reason: "new" | "resume" | "fork" | "tree",
		ctx: ExtensionContext,
		targetSessionFile?: string,
	): Promise<{ cancel: true } | undefined> => {
		try {
			if (phase !== "active" || !active || !boundIdentity) {
				hardFence();
				return { cancel: true };
			}
			const matches = identityMatches(boundIdentity, ctx);
			await beginFence(matches ? reason : "lifecycle-mismatch", targetSessionFile);
			if (shutdown || !matches || blocked || !identityMatches(boundIdentity, ctx))
				return { cancel: true };
			phase = reason === "tree" ? "tree-pending" : "transition-pending";
			return undefined;
		} catch {
			hardFence();
			return { cancel: true };
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (phase !== "awaiting-start") {
				if (active) await beginFence("lifecycle-mismatch");
				else hardFence();
				return;
			}
			mintFromCallback(ctx);
		} catch {
			hardFence();
		}
	});

	pi.on("session_before_switch", (event: SessionBeforeSwitchEvent, ctx) =>
		beforeTransition(event.reason, ctx, event.targetSessionFile),
	);

	pi.on("session_before_fork", (_event: SessionBeforeForkEvent, ctx) =>
		beforeTransition("fork", ctx),
	);

	pi.on("session_before_tree", (_event: SessionBeforeTreeEvent, ctx) =>
		beforeTransition("tree", ctx),
	);

	pi.on("session_tree", async (_event, ctx) => {
		try {
			if (
				phase !== "tree-pending" ||
				blocked ||
				!boundIdentity ||
				!identityMatches(boundIdentity, ctx)
			) {
				if (active) await beginFence("lifecycle-mismatch");
				else hardFence();
				return;
			}
			mintFromCallback(ctx);
		} catch {
			hardFence();
		}
	});

	pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
		shutdown = true;
		phase = "closed";
		try {
			const matches =
				boundIdentity !== undefined && identityMatches(boundIdentity, ctx);
			phase = "closed";
			if (active)
				await beginFence(
					matches ? event.reason : "lifecycle-mismatch",
					event.targetSessionFile,
				);
			else if (fencePromise) await fencePromise;
			else if (!matches) blocked = true;
			phase = "closed";
		} catch {
			hardFence();
			phase = "closed";
		}
	});

	const assertCurrent: GoalHostSessionIssuer["assertCurrent"] = (
		lease: unknown,
	): asserts lease is GoalHostSessionLease => {
		if (active && !identityStillValid(active.identity)) hardFence();
		if (phase !== "active" || !active || !active.valid || lease !== active.lease)
			throw new Error("Goal host foreground session lease is stale or untrusted");
	};
	const issuer: GoalHostSessionIssuer = Object.freeze({
		currentLease(): GoalHostSessionLease {
			if (active && !identityStillValid(active.identity)) hardFence();
			if (phase !== "active" || !active || !active.valid)
				throw new Error("Goal host foreground session is not current");
			return active.lease;
		},
		assertCurrent,
		async runCurrent<T>(
			lease: GoalHostSessionLease,
			action: (fenceSignal: AbortSignal) => Promise<T>,
		): Promise<T> {
			assertCurrent(lease);
			if (typeof action !== "function")
				throw new Error("Goal host session action must be a function");
			const record = active!;
			record.inflight += 1;
			try {
				return await action(record.fenceController.signal);
			} finally {
				record.inflight -= 1;
				if (record.inflight === 0) {
					for (const resolve of record.drainWaiters) resolve();
					record.drainWaiters.clear();
				}
			}
		},
		bindFence(lease: GoalHostSessionLease, fence: GoalHostSessionFence): void {
			assertCurrent(lease);
			if (typeof fence !== "function")
				throw new Error("Goal host session fence must be a function");
			active?.fences.add(fence);
		},
	});
	trustedGoalHostSessionIssuers.add(issuer);
	return issuer;
}
