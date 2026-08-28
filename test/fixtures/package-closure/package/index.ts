import type { FixtureType } from "./types";
import { cycleValue } from "./cycle/a.ts";
export { featureValue } from "./feature";

export async function loadExtract(): Promise<FixtureType> {
	const extract = await import("./extract.ts");
	return extract.extractValue(cycleValue);
}

export const required = require("./required");
