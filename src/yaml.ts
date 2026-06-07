interface YamlLine {
  indent: number;
  text: string;
  raw: string;
  line: number;
}

interface ParseResult {
  value: unknown;
  index: number;
}

const RESERVED_MAPPING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseYamlSubset(text: string, sourceName: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(text);

  const lines = tokenizeYaml(text, sourceName);
  if (lines.length === 0) return null;

  const result = parseBlock(lines, 0, lines[0]!.indent);
  if (result.index < lines.length) {
    const line = lines[result.index]!;
    throw yamlError(sourceName, line.line, `unexpected content at indentation ${line.indent}`);
  }
  return result.value;
}

function tokenizeYaml(text: string, sourceName: string): YamlLine[] {
  const rawLines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const lines: YamlLine[] = [];
  let sawContent = false;

  for (const [index, raw] of rawLines.entries()) {
    const lineNumber = index + 1;
    const indentText = raw.match(/^[ \t]*/)?.[0] ?? "";
    if (indentText.includes("\t")) throw yamlError(sourceName, lineNumber, "tabs are not supported for indentation");

    const indent = indentText.length;
    const trimmed = raw.slice(indent).trimEnd();
    const withoutComment = stripYamlComment(trimmed).trimEnd();
    const text = withoutComment.trim();
    if (text === "") {
      lines.push({ indent, text, raw, line: lineNumber });
      continue;
    }

    if (text === "---") {
      if (sawContent) throw yamlError(sourceName, lineNumber, "multiple YAML documents are not supported");
      continue;
    }
    if (text === "..." || text.startsWith("--- ")) {
      throw yamlError(sourceName, lineNumber, "YAML document markers beyond an initial --- are not supported");
    }

    sawContent = true;
    lines.push({ indent, text, raw, line: lineNumber });
  }

  return lines;
}

function parseBlock(lines: YamlLine[], index: number, indent: number): ParseResult {
  index = skipBlankLines(lines, index);
  const line = lines[index];
  if (!line || line.indent < indent) return { value: null, index };
  if (line.indent > indent) throw yamlError("YAML", line.line, "unexpected indentation");
  if (line.text.startsWith("- ")) return parseSequence(lines, index, indent);
  return parseMapping(lines, index, indent);
}

function parseMapping(lines: YamlLine[], index: number, indent: number, target: Record<string, unknown> = createMapping()): ParseResult {
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.text === "") {
      index += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) throw yamlError("YAML", line.line, "unexpected indentation in mapping");
    if (line.text.startsWith("- ")) throw yamlError("YAML", line.line, "sequence item where mapping key was expected");

    const entry = parseMappingEntry(line.text, line.line);
    const valueResult = parseEntryValue(lines, index, indent, entry.valueText);
    setMappingValue(target, entry.key, valueResult.value, line.line);
    index = valueResult.index;
  }

  return { value: target, index };
}

function parseSequence(lines: YamlLine[], index: number, indent: number): ParseResult {
  const values: unknown[] = [];

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.text === "") {
      index += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) throw yamlError("YAML", line.line, "unexpected indentation in sequence");
    if (!line.text.startsWith("- ")) break;

    const itemText = line.text.slice(2).trim();
    if (itemText === "") {
      const childIndex = skipBlankLines(lines, index + 1);
      if (childIndex < lines.length && lines[childIndex]!.indent > indent) {
        const child = parseBlock(lines, childIndex, lines[childIndex]!.indent);
        values.push(child.value);
        index = child.index;
      } else {
        values.push(null);
        index += 1;
      }
      continue;
    }

    if (looksLikeMappingEntry(itemText)) {
      const entry = parseMappingEntry(itemText, line.line);
      const object = createMapping();
      const firstValue = parseEntryValue(lines, index, indent, entry.valueText, true);
      setMappingValue(object, entry.key, firstValue.value, line.line);
      index = firstValue.index;

      if (index < lines.length && lines[index]!.indent > indent) {
        const childIndent = lines[index]!.indent;
        const child = parseMapping(lines, index, childIndent, object);
        index = child.index;
      }

      values.push(object);
      continue;
    }

    values.push(parseScalarValue(itemText, line.line));
    index += 1;
  }

  return { value: values, index };
}

function parseEntryValue(lines: YamlLine[], index: number, indent: number, valueText: string | undefined, fromSequenceItem = false): ParseResult {
  if (valueText === undefined || valueText.trim() === "") {
    if (fromSequenceItem) return { value: null, index: index + 1 };
    const childIndex = skipBlankLines(lines, index + 1);
    if (childIndex < lines.length && lines[childIndex]!.indent > indent) {
      return parseBlock(lines, childIndex, lines[childIndex]!.indent);
    }
    return { value: null, index: index + 1 };
  }

  const trimmed = valueText.trim();
  if (trimmed === "|" || trimmed === ">") return parseBlockScalar(lines, index, indent, trimmed);
  if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
    throw yamlError("YAML", lines[index]!.line, "block scalar modifiers are not supported");
  }

  return { value: parseScalarValue(trimmed, lines[index]!.line), index: index + 1 };
}

function parseBlockScalar(lines: YamlLine[], index: number, parentIndent: number, style: string): ParseResult {
  const parts: string[] = [];
  let cursor = index + 1;
  let childIndent: number | undefined;

  for (let scan = cursor; scan < lines.length; scan += 1) {
    const line = lines[scan]!;
    if (line.text === "") continue;
    if (line.indent <= parentIndent) return { value: "", index: scan };
    childIndent = line.indent;
    break;
  }
  if (childIndent === undefined) return { value: "", index: lines.length };

  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (line.text !== "" && line.indent < childIndent) break;
    parts.push(line.text === "" ? "" : line.raw.slice(Math.min(childIndent, line.raw.length)));
    cursor += 1;
  }
  while (parts.at(-1) === "") parts.pop();

  return {
    value: style === "|" ? parts.join("\n") : foldBlockScalar(parts),
    index: cursor,
  };
}

