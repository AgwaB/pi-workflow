import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

/** Goal-local strict, bounded JSON. No getters, prototypes, holes, coercion or toJSON. */
export const GOAL_MAX_BYTES = 256 * 1024;
export const GOAL_MAX_EVENTS = 4096;
export class GoalJsonResourceLimitError extends Error {}
export function goalJson(value: unknown): string {
	return boundedJson(value, false);
}

/** Canonical lossless JSON text for authored workflow definitions. This is
 * deliberately separate from authority/journal JSON, which remains limited to
 * safe integers. */
export function goalWorkflowJson(value: unknown): string {
	return boundedJson(value, true);
}

/** Workflow definitions have finite fractional JSON data, unlike Goal counters.
 * Accept parsed data only; never use this clone for authority/journal records. */
export function cloneGoalWorkflowData<T>(value: T): T {
	boundedJson(value, true); // Validate without invoking getters/toJSON.
	// Preserve -0 until the surrounding Goal fields get their strict validation.
	return structuredClone(value);
}

const GOAL_WORKFLOW_DATA_RECORD_SCHEMA = "goal-workflow-data/v1";
const GOAL_WORKFLOW_DATA_RECORD_CHUNK_UNITS = 16_384;
const GOAL_WORKFLOW_DATA_RECORD_MAX_CHUNKS = 16;

/** Encode finite workflow data for storage inside integer-only authority JSON. */
export function encodeGoalWorkflowDataRecord(value: unknown): {
	readonly schema: typeof GOAL_WORKFLOW_DATA_RECORD_SCHEMA;
	readonly chunks: readonly string[];
} {
	const text = goalWorkflowJson(value);
	const chunks: string[] = [];
	let chunk = "";
	for (const codePoint of text) {
		if (chunk.length + codePoint.length > GOAL_WORKFLOW_DATA_RECORD_CHUNK_UNITS) {
			chunks.push(chunk);
			chunk = "";
		}
		chunk += codePoint;
	}
	if (chunk) chunks.push(chunk);
	if (chunks.length < 1 || chunks.length > GOAL_WORKFLOW_DATA_RECORD_MAX_CHUNKS)
		throw new GoalJsonResourceLimitError("Goal workflow data record limit");
	const record = { schema: GOAL_WORKFLOW_DATA_RECORD_SCHEMA, chunks } as const;
	goalJson(record);
	return record;
}

/** Decode only the one canonical, surrogate-safe storage spelling emitted above. */
export function decodeGoalWorkflowDataRecord(value: unknown): unknown {
	goalJson(value); // Reject proxies, accessors, cycles, unsafe data, and authority-invalid records first.
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Goal workflow data record invalid");
	const record = value as { schema?: unknown; chunks?: unknown };
	if (Object.keys(record).length !== 2 ||
		!Object.prototype.hasOwnProperty.call(record, "schema") ||
		!Object.prototype.hasOwnProperty.call(record, "chunks") ||
		record.schema !== GOAL_WORKFLOW_DATA_RECORD_SCHEMA ||
		!Array.isArray(record.chunks) ||
		record.chunks.length < 1 ||
		record.chunks.length > GOAL_WORKFLOW_DATA_RECORD_MAX_CHUNKS ||
		!record.chunks.every(chunk => typeof chunk === "string" && chunk.length >= 1 &&
			chunk.length <= GOAL_WORKFLOW_DATA_RECORD_CHUNK_UNITS))
		throw new Error("Goal workflow data record invalid");
	const chunks = record.chunks;
	const text = chunks.join("");
	const decoded = goalWorkflowInput(text);
	if (goalWorkflowJson(decoded) !== text)
		throw new Error("Goal workflow data record noncanonical");
	const canonical = encodeGoalWorkflowDataRecord(decoded);
	if (canonical.chunks.length !== chunks.length ||
		canonical.chunks.some((chunk, index) => chunk !== chunks[index]))
		throw new Error("Goal workflow data record noncanonical");
	return cloneGoalWorkflowData(decoded);
}

