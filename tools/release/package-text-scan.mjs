// Package text scan used by release-check: local paths and secret-like text
// must not ship. A few files legitimately contain secret-like words without
// any secret; each such exact text is listed here, must be present exactly
// once, and is removed before the scan so anything else in the file still fails.

export const SECRET_PATTERN = /\/Users\/toby|\/var\/folders|Desktop|clipboard|Screenshot|API[_-]?KEY|SECRET|PASSWORD|PRIVATE KEY|BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{20,}|(^|[^a-zA-Z])sk-[A-Za-z0-9]{20,}/;

// The Goal channel serializes its in-memory, per-run host key in OpenSSH form
// for ssh2. The armor is followed by the encoded body expression, so no key
// material is in the file.
const OPENSSH_HOST_KEY_ARMOR = [
	"`-----BEGIN OPENSSH PRIVATE KEY-----\\n${body.toString(\"base64\")",
	"\\n-----END OPENSSH PRIVATE KEY-----\\n`",
];

export const ALLOWED_SECRET_LIKE_TEXT = new Map([
	["src/goal-authenticated-local-channel.ts", OPENSSH_HOST_KEY_ARMOR],
	["dist/goal-authenticated-local-channel.js", OPENSSH_HOST_KEY_ARMOR],
]);

/** The first secret-like match in a package file, or undefined when clean. */
export function findSecretLikeText(path, text, allowed = ALLOWED_SECRET_LIKE_TEXT) {
	let rest = text;
	for (const exact of allowed.get(path) ?? []) {
		const first = rest.indexOf(exact);
		if (first < 0 || rest.indexOf(exact, first + 1) >= 0)
			return `expected exactly one allowed text ${JSON.stringify(exact)}`;
		rest = rest.slice(0, first) + rest.slice(first + exact.length);
	}
	return rest.match(SECRET_PATTERN)?.[0];
}