function foldBlockScalar(parts: string[]): string {
  let folded = "";
  for (const part of parts) {
    if (part.trim() === "") {
      folded = folded.replace(/[ \t]+$/u, "");
      if (folded !== "" && !folded.endsWith("\n\n")) folded += "\n\n";
      continue;
    }
    folded += folded === "" || folded.endsWith("\n\n") ? part.trim() : ` ${part.trim()}`;
  }
  return folded;
}

function skipBlankLines(lines: YamlLine[], index: number): number {
  while (index < lines.length && lines[index]!.text === "") index += 1;
  return index;
}

function parseMappingEntry(text: string, line: number): { key: string; valueText?: string } {
  const separator = findMappingSeparator(text);
  if (separator === -1) throw yamlError("YAML", line, `expected key: value mapping entry: ${text}`);

  const rawKey = text.slice(0, separator).trim();
  if (rawKey === "" || rawKey === "<<") throw yamlError("YAML", line, "empty and merge keys are not supported");
  const key = parseKey(rawKey, line);
  const valueText = text.slice(separator + 1).trim();
  return { key, valueText: valueText === "" ? undefined : valueText };
}

function findMappingSeparator(text: string): number {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === "\"" && char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ":") return index;
  }
  return -1;
}

function looksLikeMappingEntry(text: string): boolean {
  const separator = findMappingSeparator(text);
  if (separator === -1) return false;
  const key = text.slice(0, separator).trim();
  return /^['\"]/.test(key) || /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
}

function parseKey(rawKey: string, line: number): string {
  if (rawKey.startsWith("\"") || rawKey.startsWith("'")) {
    const parsed = parseQuotedString(rawKey, line);
    if (parsed.trim() === "") throw yamlError("YAML", line, "mapping keys must be non-empty");
    rejectReservedMappingKey(parsed, line);
    return parsed;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(rawKey)) throw yamlError("YAML", line, `unsupported mapping key: ${rawKey}`);
  rejectReservedMappingKey(rawKey, line);
  return rawKey;
}

function rejectReservedMappingKey(key: string, line: number): void {
  if (RESERVED_MAPPING_KEYS.has(key)) throw yamlError("YAML", line, `reserved mapping key is not supported: ${key}`);
}

function createMapping(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function setMappingValue(target: Record<string, unknown>, key: string, value: unknown, line: number): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) throw yamlError("YAML", line, `duplicate mapping key: ${key}`);
  target[key] = value;
}

function parseScalarValue(value: string, line: number): unknown {
  rejectUnsupportedYamlValue(value, line);

  if (value === "[]") return [];
  if (value === "{}") return createMapping();
  if (value.startsWith("[")) return parseInlineArray(value, line);
  if (value.startsWith("{")) return parseInlineObject(value, line);
  if (value.startsWith("\"") || value.startsWith("'")) return parseQuotedString(value, line);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function rejectUnsupportedYamlValue(value: string, line: number): void {
  if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    throw yamlError("YAML", line, "anchors, aliases, and tags are not supported");
  }
  if (/\s[&*][A-Za-z0-9_-]+(?:\s|$)/.test(value)) {
    throw yamlError("YAML", line, "anchors and aliases are not supported");
  }
}

function parseInlineArray(value: string, line: number): unknown[] {
  if (!value.startsWith("[") || !value.endsWith("]")) throw yamlError("YAML", line, "invalid inline array");
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return splitTopLevel(inner, line).map((item) => parseScalarValue(item.trim(), line));
}

function parseInlineObject(value: string, line: number): Record<string, unknown> {
  if (!value.startsWith("{") || !value.endsWith("}")) throw yamlError("YAML", line, "invalid inline object");
  const inner = value.slice(1, -1).trim();
  if (inner === "") return createMapping();

  const object = createMapping();
  for (const item of splitTopLevel(inner, line)) {
    const entry = parseMappingEntry(item.trim(), line);
    if (entry.valueText === undefined) throw yamlError("YAML", line, "inline object values are required");
    setMappingValue(object, entry.key, parseScalarValue(entry.valueText, line), line);
  }
  return object;
}

function splitTopLevel(value: string, line: number): string[] {
  const parts: string[] = [];
  let quote: "'" | "\"" | undefined;
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (quote === "\"" && char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) throw yamlError("YAML", line, "unbalanced inline collection");
  }

  if (quote || depth !== 0) throw yamlError("YAML", line, "unterminated inline collection");
  parts.push(value.slice(start));
  return parts;
}

function parseQuotedString(value: string, line: number): string {
  if (value.startsWith("\"")) {
    if (!value.endsWith("\"")) throw yamlError("YAML", line, "unterminated double-quoted string");
    try {
      return JSON.parse(value) as string;
    } catch (error) {
      throw yamlError("YAML", line, error instanceof Error ? error.message : String(error));
    }
  }

  if (!value.endsWith("'")) throw yamlError("YAML", line, "unterminated single-quoted string");
  return value.slice(1, -1).replaceAll("''", "'");
}

function stripYamlComment(value: string): string {
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (quote === "\"" && char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]!))) return value.slice(0, index);
  }
  return value;
}

function yamlError(sourceName: string, line: number, message: string): Error {
  return new Error(`${sourceName}:${line}: unsupported YAML subset: ${message}`);
}
