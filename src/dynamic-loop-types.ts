import type { NormalizedDynamicDecision } from "./dynamic-decision.js";
import type { CompiledDynamicDecisionLoop } from "./types.js";

export interface DynamicDecisionLoopControllerContext {
	task: string;
	sources?: Record<string, unknown>;
	graph: {
		generatedTaskIds(): string[];
		generatedBranchTaskIds?(): string[];
		generatedTaskSpecId?(taskId: string): string;
	};
	dynamic: {
		config(): CompiledDynamicDecisionLoop | null | undefined;
		/**
		 * Runtime-injected convenience entrypoint for bundle-local controllers.
		 * Controllers can call this instead of importing the package from a copied
		 * run bundle.
		 */
		runDecisionLoop?(
			options?: RunDynamicDecisionLoopOptions,
		): Promise<DynamicDecisionLoopRunResult>;
		/**
		 * Event-first loop-control checkpoint used by the injected controller
		 * runtime. Unit-test/fake contexts may omit it; the loop remains
		 * deterministically recomputable from ordinary decision/work events.
		 */
		recordDecisionLoopStatus?(
			status: DynamicDecisionLoopStatus,
		): Promise<unknown>;
	};
	decision: {
		validateAndPersist(
			rawDecision: unknown,
			context: Record<string, unknown>,
		): Promise<DynamicDecisionPersistResult>;
	};
	stateIndex: {
		extractAndPersist(
			request: DynamicStateIndexPersistRequest,
		): Promise<DynamicStateIndexPersistResult>;
	};
	fanout?: {
		plan(
			request: DynamicFanoutPlanPersistRequest,
		): Promise<DynamicFanoutPlanPersistResult>;
	};
	agent(request: DynamicLoopAgentRequest): Promise<DynamicLoopAgentResult>;
	parallel?<T>(thunks: Array<() => Promise<T>>): Promise<unknown>;
	log?(...args: unknown[]): void;
}

export interface DynamicDecisionPersistResult {
	ok: boolean;
	errors: string[];
	decision?: NormalizedDynamicDecision;
	decisionHash?: string;
	stateIndexDigest?: string;
	artifacts?: Record<string, unknown>;
}

export interface LoopDecisionRecord extends DynamicDecisionPersistResult {
	plannerAnalysis?: string;
	plannerRefs?: unknown[];
}

export interface DynamicStateIndexPersistRequest {
	round: number;
	tasks: Array<{ taskId: string; outputProfile: string }>;
	/**
	 * @deprecated Phase 1 compatibility no-op for the core decision loop; the
	 * loop intentionally does not derive or pass required finding ids.
	 */
	requiredFindingIds?: string[];
	maxFindings?: number;
}

export interface DynamicStateIndexPersistResult {
	digest: string;
	index?: unknown;
	artifacts?: Record<string, unknown>;
}

export interface DynamicFanoutBranchPlanRequest {
	branchId: string;
	actionId: string;
	requestId: string;
	type: "add_work_item" | "verify";
	outputProfile: string;
	dependsOn?: string[];
	agentRequest: DynamicLoopAgentRequest;
}

export interface DynamicFanoutPlanPersistRequest {
	round: number;
	decisionHash: string;
	branches: DynamicFanoutBranchPlanRequest[];
}

export interface DynamicFanoutPlannedBranch {
	branchId: string;
	actionId: string;
	requestId: string;
	type: "add_work_item" | "verify";
	outputProfile: string;
	dependsOn?: string[];
	requestHash: string;
	status: "planned";
	targetSpecId?: string;
	specId?: string;
}

export interface DynamicFanoutPlanPersistResult {
	round: number;
	decisionHash: string;
	branches: DynamicFanoutPlannedBranch[];
}

export interface DynamicLoopAgentRequest {
	id: string;
	profile?: "planner" | "worker" | "verifier" | "synthesis" | string;
	agent?: string;
	prompt: string;
	outputProfile?: string;
	tools?: string[];
	dependsOn?: string[];
	inputs?: unknown[];
	branchId?: string;
	compact?: boolean;
}

export interface DynamicLoopAgentResult {
	status?: string;
	taskId?: string;
	specId?: string;
	control?: unknown;
	analysis?: unknown;
	refs?: unknown;
	[key: string]: unknown;
}

export interface RunDynamicDecisionLoopOptions {
	maxRounds?: number;
	buildPlannerPrompt?: (input: DynamicPlannerPromptInput) => string;
}

export interface DynamicPlannerPromptInput {
	round: number;
	task: string;
	sources?: Record<string, unknown>;
	config: CompiledDynamicDecisionLoop;
	previousDecisions: DynamicDecisionPersistResult[];
	latestStateIndex?: DynamicStateIndexPersistResult;
	generatedTaskIds: string[];
	repair?: { errors: string[]; attempt: number };
	replan?: {
		attempt: number;
		maxAttempts: number;
		stallCount: number;
		roundsWithoutProgress: number;
		lastDigest?: string;
	};
}

export interface DynamicDecisionLoopResult {
	schema: "dynamic-controller-result-v1";
	digest: string;
	status: "synthesized" | "stopped" | "blocked" | "exhausted";
	decisions: Array<{
		round: number;
		decisionId?: string;
		status?: string;
		decisionHash?: string;
	}>;
	generatedTasks: string[];
	outputTasks: string[];
	stateIndexes: Array<{ round: number; digest: string }>;
	blockers: string[];
	omissions: string[];
	caveats: string[];
}

export interface DynamicDecisionLoopRunResult {
	control: DynamicDecisionLoopResult;
	analysis: string;
	refs: unknown[];
}

export interface DynamicDecisionLoopStatus {
	stallCount: number;
	replanCount: number;
}
