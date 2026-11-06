import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeTask = "LOCAL_SCOPE_ONLY: read the supplied local files; do not search or fetch external sources.";
