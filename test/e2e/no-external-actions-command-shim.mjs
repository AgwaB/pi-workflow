#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const invoked = basename(process.argv[1]);
const args = process.argv.slice(2);
const logPath = process.env.PI_WORKFLOW_E2E_PROCESS_LOG;

if (!logPath || process.env.PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS !== "1") {
	throw new Error("E2E command shim requires the no-external-actions guard");
}

const classification = classify(invoked, args);
appendFileSync(
	logPath,
	`${JSON.stringify({
		type: "command-shim",
		at: new Date().toISOString(),
		pid: process.pid,
		command: invoked,
		args: args.slice(0, 12).map((value) => String(value).slice(0, 240)),
		classification,
	})}\n`,
	"utf8",
);

if (classification !== "allowed") {
	appendFileSync(
		logPath,
		`${JSON.stringify({
			type: "blocked-command",
			at: new Date().toISOString(),
			pid: process.pid,
			command: invoked,
			classification,
		})}\n`,
		"utf8",
	);
	console.error(`E2E external-action shim blocked ${classification}`);
	process.exit(97);
}

if (invoked !== "npm") {
	throw new Error(`no allowed delegate configured for ${invoked}`);
}
const realNpm = process.env.PI_WORKFLOW_E2E_REAL_NPM;
if (!realNpm) throw new Error("PI_WORKFLOW_E2E_REAL_NPM is required");
const result = spawnSync(realNpm, args, {
	stdio: "inherit",
	env: process.env,
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

function classify(command, commandArgs) {
	if (command !== "npm") {
		return command === "pi" ? "provider-executable" : "network-or-package-executable";
	}
	const subcommand = commandArgs.find((argument) => !String(argument).startsWith("-"));
	if (!subcommand) return "allowed";
	if (["install", "i", "ci", "add", "update", "uninstall", "remove", "rm", "link"].includes(subcommand)) {
		return "package-install";
	}
	if ([
		"access",
		"adduser",
		"deprecate",
		"dist-tag",
		"login",
		"logout",
		"org",
		"owner",
		"ping",
		"profile",
		"publish",
		"star",
		"stars",
		"team",
		"token",
		"unpublish",
		"view",
		"whoami",
	].includes(subcommand)) {
		return "registry-action";
	}
	return "allowed";
}
