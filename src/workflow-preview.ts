import { open } from "node:fs/promises";
import { fromProjectPath } from "./store.js";

export const PREVIEW_MAX_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 8 * 1024;

/** Bounded tail IO, including files with no newlines. Never reads the whole log. */
export async function readFileLinesBounded(
	cwd: string,
	projectPath: string | undefined,
	maxLines: number,
	options: { chunkBytes?: number; onRead?: (bytes: number) => void } = {},
): Promise<string[]> {
	if (!projectPath || !Number.isFinite(maxLines) || maxLines <= 0) return [];
	maxLines = Math.floor(maxLines);
	if (maxLines === 0) return [];
	const file = await open(fromProjectPath(cwd, projectPath), "r").catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (!file) return [];
	try {
		const { size } = await file.stat();
		if (!size) return [];
		const requested = options.chunkBytes ?? 64 * 1024;
		const chunkBytes = Number.isFinite(requested) ? Math.max(1, Math.min(PREVIEW_MAX_BYTES, Math.floor(requested))) : 64 * 1024;
		const chunks: Buffer[] = [];
		let position = size;
		let newlineCount = 0;
		let bytes = 0;
		while (position > 0 && newlineCount <= maxLines && bytes < PREVIEW_MAX_BYTES) {
			const length = Math.min(chunkBytes, position, PREVIEW_MAX_BYTES - bytes);
			position -= length;
			const buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await file.read(buffer, 0, length, position);
			if (!bytesRead) break;
			bytes += bytesRead;
			const chunk = buffer.subarray(0, bytesRead);
			chunks.unshift(chunk);
			options.onRead?.(bytesRead);
			for (const byte of chunk) if (byte === 10) newlineCount += 1;
		}
		const data = Buffer.concat(chunks);
		// A byte window may begin inside UTF-8; discard continuation bytes.
		let start = 0;
		while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
		const lines = data.subarray(start).toString("utf8").split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
		let clipped = false;
		const result = lines.slice(-maxLines).map(line => {
			if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
			clipped = true;
			const tail = Buffer.from(line).subarray(-MAX_LINE_BYTES);
			let offset = 0;
			while ((tail[offset]! & 0xc0) === 0x80) offset++;
			return `[line truncated] ${tail.subarray(offset).toString("utf8")}`;
		});
		let outputBytes = result.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
		if ((position > 0 && bytes >= PREVIEW_MAX_BYTES) || clipped || outputBytes > PREVIEW_MAX_BYTES) {
			// Reserve room for metadata, including UTF-8 replacement expansion.
			let omitted = 0;
			while (omitted < result.length && (result.length - omitted >= maxLines || outputBytes > PREVIEW_MAX_BYTES - 256)) {
				outputBytes -= Buffer.byteLength(result[omitted++]!) + 1;
			}
			result.splice(0, omitted);
			result.unshift("[Preview truncated: earlier bytes/lines omitted; read the output/spec file directly for full content.]");
		}
		return result;
	} finally { await file.close(); }
}
