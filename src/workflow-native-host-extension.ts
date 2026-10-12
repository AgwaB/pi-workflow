import { resolve } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	assertWorkflowNativeHostContext,
	captureWorkflowNativeHostContext,
	type WorkflowNativeHostContext,
} from "./workflow-native-host-context.js";

type NativeFactory = () => (pi: ExtensionAPI) => void | Promise<void>;
interface NativeSdk {
	createCodemodeExtension?: NativeFactory;
	createToolSearchExtension?: NativeFactory;
	createMcpExtension?: NativeFactory;
	getAgentDir(): string;
	ProjectTrustStore?: new (
		agentDir: string,
	) => { get(cwd: string): boolean | null };
}

/** Load Pi's implementations, not an adapter or a second MCP configuration parser. */
export async function registerWorkflowNativeHost(
	pi: ExtensionAPI,
	config: WorkflowNativeHostContext,
): Promise<void> {
	assertWorkflowNativeHostContext(config);
	const native: NativeSdk = sdk;
	const [major, minor] = sdk.VERSION.split(".").map(Number);
	if (
		!(major > 1 || (major === 1 && minor >= 1)) ||
		!native.createCodemodeExtension ||
		!native.createToolSearchExtension ||
		!native.createMcpExtension ||
		!native.ProjectTrustStore
	) {
		throw new Error(
			"This workflow requires Pi 1.1 or newer for native codemode and MCP tool-policy support",
		);
	}
	if (resolve(native.getAgentDir()) !== config.agentDir) {
		throw new Error(
			"Workflow parent MCP agent directory changed; refusing a different credential/configuration source",
		);
	}
	const trust = new native.ProjectTrustStore(config.agentDir);
	// Factory/preflight loading must not select a context. Bind only when Pi
	// supplies the documented session context, and release that exact binding.
	let releaseContext: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		releaseContext?.();
		releaseContext = captureWorkflowNativeHostContext(pi, ctx, config);
	});
	pi.on("session_shutdown", () => {
		releaseContext?.();
		releaseContext = undefined;
	});
	await native.createCodemodeExtension()(pi);
	await native.createToolSearchExtension()(pi);
	const mcpApi = new Proxy(pi, {
		get(target, property, receiver) {
			// This contract inherits file-configured native MCP, not child-local registrations.
			if (property === "getMcpServers") return () => [];
			if (property !== "on") return Reflect.get(target, property, receiver);
			// SAFETY: this broad signature only bridges ExtensionAPI.on's overloads;
			// each event and handler is forwarded unchanged to the bound SDK method.
			const registerHandler = target.on.bind(target) as (
				event: string,
				handler: (...args: unknown[]) => unknown,
			) => () => void;
			return (event: string, handler: (...args: unknown[]) => unknown) =>
				registerHandler(event, (...args: unknown[]) => {
					const context = args[1];
					if (context !== null && typeof context === "object") {
						args[1] = new Proxy(context, {
							get(current, key, currentReceiver) {
								if (key === "cwd") return config.cwd;
								if (key === "isProjectTrusted")
									return () => config.projectTrusted && trust.get(config.cwd) !== false;
								return Reflect.get(current, key, currentReceiver);
							},
						});
					}
					return handler(...args);
				});
		},
	});
	await native.createMcpExtension()(mcpApi);
}
