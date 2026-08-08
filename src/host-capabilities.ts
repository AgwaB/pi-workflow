export interface WorkflowHostOperationContext {
	cwd: string;
	runId: string;
	parentRunId: string | null;
	controllerSpecId: string;
	controllerTaskId: string;
	controllerStageId: string;
	workflow: {
		name: string | null;
		specPath: string;
		bundleSpecPath: string;
		bundleHash: string;
	};
	operation: {
		alias: string;
		capability: string;
		callIndex: number;
		opId: string;
		requestHash: string;
		idempotencyKey: string;
	};
}

export interface WorkflowHostOperationAdapter {
	invoke(
		request: unknown,
		context: Readonly<WorkflowHostOperationContext>,
	): unknown | Promise<unknown>;
	reconcile(
		request: unknown,
		context: Readonly<WorkflowHostOperationContext>,
	): unknown | Promise<unknown>;
}

export type WorkflowHostCapabilities = Readonly<
	Record<string, WorkflowHostOperationAdapter>
>;

export interface WorkflowHostCapabilityLaunchContext {
	cwd: string;
	workflow: string;
	task?: string;
}

export type WorkflowHostCapabilityProvider = (
	context: Readonly<WorkflowHostCapabilityLaunchContext>,
) => WorkflowHostCapabilities | Promise<WorkflowHostCapabilities>;

const providers = new Set<WorkflowHostCapabilityProvider>();

export function registerWorkflowHostCapabilityProvider(
	provider: WorkflowHostCapabilityProvider,
): () => void {
	providers.add(provider);
	return () => providers.delete(provider);
}

export function clearWorkflowHostCapabilityProvidersForTests(): void {
	providers.clear();
}

export async function resolveWorkflowHostCapabilities(
	context: WorkflowHostCapabilityLaunchContext,
): Promise<WorkflowHostCapabilities> {
	const resolved: Record<string, WorkflowHostOperationAdapter> = {};
	const frozen = deepFreeze({ ...context });
	for (const provider of providers) {
		const capabilities = await provider(frozen);
		for (const [name, adapter] of Object.entries(capabilities ?? {})) {
			if (Object.hasOwn(resolved, name)) {
				throw new Error(`duplicate workflow host capability: ${name}`);
			}
			if (
				!adapter ||
				typeof adapter.invoke !== "function" ||
				typeof adapter.reconcile !== "function"
			) {
				throw new Error(`invalid workflow host capability adapter: ${name}`);
			}
			resolved[name] = adapter;
		}
	}
	return Object.freeze(resolved);
}

export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}
