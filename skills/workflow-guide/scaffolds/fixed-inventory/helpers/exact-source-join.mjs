// Copy with the bundle. Pure, bounded singleton/non-streaming join; no runtime imports.
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && [...value].length <= max;

export function assertInventory(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) throw new Error("inventory requires 1-8 items");
  const ids = new Set();
  for (const item of items) {
    if (!record(item) || Object.keys(item).sort().join(",") !== "id,path" ||
        !text(item.id, 64) || !/^[a-z0-9][a-z0-9_.-]*$/.test(item.id) || item.id.endsWith("-") || item.id === "item" ||
        !text(item.path, 300) || /[\\\x00-\x1f\x7f:]/.test(item.path) || item.path.startsWith("/") ||
        item.path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("invalid inventory id/path: use safe lowercase ids (not item) and relative document paths");
    }
    if (ids.has(item.id.toLowerCase())) throw new Error("duplicate/colliding inventory id");
    ids.add(item.id.toLowerCase());
  }
  return items.map(({ id, path }) => ({ id, path }));
}

function owner(row) {
  const result = {};
  for (const key of ["source", "stageId", "specId", "taskId", "status", "itemIdentity", "placeholderSpecId", "generation", "sourceGeneration", "dispatchMap"]) {
    if (own(row, key)) result[key] = structuredClone(row[key]);
  }
  return result;
}

