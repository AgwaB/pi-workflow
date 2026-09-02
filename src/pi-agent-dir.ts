import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * Pi's per-user config directory. Pi documents `PI_CODING_AGENT_DIR` as the
 * override for its default `~/.pi/agent`; every user-scoped lookup (global
 * workflows, user agents, auth type probe, shared backoff state) must follow
 * the same directory Pi itself uses.
 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[PI_CODING_AGENT_DIR_ENV]?.trim();
	return override ? resolve(override) : join(homedir(), ".pi", "agent");
}
