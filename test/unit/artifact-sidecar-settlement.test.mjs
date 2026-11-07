import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setWorkflowOutputArtifactWriteHookForTests, writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";

const raw = '<control>{"schema":"fixture","digest":"done"}</control>\n<analysis>fixture</analysis>\n<refs>[]</refs>';
