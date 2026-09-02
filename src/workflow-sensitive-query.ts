const SENSITIVE_QUERY_TOKENS = new Set([
	"access", "auth", "code", "credential", "key", "password", "secret",
	"session", "signature", "sig", "sid", "jwt", "token",
]);

const SENSITIVE_QUERY_COMPOUNDS = new Set([
	"apikey", "authkey", "apisecret", "apitoken", "authtoken", "accesstoken",
	"accesskey", "clientsecret", "authorization", "jwttoken", "secretkey",
	"sessionid", "sessiontoken", "x-amz-credential",
]);

const MAX_SENSITIVE_KEY_DECODE_DEPTH = 8;
const MAX_SENSITIVE_FRAGMENT_DECODE_DEPTH = 8;
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/iu;

/**
 * Decode a key only while every percent escape is well formed.  A bounded,
 * fail-closed loop prevents both recursive encoding bypasses and pathological
 * input from turning the shared policy into an unbounded decoder.
 */
function fullyDecodeSensitiveKey(key: string): string | undefined {
	let decoded = key.trim();
	if (!decoded) return undefined;
	if (!decoded.includes("%")) return decoded;
	for (let depth = 0; depth < MAX_SENSITIVE_KEY_DECODE_DEPTH; depth += 1) {
		if (!decoded.includes("%")) return decoded;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return undefined;
			decoded = next;
		} catch {
			return undefined;
		}
	}
	// Do not classify a key whose encoding depth exceeds the policy bound or
	// whose decoder left a malformed/residual escape behind.
	return decoded.includes("%") ? undefined : decoded;
}

/**
 * Return true for a credential-bearing decoded query key. Malformed or
 * over-depth percent encoding is also sensitive: the decoder cannot establish
 * that the name is benign, so callers must block/redact it rather than treat
 * it as a false negative.
 */
export function isSensitiveWorkflowQueryKey(key: string): boolean {
	const trimmed = key.trim();
	if (!trimmed) return false;
	const decoded = fullyDecodeSensitiveKey(trimmed);
	if (!decoded) return true;
	const camelSeparated = decoded.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	const lower = camelSeparated.toLowerCase();
	if (SENSITIVE_QUERY_COMPOUNDS.has(lower)) return true;
	const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
	return tokens.some(
		(token) => SENSITIVE_QUERY_TOKENS.has(token) || SENSITIVE_QUERY_COMPOUNDS.has(token),
	);
}

