import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { findSecretLikeText } from "../../tools/release/package-text-scan.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const source = read("src/goal-authenticated-local-channel.ts");
// test:build compiles with the same tsconfig as the published dist/.
const built = read(".tmp/unit/goal-authenticated-local-channel.js");
const armor = ["BEGIN", "OPENSSH", "PRIVATE", "KEY"].join(" ");

test("the Goal channel's OpenSSH host-key armor is the only allowed secret-like text in its package files", () => {
  assert.equal(findSecretLikeText("src/goal-authenticated-local-channel.ts", source), undefined);
  assert.equal(findSecretLikeText("dist/goal-authenticated-local-channel.js", built), undefined);
  // The same text in any other package file still fails.
  assert.equal(findSecretLikeText("dist/other.js", built), armor);
  // Anything else secret-like in the allowed file still fails.
  const pem = `-----BEGIN RSA ${["PRIVATE", "KEY"].join(" ")}-----\nMIIB\n`;
  assert.match(findSecretLikeText("dist/goal-authenticated-local-channel.js", `${built}\n${pem}`), /PRIVATE KEY/);
  const home = ["", "Users", "toby", "x"].join("/");
  assert.equal(findSecretLikeText("src/goal-authenticated-local-channel.ts", `${source}\n// ${home}\n`), home.slice(0, 11));
});

test("an allowed text must be present exactly once", () => {
  const withoutArmor = source.replace(/`-----BEGIN [^`]*-----\\n\$\{body/, "`${body");
  assert.notEqual(withoutArmor, source);
  assert.match(findSecretLikeText("src/goal-authenticated-local-channel.ts", withoutArmor), /^expected exactly one allowed text/);
  assert.match(findSecretLikeText("src/goal-authenticated-local-channel.ts", `${source}\n${source}`), /^expected exactly one allowed text/);
});