function boundedJson(value: unknown, workflowNumbers: boolean): string {
	let nodes = 0;
	const seen = new Set<object>();
	const visit = (v: unknown, depth: number): string => {
		if (++nodes > 20000 || depth > 24) throw new GoalJsonResourceLimitError("Goal JSON complexity limit");
		if (v === null || typeof v === "boolean") return String(v);
		if (typeof v === "string") {
			if (v.length > 16384) throw new GoalJsonResourceLimitError("Goal JSON string limit/encoding");
			if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) throw new Error("Goal JSON string limit/encoding");
			return JSON.stringify(v);
		}
		if (typeof v === "number" && (workflowNumbers ? Number.isFinite(v) : Number.isSafeInteger(v) && !Object.is(v, -0))) return JSON.stringify(v);
		if (!v || typeof v !== "object" || seen.has(v) || utilTypes.isProxy(v)) throw new Error("Goal JSON non-data value");
		seen.add(v);
		const descriptors = Object.getOwnPropertyDescriptors(v);
		const ownKeys = Reflect.ownKeys(descriptors);
		if (ownKeys.some(k => typeof k !== "string")) throw new Error("Goal JSON symbol");
		const keys = ownKeys as string[];
		const array = Array.isArray(v);
		for (const k of keys) {
			const d = descriptors[k];
			if (!("value" in d) || (!d.enumerable && !(array && k === "length"))) throw new Error("Goal JSON accessor/hidden field");
		}
		let result: string;
		if (array) {
			if (Object.getPrototypeOf(v) !== Array.prototype) throw new Error("Goal JSON array prototype");
			if (v.length > 4096) throw new GoalJsonResourceLimitError("Goal JSON sparse/extended array");
			if (keys.length !== v.length + 1 || keys[v.length] !== "length")
				throw new Error("Goal JSON sparse/extended array");
			for (let i = 0; i < v.length; i++)
				if (keys[i] !== String(i)) throw new Error("Goal JSON sparse/extended array");
			const parts: string[] = [];
			for (let i = 0; i < v.length; i++) {
				parts.push(visit(descriptors[keys[i]].value, depth + 1));
			}
			result = `[${parts.join(",")}]`;
		} else {
			if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("Goal JSON prototype");
			keys.sort();
			const parts: string[] = [];
			for (const k of keys)
				parts.push(`${visit(k, depth + 1)}:${visit(descriptors[k].value, depth + 1)}`);
			result = `{${parts.join(",")}}`;
		}
		seen.delete(v);
		return result;
	};
	const text = visit(value, 0);
	if (Buffer.byteLength(text) > GOAL_MAX_BYTES) throw new GoalJsonResourceLimitError("Goal JSON byte limit");
	return text;
}
export function goalHash(value: unknown): string {
	return createHash("sha256").update(goalJson(value), "utf8").digest("hex");
}
export function goalWorkflowHash(value: unknown): string {
	return createHash("sha256").update(goalWorkflowJson(value), "utf8").digest("hex");
}

type GoalJsonValue = null | boolean | string | number | GoalJsonValue[] | { [key: string]: GoalJsonValue };

interface ParsedGoalJsonText {
	readonly value: GoalJsonValue;
	readonly canonicalText: string;
}

function parseJsonText(text: string, workflowNumbers = false): ParsedGoalJsonText {
	try {
		const value: unknown = JSON.parse(text);
		const canonicalText = boundedJson(value, workflowNumbers);
		return { value: value as GoalJsonValue, canonicalText };
	} catch (cause) {
		if (cause instanceof GoalJsonResourceLimitError) throw new GoalJsonResourceLimitError("Goal invalid JSON data", { cause });
		throw new Error("Goal invalid JSON data", { cause });
	}
}

function parseGoalJsonText(input: string, workflowNumbers: boolean): ParsedGoalJsonText {
	if (Buffer.byteLength(input) > GOAL_MAX_BYTES) throw new GoalJsonResourceLimitError("Goal JSON byte limit");
	scanJsonStructure(input, true);
	return parseJsonText(input, workflowNumbers);
}

/** Duplicate keys (including escaped aliases) are rejected before JSON.parse loses them. */
export function goalInput(input: unknown): GoalJsonValue {
	return parseGoalJsonInput(input, false);
}

/** Fresh, deeply immutable strict Goal data paired with its validated canonical text. */
export function parseGoalJsonTextWithCanonical(input: string): Readonly<ParsedGoalJsonText> {
	if (typeof input !== "string") throw new Error("Goal JSON text required");
	const parsed = parseGoalJsonText(input, false);
	frozen(parsed.value);
	return Object.freeze(parsed);
}

/** Artifact JSON has literal finite numbers; authority counters remain integer-only. */
export function goalWorkflowInput(input: string): GoalJsonValue {
	if (typeof input !== "string") throw new Error("Goal workflow JSON text required");
	return parseGoalJsonInput(input, true);
}

function parseGoalJsonInput(input: unknown, workflowNumbers: boolean): GoalJsonValue {
	if (typeof input !== "string") {
		// Canonical text has already passed every data and resource check.
		return JSON.parse(boundedJson(input, workflowNumbers)) as GoalJsonValue;
	}
	return parseGoalJsonText(input, workflowNumbers).value;
}

type JsonScanFrame =
	| {
			kind: "object";
			eligible: boolean;
			keys?: Set<string>;
			state: "key" | "colon" | "value" | "comma";
			key?: string;
	  }
	| {
			kind: "array";
			elementsEligible: boolean;
			state: "value" | "comma";
	  };

/**
 * One iterative lexical walker serves both strict Goal duplicate/depth checks
 * and the pre-JSON.parse structural Goal declaration query. Query mode does
 * not impose Goal bounds on ordinary workflow data.
 */