/** Redact URLs and credential-bearing assignments in provider text. */
export function redactSensitiveWorkflowText(value: string): string {
	const withUrls = value.replace(
		/https?:\/\/[^\s)\]}>"']+/gi,
		(match) => {
			const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
			const core = trailing ? match.slice(0, -trailing.length) : match;
			try {
				const url = new URL(core);
				for (const key of [...url.searchParams.keys()]) {
					if (!isSensitiveWorkflowQueryKey(key)) continue;
					if (hasUnsafeSensitiveWorkflowQueryKeyEncoding(key)) {
						url.searchParams.delete(key);
						url.searchParams.append("REDACTED", "REDACTED");
					} else {
						url.searchParams.set(key, "REDACTED");
					}
				}
				url.hash = redactSensitiveWorkflowFragment(url.hash);
				url.username = "";
				url.password = "";
				return `${url.href}${trailing}`;
			} catch { return match; }
		},
	);
	// Providers also commonly emit a redirect fragment without retaining the
	// surrounding URL. Cover that representation too, including encoded `=`;
	// ordinary anchors are returned unchanged by the fragment helper.
	const withFragments = withUrls.replace(
		/(^|[\s("'=:)])#([^\s)\]}>"]+)/gu,
		(_whole, prefix, fragment) => `${prefix}${redactSensitiveWorkflowFragment(`#${fragment}`)}`,
	);
	const assignment = /(["']?)([^\s"'=:,;{}]+)\1\s*([=:])\s*(["']?)([^\s"'&,;}]+)\4/gu;
	const redactedAssignments = withFragments.replace(assignment, (whole, quote, key, delimiter, valueQuote) => {
		if (!isSensitiveWorkflowQueryKey(String(key))) return whole;
		return `${quote}${key}${quote}${delimiter}${valueQuote}REDACTED${valueQuote}`;
	});
	return redactedAssignments
		.replace(/(authorization|cookie|set-cookie)\s*:\s*[^\n\r]+/gi, "$1: REDACTED")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer REDACTED")
		.replace(/\/Users\/[^\s:'")]+/g, "/Users/REDACTED");
}

/**
 * Fragments are not exposed through URL.searchParams. Decode their structural
 * separators in a bounded loop before parsing them as query-like data. This
 * catches a credential assignment hidden inside a benign value, for example
 * `foo=bar%26access_token%3Dsecret`, without changing ordinary anchors or
 * benign values that do not contain a sensitive assignment.
 */
export function redactSensitiveWorkflowFragment(hash: string): string {
	if (!hash) return "";
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw) return "";

	// URLSearchParams is deliberately permissive about malformed escapes. Do
	// this validation first so a malformed fragment cannot be retained as an
	// apparently benign value while a later decoder sees a different shape.
	if (hasMalformedPercentEncoding(raw)) return "#REDACTED=REDACTED";

	const decoded = boundedDecodeFragmentStructure(raw);
	if (decoded === undefined) return "#REDACTED=REDACTED";
	try {
		const params = new URLSearchParams(decoded);
		let changed = false;
		for (const key of [...params.keys()]) {
			if (!isSensitiveWorkflowQueryKey(key)) continue;
			const decodedKey = fullyDecodeSensitiveKey(key);
			if (
				hasUnsafeSensitiveWorkflowQueryKeyEncoding(key) ||
				(decodedKey !== undefined && /[&=]/u.test(decodedKey))
			) {
				params.delete(key);
				params.append("REDACTED", "REDACTED");
			} else {
				params.set(key, "REDACTED");
			}
			changed = true;
		}
		return changed ? `#${params.toString()}` : hash;
	} catch {
		// Do not retain a fragment if parsing unexpectedly fails after the
		// bounded decoder accepted it.
		return "#REDACTED=REDACTED";
	}
}

/**
 * Decode enough layers to expose nested `&`/`=` separators, but never recurse
 * without a bound. A residual valid escape at the bound is unsafe because the
 * hidden structure has not been established. Literal percent characters that
 * result from a valid `%25` value do not force another decode layer unless the
 * layer still contains a valid escape.
 */
function boundedDecodeFragmentStructure(raw: string): string | undefined {
	let decoded = raw;
	for (let depth = 0; depth < MAX_SENSITIVE_FRAGMENT_DECODE_DEPTH; depth += 1) {
		if (!decoded.includes("%")) return decoded;
		if (hasMalformedPercentEncoding(decoded)) {
			// A residual malformed escape is only meaningful as a failure once the
			// fragment has query-like structure; plain anchors remain byte-stable.
			return /[&=]/u.test(decoded) ? undefined : raw;
		}
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return decoded;
			decoded = next;
		} catch {
			return undefined;
		}
		if (!PERCENT_ESCAPE_PATTERN.test(decoded)) return decoded;
	}
	// If another valid escape remains, it may still conceal a structural
	// separator. Do not guess at its meaning after the policy bound.
	return PERCENT_ESCAPE_PATTERN.test(decoded) ? undefined : decoded;
}

function hasMalformedPercentEncoding(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "%") continue;
		if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) return true;
		index += 2;
	}
	return false;
}

export function hasSensitiveWorkflowQueryKey(url: URL): boolean {
	for (const key of url.searchParams.keys()) {
		if (isSensitiveWorkflowQueryKey(key)) return true;
	}
	return false;
}

/** True when a sensitive key could not be safely decoded to a stable name. */
export function hasUnsafeSensitiveWorkflowQueryKeyEncoding(key: string): boolean {
	const trimmed = key.trim();
	return Boolean(trimmed && trimmed.includes("%") && !fullyDecodeSensitiveKey(trimmed));
}