// Inputs must be runtime controls/statuses from the SAME current snapshot, never model-authored metadata.
// This function cannot authenticate an invented, internally consistent runtime snapshot.
export function reconcileExactSources({ sources, sourceStatuses, inventoryOwner, workerOwner }) {
  if (!record(sources) || !Array.isArray(sourceStatuses) || sourceStatuses.length > 10 || Object.keys(sources).length > 10) {
    throw new Error("join requires bounded sources/statuses (at most 10)");
  }
  if (!record(inventoryOwner) || !text(inventoryOwner.stageId, 300) || !text(inventoryOwner.specId, 300) ||
      !record(workerOwner) || !text(workerOwner.stageId, 230) || workerOwner.placeholderSpecId !== `${workerOwner.stageId}.item`) {
    throw new Error("join requires exact authored stage/spec owners");
  }
  // Bounds apply before cloning metadata or rendering. Overflow blocks, never truncates accounting.
  if (JSON.stringify({ sources, sourceStatuses }).length > 131072) throw new Error("join input exceeds 128 KiB string-unit budget");
  const issues = [];
  const issue = (code, source, detail) => {
    if (issues.length === 64) throw new Error("join diagnostic budget exceeded");
    issues.push({ code, source: text(source, 300) ? source : "", detail });
  };
  const seen = { source: new Set(), taskId: new Set(), specId: new Set() };
  const valid = [];
  for (const row of sourceStatuses) {
    if (!record(row) || !["source", "taskId", "specId", "stageId"].every((key) => text(row[key], 300)) ||
        !["completed", "failed", "blocked", "skipped", "interrupted"].includes(row.status)) {
      issue("malformed-status", row?.source, "Malformed or nonterminal runtime owner");
      continue;
    }
    for (const key of Object.keys(seen)) {
      if (seen[key].has(row[key])) issue("duplicate-owner", row.source, `Duplicate runtime ${key}`);
      seen[key].add(row[key]);
    }
    valid.push(row);
  }
  for (const source of Object.keys(sources)) {
    const matches = valid.filter((row) => row.source === source);
    if (matches.length !== 1) issue("unowned-control", source, "Control must have exactly one exact source owner");
    else if (matches[0].status !== "completed") issue("noncompleted-control", source, "Noncompleted owner cannot supply successful control");
  }
  const producers = valid.filter((row) => row.stageId === inventoryOwner.stageId && row.specId === inventoryOwner.specId &&
    !own(row, "itemIdentity") && !own(row, "placeholderSpecId"));
  let inventory = [];
  let producer;
  if (producers.length !== 1 || producers[0].status !== "completed" || !own(sources, producers[0].source)) {
    issue("inventory-owner", "", "Exactly one completed inventory control and runtime owner required");
  } else {
    producer = producers[0];
    const control = sources[producer.source];
    try {
      if (!record(control) || control.schema !== "fixed-inventory-v1") throw new Error("wrong inventory schema");
      inventory = assertInventory(control.items);
    } catch {
      issue("invalid-inventory", producer.source, "Inventory schema/items invalid; absence is not a zero-item success");
    }
  }
  const workers = [];
  for (const row of valid) {
    if (row === producer) continue;
    // Recognize ONLY the exact scheduling placeholder; never infer domain from an alias prefix.
    if (row.stageId === workerOwner.stageId && row.specId === workerOwner.placeholderSpecId &&
        row.status === "completed" && row.statusDetail === "foreach_materialized" &&
        !own(row, "itemIdentity") && !own(row, "placeholderSpecId") && !own(sources, row.source)) continue;
    if (row.stageId !== workerOwner.stageId || row.placeholderSpecId !== workerOwner.placeholderSpecId ||
        !text(row.itemIdentity, 64) || row.specId !== `${workerOwner.stageId}.${row.itemIdentity}` ||
        row.specId === workerOwner.placeholderSpecId) {
      issue("wrong-worker-owner", row.source, "Wrong stage/spec/item/placeholder owner or unsupported fan-out mode");
      continue;
    }
    workers.push(row);
    if (!inventory.some((item) => item.id === row.itemIdentity)) issue("extra-item", row.source, "Worker identity is not in authoritative inventory");
  }
  const metadataInvalid = issues.length > 0;
  const rows = inventory.map((item) => {
    const matches = workers.filter((row) => row.itemIdentity === item.id);
    const unavailable = { ...item, availability: "unavailable", questions: [], limitations: ["Ownership or worker output unavailable; see integrity diagnostics."] };
    if (matches.length !== 1) {
      issue("missing-or-duplicate-item", "", `Expected exactly one worker for ${item.id}`);
      return unavailable;
    }
    const row = matches[0];
    unavailable.owner = owner(row);
    if (row.status !== "completed" || !own(sources, row.source)) {
      issue("unavailable-worker", row.source, `No completed control for ${item.id}`);
      return unavailable;
    }
    const control = sources[row.source]; // NEVER fall back to an identity-only search.
    if (!validWorker(control) || control.id !== row.itemIdentity || control.path !== item.path) {
      issue("mismatched-control", row.source, `Control does not match assigned id/path for ${item.id}`);
      return unavailable;
    }
    if (metadataInvalid) return unavailable;
    return { ...item, availability: "accepted", owner: owner(row), documentStatus: control.documentStatus,
      questions: [...control.questions], limitations: [...control.limitations] };
  });
  rows.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  const plannedIds = rows.map((row) => row.id);
  const acceptedIds = rows.filter((row) => row.availability === "accepted").map((row) => row.id);
  const missingIds = plannedIds.filter((id) => !acceptedIds.includes(id));
  issues.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const result = { complete: inventory.length > 0 && issues.length === 0 && missingIds.length === 0,
    plannedIds, acceptedIds, missingIds, rows, issues };
  if (producer) result.inventoryOwner = owner(producer);
  return result;
}

function validWorker(value) {
  if (!record(value) || value.schema !== "fixed-item-v1" || !text(value.digest, 600) || !text(value.id, 64) || !text(value.path, 300) ||
      Object.keys(value).sort().join(",") !== "digest,documentStatus,id,limitations,path,questions,schema" ||
      !["read", "partial", "unreadable"].includes(value.documentStatus)) return false;
  return [[value.questions, 6], [value.limitations, 8]].every(([rows, cap]) =>
    Array.isArray(rows) && rows.length <= cap && rows.every((row) => text(row, 500)));
}