function scanJsonStructure(input: string, strictGoal: boolean): boolean {
	let i = 0;
	let found = false;
	let rootStarted = false;
	let rootComplete = false;
	const stack: JsonScanFrame[] = [];
	const ws = () => { while (/\s/u.test(input[i] ?? "") && i < input.length) i++; };
	const string = (): string => {
		const start = i++;
		while (i < input.length) {
			if (input[i] === "\\") { i += 2; continue; }
			if (input[i++] === '"') return JSON.parse(input.slice(start, i)) as string;
		}
		throw new Error("Workflow JSON unterminated string");
	};
	const atom = (): void => {
		const start = i;
		while (i < input.length && !/[\s,}\]]/u.test(input[i])) i++;
		if (start === i) throw new Error("Workflow JSON value");
	};
	const finished = (): void => {
		const parent = stack.at(-1);
		if (!parent) {
			rootComplete = true;
			return;
		}
		parent.state = "comma";
	};
	const beginValue = (eligible: boolean, stageArray: boolean): void => {
		ws();
		if (input[i] === "{") {
			i++;
			stack.push({ kind: "object", eligible, ...(strictGoal ? { keys: new Set<string>() } : {}), state: "key" });
		} else if (input[i] === "[") {
			i++;
			stack.push({ kind: "array", elementsEligible: stageArray, state: "value" });
		} else {
			if (input[i] === "\"") string();
			else atom();
			finished();
		}
		if (strictGoal && stack.length > 25)
			throw new GoalJsonResourceLimitError("Goal JSON depth");
	};
	while (true) {
		ws();
		if (rootComplete) {
			if (i !== input.length) throw new Error("Workflow JSON trailing bytes");
			return found;
		}
		if (!rootStarted) {
			rootStarted = true;
			beginValue(true, false);
			continue;
		}
		const frame = stack.at(-1);
		if (!frame) throw new Error("Workflow JSON value");
		if (frame.kind === "object") {
			if (frame.state === "key") {
				if (input[i] === "}") { i++; stack.pop(); finished(); continue; }
				if (input[i] !== "\"") throw new Error("Workflow JSON key");
				const key = string();
				if (strictGoal) {
					if (frame.keys!.has(key)) throw new Error("Goal JSON duplicate key");
					frame.keys!.add(key);
				}
				frame.key = key;
				frame.state = "colon";
				continue;
			}
			if (frame.state === "colon") {
				if (input[i++] !== ":") throw new Error("Workflow JSON colon");
				frame.state = "value";
				continue;
			}
			if (frame.state === "value") {
				const key = frame.key!;
				if (frame.eligible && key === "goal") found = true;
				beginValue(
					frame.eligible && (key === "artifactGraph" || key === "onExhausted"),
					frame.eligible && key === "stages",
				);
				continue;
			}
			if (input[i] === "}") { i++; stack.pop(); finished(); continue; }
			if (input[i++] !== ",") throw new Error("Workflow JSON separator");
			frame.state = "key";
			continue;
		}
		if (frame.state === "value") {
			if (input[i] === "]") { i++; stack.pop(); finished(); continue; }
			beginValue(frame.elementsEligible, false);
			continue;
		}
		if (input[i] === "]") { i++; stack.pop(); finished(); continue; }
		if (input[i++] !== ",") throw new Error("Workflow JSON separator");
		frame.state = "value";
	}
}

export function containsGoalWorkflowDeclarationText(input: string): boolean {
	return scanJsonStructure(input, false);
}
export type Check = (value: unknown) => void;
export const str: Check = v => { if (typeof v !== "string" || !v.trim() || v.length > 4096) throw new Error("Goal nonempty string required"); };
export const id: Check = v => { if (typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v)) throw new Error("Goal invalid ID"); };
export const digest: Check = v => { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw new Error("Goal invalid digest"); };
export const nat: Check = v => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("Goal nonnegative integer required"); };
export const positive: Check = v => { nat(v); if (v === 0) throw new Error("Goal positive integer required"); };
export const bool: Check = v => { if (typeof v !== "boolean") throw new Error("Goal boolean required"); };
export const one = (...values: unknown[]): Check => v => { if (!values.includes(v)) throw new Error(`Goal invalid enum: ${String(v)}`); };
export const nullable = (check: Check): Check => v => { if (v !== null) check(v); };
export const arr = (check: Check, min = 0, max = 128): Check => v => {
	if (!Array.isArray(v) || v.length < min || v.length > max) throw new Error("Goal array cardinality");
	v.forEach(check);
};
export const obj = (shape: Record<string, Check>): Check => v => {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Goal object required");
	const data = v as Record<string, unknown>;
	if (Object.keys(data).length !== Object.keys(shape).length || Object.keys(data).some(k => !Object.hasOwn(shape, k))) throw new Error("Goal unknown/missing key");
	for (const [k, check] of Object.entries(shape)) { if (!Object.hasOwn(data, k)) throw new Error(`Goal missing ${k}`); check(data[k]); }
};
export function unique(values: unknown[]): void { if (new Set(values).size !== values.length) throw new Error("Goal duplicate ID/value"); }
export function frozen<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
	return value;
}
export function parse<T>(input: unknown, check: Check): T {
	const data = goalInput(input); check(data); return frozen(data as T);
}
