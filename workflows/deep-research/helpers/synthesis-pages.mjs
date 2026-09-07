// Workflow-local transport, not runtime pagination. Every indexed page (even an
// empty tail) has a static requiredRead in BOTH research specs.
import { isDeepStrictEqual } from "node:util";

// A modest 192k aggregate page bank for realistic near-max research ledgers
// (48 claims; plan ceilings: 64 slots, 24 questions). Unbounded schema text and
// indivisible metadata mean cardinality alone cannot guarantee a fit.
export const SYNTHESIS_PAGE_COUNT = 8;
export const SYNTHESIS_READ_MAX_CHARS = 24000;
const SCHEMA = "deep-research-synthesis-pages-v1";
// Match the persisted JSON boundary (in-memory helper rows may have undefined
// optional properties). Serialization failures are blockers, never lossy fallbacks.
function json(value) {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch (cause) {
		throw new Error("synthesis canonical data is not serializable JSON", {
			cause,
		});
	}
}
const size = (value) => JSON.stringify(value).length; // actual reader: UTF-16

// Preserve the complete serialized canonical packet, not a second digest of it.
// Array rows are indivisible; non-array fields are indivisible metadata rows.
export function canonicalSynthesisData(packet) {
	const { synthesisInput: _transport, ...canonical } = packet;
	return json(canonical);
}

export function buildSynthesisPages(packet) {
	const canonical = canonicalSynthesisData(packet);
	const pages = Array.from({ length: SYNTHESIS_PAGE_COUNT }, (_, index) => ({
		index,
		entries: [],
	}));
	const header = {
		schema: SCHEMA,
		pageCount: SYNTHESIS_PAGE_COUNT,
		maxChars: SYNTHESIS_READ_MAX_CHARS,
		fields: Object.entries(canonical).map(([field, value]) => ({
			field,
			kind: Array.isArray(value) ? "array" : "value",
			count: Array.isArray(value) ? value.length : 1,
		})),
		pageEntryCounts: [],
	};
	let pageIndex = 0;
	let block;
	for (const [field, value] of Object.entries(canonical)) {
		const entries = Array.isArray(value)
			? value.map((row, index) => ({ field, index, value: row }))
			: [{ field, value }];
		for (const entry of entries) {
			if (size({ index: 0, entries: [entry] }) > SYNTHESIS_READ_MAX_CHARS) {
				block = "oversized_row";
				break;
			}
			if (
				size({
					...pages[pageIndex],
					entries: [...pages[pageIndex].entries, entry],
				}) > SYNTHESIS_READ_MAX_CHARS
			)
				pageIndex += 1;
			if (pageIndex >= SYNTHESIS_PAGE_COUNT) {
				block = "page_bank_exhausted";
				break;
			}
			pages[pageIndex].entries.push(entry);
		}
		if (block) break;
	}
	if (block) {
		// No partial projection is represented as usable. Canonical fields stay
		// untouched, and the small typed blocker can itself always be read.
		for (const page of pages) page.entries = [];
		header.budgetBlock = {
			status: "blocked",
			reason: block,
			canonicalLedgerPreserved: true,
		};
	}
	header.pageEntryCounts = pages.map((page) => page.entries.length);
	if (size(header) > SYNTHESIS_READ_MAX_CHARS) {
		header.fields = [];
		for (const page of pages) page.entries = [];
		header.pageEntryCounts = pages.map(() => 0);
		header.budgetBlock = {
			status: "blocked",
			reason: "oversized_header",
			canonicalLedgerPreserved: true,
		};
	}
	return { header, pages };
}

// Require exact deterministic membership AND field values, including empty
// collections and metadata. A valid header/count alone cannot hide omitted data.
export function reconstructSynthesisPages(input) {
	if (
		input?.header?.schema !== SCHEMA ||
		input.header.budgetBlock ||
		input.header.pageCount !== SYNTHESIS_PAGE_COUNT ||
		input.header.maxChars !== SYNTHESIS_READ_MAX_CHARS ||
		!Array.isArray(input.pages) ||
		input.pages.length !== SYNTHESIS_PAGE_COUNT ||
		!Array.isArray(input.header.fields) ||
		!Array.isArray(input.header.pageEntryCounts) ||
		input.header.pageEntryCounts.length !== SYNTHESIS_PAGE_COUNT ||
		size(input.header) > SYNTHESIS_READ_MAX_CHARS
	) {
		throw new Error("invalid or blocked synthesis page header/bank");
	}
	const result = Object.create(null);
	const fields = new Map();
	for (const row of input.header.fields) {
		if (
			typeof row.field !== "string" ||
			fields.has(row.field) ||
			!["array", "value"].includes(row.kind) ||
			!Number.isSafeInteger(row.count) ||
			row.count < 0 ||
			(row.kind === "value" && row.count !== 1)
		)
			throw new Error("invalid synthesis field membership");
		fields.set(row.field, { ...row, seen: 0 });
		if (row.kind === "array") result[row.field] = [];
	}
	input.pages.forEach((page, index) => {
		if (
			page?.index !== index ||
			!Array.isArray(page.entries) ||
			page.entries.length !== input.header.pageEntryCounts[index] ||
			size(page) > SYNTHESIS_READ_MAX_CHARS
		)
			throw new Error("invalid synthesis page index/count/size");
		for (const entry of page.entries) {
			const field = fields.get(entry.field);
			if (!field || field.seen >= field.count || !Object.hasOwn(entry, "value"))
				throw new Error("unknown/duplicate synthesis entry");
			if (field.kind === "array") {
				if (entry.index !== field.seen)
					throw new Error("missing/duplicate synthesis row index");
				result[entry.field].push(entry.value);
			} else {
				if (Object.hasOwn(entry, "index"))
					throw new Error("invalid synthesis value index");
				result[entry.field] = entry.value;
			}
			field.seen += 1;
		}
	});
	if ([...fields.values()].some((field) => field.seen !== field.count))
		throw new Error("missing synthesis entries");
	return json(result);
}

export function validateSynthesisPages(packet) {
	if (packet.synthesisInput?.header?.budgetBlock)
		return ["synthesis input budget block is present"];
	try {
		const reconstructed = reconstructSynthesisPages(packet.synthesisInput);
		if (
			!isDeepStrictEqual(reconstructed, canonicalSynthesisData(packet)) ||
			!isDeepStrictEqual(packet.synthesisInput, buildSynthesisPages(packet))
		) {
			return ["synthesis pages do not losslessly match canonical packet"];
		}
		return [];
	} catch {
		return ["synthesis pages are missing, duplicated, malformed, or oversized"];
	}
}
