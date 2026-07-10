import { BlockList, isIP } from "node:net";

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");

const SPECIAL_IPV6 = new BlockList();
for (const [network, prefix] of [
	["2001::", 32],
	["2001:2::", 48],
	["2001:10::", 28],
	["2001:20::", 28],
	["2001:db8::", 32],
	["2002::", 16],
] as const) {
	SPECIAL_IPV6.addSubnet(network, prefix, "ipv6");
}

export function nonPublicIpReason(address: string): string | undefined {
	const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (lower.includes("%")) return "private_host_blocked";

	const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mappedIpv4) return nonPublicIpReason(mappedIpv4);
	const hexMapped = lower.match(
		/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
	);
	if (hexMapped) {
		const high = Number.parseInt(hexMapped[1]!, 16);
		const low = Number.parseInt(hexMapped[2]!, 16);
		return nonPublicIpReason(
			`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
		);
	}

	const family = isIP(lower);
	if (family === 4) return nonPublicIpv4Reason(lower);
	if (family !== 6) return undefined;
	if (!GLOBAL_IPV6.check(lower, "ipv6")) return "private_host_blocked";
	if (SPECIAL_IPV6.check(lower, "ipv6")) return "private_host_blocked";
	return undefined;
}

function nonPublicIpv4Reason(address: string): string | undefined {
	const parts = address.split(".").map((part) => Number(part));
	if (
		parts.length !== 4 ||
		parts.some(
			(part) => !Number.isInteger(part) || part < 0 || part > 255,
		)
	) {
		return "private_host_blocked";
	}
	const [a, b, c, d] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127 || a >= 224)
		return "private_host_blocked";
	if (a === 100 && b >= 64 && b <= 127) return "private_host_blocked";
	if (a === 169 && b === 254) return "private_host_blocked";
	if (a === 172 && b >= 16 && b <= 31) return "private_host_blocked";
	if (a === 192 && b === 168) return "private_host_blocked";
	if (a === 192 && b === 0 && (c === 0 || c === 2))
		return "private_host_blocked";
	if (a === 198 && (b === 18 || b === 19)) return "private_host_blocked";
	if (a === 198 && b === 51 && c === 100) return "private_host_blocked";
	if (a === 203 && b === 0 && c === 113) return "private_host_blocked";
	if (a === 255 && b === 255 && c === 255 && d === 255)
		return "private_host_blocked";
	return undefined;
}
