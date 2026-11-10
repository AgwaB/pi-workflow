import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const usageUrl = new URL("../../docs/usage.md", import.meta.url);
const skillUrl = new URL("../../skills/workflow-guide/SKILL.md", import.meta.url);
const usage = readFileSync(usageUrl, "utf8");
const skill = readFileSync(skillUrl, "utf8");
const variable = "PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS";
const anchor = "extension-defined-models";

test("provider-extension guidance documents explicit setup and its safety boundaries", () => {
	const section = usage.split("## Extension-defined models\n")[1]?.split("\n## ")[0];
	assert.ok(section, "public usage must explain extension-defined models");
	const text = section.replace(/\s+/g, " ");
	assert.match(text, /pi\.registerProvider\(\)/);
	assert.match(text, /Parent model availability does not prove child model availability/);
	assert.match(text, /not automatically inherit all parent extensions/);
	assert.match(text, /Model .*not found/);
	assert.match(text, /before starting Pi/);
	assert.match(text, /process-wide/);
	assert.match(text, /not a workflow spec field/);
	assert.match(text, /Goal candidate\/request channels/);
	assert.match(text, /trusted/);
	assert.match(text, /authentication/);
	assert.match(text, /models\.json/);
	assert.match(text, /tool.*extensions/i);
	assert.match(text, /static validation/i);
	assert.match(section, /PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS="\/absolute\/path\/to\/provider-extension\.ts" pi/);
});

test("provider-extension configuration is supported without promoting unrelated internal controls", () => {
	const rows = usage.split("\n").filter(line => line.startsWith("|"));
	const supported = rows.find(line => line.startsWith("| Supported provider-extension configuration |"));
	const internal = rows.find(line => line.startsWith("| Internal/diagnostic, not public tuning contracts |"));
	assert.ok(supported?.includes(variable));
	assert.ok(supported.includes(`(#${anchor})`));
	assert.ok(internal);
	assert.ok(!internal.includes(variable));
	for (const name of ["PI_WORKFLOW_CAPTURE_TOOL_CALLS", "PI_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR", "PI_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS"])
		assert.ok(internal.includes(name), `${name} must remain internal`);
});

test("workflow-guide links child model registration checks to the canonical public guide", () => {
	const links = [...skill.matchAll(/\]\(([^)]+)\)/g)]
		.map(match => new URL(match[1], skillUrl))
		.filter(url => url.hash === `#${anchor}`);
	assert.ok(links.length > 0, "authoring guidance must link to the child model setup contract");
	for (const link of links) {
		link.hash = "";
		assert.equal(link.href, usageUrl.href);
	}
	const readiness = skill.split("## Validation readiness checklist")[1]?.split("\n## ")[0];
	assert.ok(readiness?.includes("extension-defined models"));
	assert.match(skill.replace(/\s+/g, " "), /parent model availability/);
	assert.match(skill.replace(/\s+/g, " "), /do not invent.*extensions.*spec field/i);
});
