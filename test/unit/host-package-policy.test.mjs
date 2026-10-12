import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

test("host-provided packages are wildcard peers, never runtime dependencies or bundles", () => {
  for (const name of hostPackages) {
    assert.equal(Object.hasOwn(manifest.dependencies ?? {}, name), false, name);
    assert.equal((manifest.bundleDependencies ?? []).includes(name), false, name);
  }
  for (const name of ["@earendil-works/pi-ai","@earendil-works/pi-coding-agent","@earendil-works/pi-tui","typebox"]) {
    assert.equal(manifest.peerDependencies?.[name], "*", name);
    assert.ok(manifest.devDependencies?.[name], `missing development dependency: ${name}`);
  }
});

test("manifest and lockfile retain matching dependency declarations and version", () => {
  const root = lock.packages[""];
  assert.equal(lock.version, manifest.version);
  assert.equal(root.version, manifest.version);
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    assert.deepEqual(root[key] ?? {}, manifest[key] ?? {}, key);
  }
});
