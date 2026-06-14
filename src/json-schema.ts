export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
	$type?: unknown;
	$schema?: unknown;
	$id?: unknown;
	title?: unknown;
	description?: unknown;
	type?: string | string[];
	const?: unknown;
	enum?: unknown[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema | JsonSchema[];
	minItems?: number;
	maxItems?: number;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	pattern?: string;
	allOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
}

export interface JsonSchemaIssue {
	path: string;
	message: string;
}

export interface JsonSchemaValidationResult {
	valid: boolean;
	issues: JsonSchemaIssue[];
}

const SUPPORTED_SCHEMA_KEYS = new Set([
	"$schema",
	"$id",
	"title",
	"description",
	"type",
	"const",
	"enum",
	"required",
	"properties",
	"additionalProperties",
	"items",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"allOf",
	"anyOf",
	"oneOf",
]);

export function validateJsonSchemaSubset(
	schema: unknown,
): JsonSchemaValidationResult {
	const issues: JsonSchemaIssue[] = [];
	validateSchemaSubset(schema, "$", issues);
	return { valid: issues.length === 0, issues };
}

function validateSchemaSubset(
	schema: unknown,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (typeof schema === "boolean") return;
	if (!isRecord(schema)) {
		issues.push({ path, message: "schema must be a boolean or object" });
		return;
	}
	for (const key of Object.keys(schema)) {
		if (key === "pattern") {
			issues.push({
				path: `${path}.pattern`,
				message:
					"pattern is not supported by the workflow control schema subset",
			});
			continue;
		}
		if (key === "$ref" || key === "$defs" || key === "definitions") {
			issues.push({
				path: `${path}.${key}`,
				message:
					"schema references are not supported by the workflow control schema subset",
			});
			continue;
		}
		if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
			issues.push({
				path: `${path}.${key}`,
				message: "unsupported workflow control schema keyword",
			});
		}
	}
	if (schema.properties !== undefined) {
		if (!isRecord(schema.properties)) {
			issues.push({ path: `${path}.properties`, message: "must be an object" });
		} else {
			for (const [key, child] of Object.entries(schema.properties)) {
				validateSchemaSubset(child, `${path}.properties.${key}`, issues);
			}
		}
	}
	if (
		schema.additionalProperties !== undefined &&
		typeof schema.additionalProperties !== "boolean"
	) {
		validateSchemaSubset(
			schema.additionalProperties,
			`${path}.additionalProperties`,
			issues,
		);
	}
	if (Array.isArray(schema.items)) {
		for (const [index, child] of schema.items.entries()) {
			validateSchemaSubset(child, `${path}.items[${index}]`, issues);
		}
	} else if (schema.items !== undefined) {
		validateSchemaSubset(schema.items, `${path}.items`, issues);
	}
	for (const key of ["allOf", "anyOf", "oneOf"] as const) {
		const children = schema[key];
		if (children === undefined) continue;
		if (!Array.isArray(children)) {
			issues.push({ path: `${path}.${key}`, message: "must be an array" });
			continue;
		}
		for (const [index, child] of children.entries()) {
			validateSchemaSubset(child, `${path}.${key}[${index}]`, issues);
		}
	}
}

export function validateJsonSchema(
	value: unknown,
	schema: JsonSchema,
): JsonSchemaValidationResult {
	const issues: JsonSchemaIssue[] = [];
	validateAgainstSchema(value, schema, "$", issues);
	return { valid: issues.length === 0, issues };
}

function validateAgainstSchema(
	value: unknown,
	schema: JsonSchema,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (schema === true) return;
	if (schema === false) {
		issues.push({ path, message: "value is not allowed by schema" });
		return;
	}
	if (!isRecord(schema)) {
		issues.push({ path, message: "schema must be a boolean or object" });
		return;
	}

	validateConst(value, schema, path, issues);
	validateEnum(value, schema, path, issues);
	validateType(value, schema, path, issues);
	validateStringConstraints(value, schema, path, issues);
	validateNumberConstraints(value, schema, path, issues);
	validateArrayConstraints(value, schema, path, issues);
	validateObjectConstraints(value, schema, path, issues);
	validateCombinators(value, schema, path, issues);
}

