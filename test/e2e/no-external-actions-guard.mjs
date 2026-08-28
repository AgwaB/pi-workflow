import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename } from "node:path";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";

const enabled = process.env.PI_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS === "1";
const logPath = process.env.PI_WORKFLOW_E2E_PROCESS_LOG;
const stateKey = Symbol.for("pi-workflow.e2e-no-external-actions-guard");

if (enabled && logPath && !globalThis[stateKey]) {
	globalThis[stateKey] = true;
	logEvent("process-start", {
		pid: process.pid,
		ppid: process.ppid,
		command: basename(process.execPath),
		argv: process.argv.slice(1, 8).map(boundedArgument),
	});
	installChildProcessGuard();
	installNetworkGuard();
}

function installChildProcessGuard() {
	for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
		const original = childProcess[method];
		childProcess[method] = function guardedChildProcess(command, args, ...rest) {
			const normalizedArgs = Array.isArray(args) ? args : [];
			const classification = classifyCommand(command, normalizedArgs);
			logEvent("child-process", {
				pid: process.pid,
				command: basename(String(command)),
				args: normalizedArgs.slice(0, 12).map(boundedArgument),
				classification,
			});
			if (classification !== "allowed") {
				logEvent("blocked-command", {
					pid: process.pid,
					command: basename(String(command)),
					classification,
				});
				throw new Error(`E2E external-action guard blocked ${classification}`);
			}
			return original.call(this, command, args, ...rest);
		};
	}
	syncBuiltinESMExports();
}

function classifyCommand(command, args) {
	const name = basename(String(command)).toLowerCase();
	if (["curl", "wget", "npx", "pnpx"].includes(name)) return "network-or-package-executable";
	if (["pnpm", "yarn", "bun"].includes(name)) return "alternate-package-manager";
	if (name === "pi") return "provider-executable";
	if (name === "npm" || name === "npm-cli.js") return classifyNpm(args);
	if ((name === "node" || /^node(?:\.exe)?$/.test(name)) && /npm-cli\.js$/.test(String(args[0] ?? ""))) {
		return classifyNpm(args.slice(1));
	}
	return "allowed";
}

function classifyNpm(args) {
	const command = args.find((argument) => typeof argument === "string" && !argument.startsWith("-"));
	if (!command) return "allowed";
	if (["install", "i", "ci", "add", "update", "uninstall", "remove", "rm", "link"].includes(command)) {
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
	].includes(command)) {
		return "registry-action";
	}
	return "allowed";
}

function installNetworkGuard() {
	const block = (operation) => {
		logEvent("network-attempt", { pid: process.pid, operation });
		throw new Error(`E2E external-action guard blocked network operation ${operation}`);
	};

	const originalSocketConnect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function guardedSocketConnect(..._args) {
		return block("net.Socket.connect");
	};
	Object.defineProperty(net.Socket.prototype.connect, "name", {
		value: originalSocketConnect.name,
	});
	net.createConnection = (..._args) => block("net.createConnection");
	net.connect = (..._args) => block("net.connect");
	tls.connect = (..._args) => block("tls.connect");
	http.request = (..._args) => block("http.request");
	http.get = (..._args) => block("http.get");
	https.request = (..._args) => block("https.request");
	https.get = (..._args) => block("https.get");
	dns.lookup = (..._args) => block("dns.lookup");
	dns.resolve = (..._args) => block("dns.resolve");
	dnsPromises.lookup = (..._args) => block("dns.promises.lookup");
	dnsPromises.resolve = (..._args) => block("dns.promises.resolve");
	globalThis.fetch = (..._args) => block("fetch");
	syncBuiltinESMExports();
}

function boundedArgument(value) {
	return String(value).replace(/[\r\n]/g, " ").slice(0, 240);
}

function logEvent(type, details) {
	appendFileSync(
		logPath,
		`${JSON.stringify({ type, at: new Date().toISOString(), ...details })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}