function validateConst(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (!Object.hasOwn(schema, "const")) return;
	if (!jsonEqual(value, schema.const)) {
		issues.push({ path, message: "value must equal schema const" });
	}
}

function validateEnum(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (!Array.isArray(schema.enum)) return;
	if (!schema.enum.some((candidate) => jsonEqual(value, candidate))) {
		issues.push({ path, message: "value must match one of schema enum" });
	}
}

function validateType(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	const allowed = Array.isArray(schema.type)
		? schema.type
		: typeof schema.type === "string"
			? [schema.type]
			: [];
	if (allowed.length === 0) return;
	if (!allowed.some((type) => valueMatchesType(value, type))) {
		issues.push({
			path,
			message: `value must be of type ${allowed.join("|")}`,
		});
	}
}

function validateStringConstraints(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (typeof value !== "string") return;
	if (typeof schema.minLength === "number" && value.length < schema.minLength) {
		issues.push({
			path,
			message: `string length must be >= ${schema.minLength}`,
		});
	}
	if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		issues.push({
			path,
			message: `string length must be <= ${schema.maxLength}`,
		});
	}
	if (typeof schema.pattern === "string") {
		issues.push({
			path,
			message:
				"pattern constraints are not supported by the workflow control schema subset",
		});
	}
}

function validateNumberConstraints(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (typeof value !== "number") return;
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		issues.push({ path, message: `number must be >= ${schema.minimum}` });
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		issues.push({ path, message: `number must be <= ${schema.maximum}` });
	}
}

function validateArrayConstraints(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (!Array.isArray(value)) return;
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		issues.push({
			path,
			message: `array length must be >= ${schema.minItems}`,
		});
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		issues.push({
			path,
			message: `array length must be <= ${schema.maxItems}`,
		});
	}
	if (Array.isArray(schema.items)) {
		for (const [index, itemSchema] of schema.items.entries()) {
			if (index < value.length)
				validateAgainstSchema(
					value[index],
					itemSchema,
					`${path}[${index}]`,
					issues,
				);
		}
		return;
	}
	if (schema.items !== undefined) {
		for (const [index, item] of value.entries()) {
			validateAgainstSchema(item, schema.items, `${path}[${index}]`, issues);
		}
	}
}

function validateObjectConstraints(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (!isRecord(value)) return;
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (!Object.hasOwn(value, key)) {
				issues.push({
					path: `${path}.${key}`,
					message: "required property is missing",
				});
			}
		}
	}

	const properties = isRecord(schema.properties)
		? schema.properties
		: undefined;
	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (Object.hasOwn(value, key)) {
				validateAgainstSchema(
					value[key],
					propertySchema,
					`${path}.${key}`,
					issues,
				);
			}
		}
	}

	const additional = schema.additionalProperties;
	if (additional === undefined || additional === true) return;
	const known = new Set(Object.keys(properties ?? {}));
	for (const [key, item] of Object.entries(value)) {
		if (known.has(key)) continue;
		if (additional === false) {
			issues.push({
				path: `${path}.${key}`,
				message: "additional property is not allowed",
			});
			continue;
		}
		validateAgainstSchema(item, additional, `${path}.${key}`, issues);
	}
}

function validateCombinators(
	value: unknown,
	schema: JsonSchemaObject,
	path: string,
	issues: JsonSchemaIssue[],
): void {
	if (Array.isArray(schema.allOf)) {
		for (const child of schema.allOf)
			validateAgainstSchema(value, child, path, issues);
	}
	if (Array.isArray(schema.anyOf)) {
		const matched = schema.anyOf.some(
			(child) => validateJsonSchema(value, child).valid,
		);
		if (!matched)
			issues.push({
				path,
				message: "value must match at least one anyOf schema",
			});
	}
	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter(
			(child) => validateJsonSchema(value, child).valid,
		).length;
		if (matches !== 1)
			issues.push({
				path,
				message: "value must match exactly one oneOf schema",
			});
	}
}

function valueMatchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "array":
			return Array.isArray(value);
		case "boolean":
			return typeof value === "boolean";
		case "integer":
			return Number.isInteger(value);
		case "null":
			return value === null;
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "object":
			return isRecord(value);
		case "string":
			return typeof value === "string";
		default:
			return true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
