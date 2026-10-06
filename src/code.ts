/// <reference types="@figma/plugin-typings" />

/**
 * Flair Extended Modes
 * -----------------
 * Remaps variables bound on a selection (and its descendants, including
 * nested instance overrides) from whichever library they currently come
 * from to an equivalent variable in a different library, matched by
 * variable name + resolved type. Values are never copied — only which
 * library a token resolves from changes.
 */

type RefKind = "node" | "paint" | "effect";

interface BoundRef {
  kind: RefKind;
  nodeId: string;
  nodeName: string;
  /** top-level boundVariables field, e.g. "opacity", "fills", "effects" */
  field: string;
  /** sub-field for paint/effect entries, e.g. "color", "radius" */
  subField?: string;
  /** index into the fills/strokes/effects array, when kind !== "node" */
  index?: number;
  /** index into a gradient paint's gradientStops array (paint kind only) */
  stopIndex?: number;
  aliasId: string;
}

interface ResolvedRef extends BoundRef {
  variableName: string;
  resolvedType: VariableResolvedDataType;
  currentKey: string;
  /** Best-effort name of the collection this variable currently lives in —
   * helps diagnose "unmatched" tokens that actually live in a different
   * collection than the one picked as target (e.g. shared ref/primitive
   * tokens in their own collection). */
  currentCollectionName?: string;
}

type PlanStatus = "match" | "same" | "unmatched";

interface PlanItem extends ResolvedRef {
  status: PlanStatus;
  targetKey?: string;
}

interface LibraryOption {
  key: string; // library variable collection key, used with getVariablesInLibraryCollectionAsync
  libraryName: string;
  collectionName: string;
  /** Best-effort list of this library's modes/brands, prefetched once so the
   * UI can offer a "search by brand" shortcut at library-selection time. */
  modes: Array<{ modeId: string; name: string }>;
  defaultModeId: string | null;
  /** Local (imported) VariableCollection id, resolved once via the modes
   * probe. Used to detect and clean up stale explicit-mode pins left by
   * previous remaps to a different `[Lib]` library. */
  variableCollectionId: string | null;
}

/** ---- Styles ----
 * Figma's Plugin API has NO team-library browsing API for styles (only for
 * variables), and style objects don't expose which library they came from.
 * So style remapping only works for styles ALREADY used somewhere in this
 * document: we index every remote style referenced anywhere (all pages),
 * and disambiguate same-named styles from different libraries by checking
 * which variable is bound *inside* the style against the target library's
 * known variable keys (styles in this org wrap variables from the same
 * library, so this proves origin without needing a browse API).
 */
type StyleField = "fillStyleId" | "strokeStyleId" | "effectStyleId" | "gridStyleId" | "textStyleId";

interface StyleBoundRef {
  nodeId: string;
  nodeName: string;
  field: StyleField;
  currentStyleId: string;
}

interface ResolvedStyleRef extends StyleBoundRef {
  styleName: string;
  styleType: StyleType;
  currentStyleKey: string;
}

type StylePlanStatus = "match" | "same" | "unmatched" | "ambiguous";

interface StylePlanItem extends ResolvedStyleRef {
  status: StylePlanStatus;
  targetStyleKey?: string;
}

interface RemoteStyleCandidate {
  key: string;
  id: string;
  type: StyleType;
  sampleLocation: string;
  matchedVariableName?: string;
  matchedVariableKey?: string;
}

/** Only libraries whose name starts with this prefix are shown as remap targets. */
const LIBRARY_PREFIX = "[Lib]";

/** Figma's plugin sandbox doesn't implement the full console API (group/table/warn/error
 * can be missing entirely, throwing "console.x is not a function"). Guard every call. */
function safeConsole(method: "log" | "warn" | "error" | "group" | "groupEnd" | "table", ...args: unknown[]) {
  const fn = (console as unknown as Record<string, unknown>)[method];
  if (typeof fn === "function") {
    (fn as (...a: unknown[]) => void).apply(console, args);
  } else if (method !== "groupEnd" && typeof console.log === "function") {
    console.log(...args);
  }
}

let currentPlan: PlanItem[] = [];
let currentStylePlan: StylePlanItem[] = [];
let currentTargetKey: string | null = null;
let currentTargetModes: Array<{ modeId: string; name: string }> = [];
let currentTargetDefaultModeId: string | null = null;
let currentTargetVariableCollectionId: string | null = null;
let styleCandidatesByName = new Map<string, RemoteStyleCandidate[]>();
let styleIndexReady = false; // built once, reused across scans until explicitly rebuilt
let ambiguousStyleChoices = new Map<string, string>(); // styleName -> chosen candidate key

/** Cached across get-libraries calls so handleScan/handleApply can look up
 * sibling collections (same library file, e.g. a "ref/primitives" collection)
 * and every managed library's resolved collection id (for stale-pin cleanup). */
let cachedLibraries: LibraryOption[] = [];
let cachedRawCollections: Array<{ key: string; name: string; libraryName: string }> = [];

// Big perf win for findAllWithCriteria/children traversal on large documents
// with many component instances (per Figma's own docs).
figma.skipInvisibleInstanceChildren = true;

figma.showUI(__html__, { width: 560, height: 720, themeColors: true });

/** Relays the live canvas selection to the UI (Step 2 shows this reactively
 * instead of requiring a manual "check selection" click). */
function postSelectionInfo() {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "selection-changed",
    count: selection.length,
    nodes: selection.map((n) => ({ name: n.name, type: n.type })),
  });
}
figma.on("selectionchange", postSelectionInfo);
postSelectionInfo(); // initial state when the plugin opens

figma.ui.onmessage = async (msg: {
  type: string;
  targetKey?: string;
  pinModeId?: string;
  includeStyles?: boolean;
  styleName?: string;
  styleKey?: string;
}) => {
  try {
    if (msg.type === "get-libraries") {
      await handleGetLibraries();
    } else if (msg.type === "scan") {
      if (!msg.targetKey) throw new Error("No target library selected.");
      await handleScan(msg.targetKey, msg.includeStyles === true);
    } else if (msg.type === "apply") {
      await handleApply(msg.pinModeId || null);
    } else if (msg.type === "choose-style-candidate") {
      if (msg.styleName && msg.styleKey) {
        handleChooseStyleCandidate(msg.styleName, msg.styleKey);
      }
    } else if (msg.type === "rebuild-style-index") {
      await handleRebuildStyleIndex();
    }
  } catch (err) {
    figma.ui.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function handleGetLibraries() {
  const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  safeConsole(
    "log",
    `[Flair Extended Modes] getAvailableLibraryVariableCollectionsAsync returned ${collections.length} collection(s):`,
    collections.map((c) => `${c.libraryName} — ${c.name} (key=${c.key})`)
  );
  cachedRawCollections = collections.map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName }));

  const prefixed = collections.filter((c) => c.libraryName.trim().startsWith(LIBRARY_PREFIX));
  safeConsole("log", `[Flair Extended Modes] ${prefixed.length} collection(s) match the "${LIBRARY_PREFIX}" prefix filter.`);

  // Prefetch each library's modes (cheap: one probe-variable import per
  // library) so Step 1 can offer a "search by brand" shortcut without
  // waiting for a scan.
  const options: LibraryOption[] = await Promise.all(
    prefixed.map(async (c) => {
      const base = {
        key: c.key,
        libraryName: c.libraryName.trim().slice(LIBRARY_PREFIX.length).trim(),
        collectionName: c.name,
        modes: [] as Array<{ modeId: string; name: string }>,
        defaultModeId: null as string | null,
        variableCollectionId: null as string | null,
      };
      try {
        const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
        if (variables.length === 0) return base;
        const probe = await figma.variables.importVariableByKeyAsync(variables[0].key);
        const collection = await figma.variables.getVariableCollectionByIdAsync(probe.variableCollectionId);
        if (collection) {
          base.modes = collection.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
          base.defaultModeId = collection.defaultModeId;
          base.variableCollectionId = collection.id;
        }
      } catch (err) {
        safeConsole("warn", `[Flair Extended Modes] Could not prefetch modes for "${c.libraryName} — ${c.name}":`, err);
      }
      return base;
    })
  );
  cachedLibraries = options;
  figma.ui.postMessage({ type: "libraries", libraries: options });
}

async function handleScan(targetKey: string, includeStyles: boolean) {
  if (figma.currentPage.selection.length === 0) {
    throw new Error("Select at least one layer or component instance first.");
  }
  currentTargetKey = targetKey;

  const targetVariables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(targetKey);
  safeConsole("log", `[Flair Extended Modes] Target library has ${targetVariables.length} variable(s):`, targetVariables.map((v) => v.name));
  const targetByName = new Map<string, { key: string; resolvedType: VariableResolvedDataType }>();
  for (const v of targetVariables) {
    targetByName.set(v.name, { key: v.key, resolvedType: v.resolvedType });
  }

  // Some tokens (e.g. shared "ref/primitive" tokens) live in a SIBLING
  // collection within the same library FILE rather than the one collection
  // you picked as target (which only covers the brand-mode collection).
  // Pull those in too, as a fallback for names not already found above, so
  // they don't show up as "unmatched" purely because of which collection
  // they happen to live in.
  const targetLibraryEntry = cachedRawCollections.find((c) => c.key === targetKey);
  if (targetLibraryEntry) {
    const siblings = cachedRawCollections.filter(
      (c) => c.libraryName === targetLibraryEntry.libraryName && c.key !== targetKey
    );
    for (const sibling of siblings) {
      try {
        const siblingVariables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(sibling.key);
        let addedCount = 0;
        for (const v of siblingVariables) {
          if (!targetByName.has(v.name)) {
            targetByName.set(v.name, { key: v.key, resolvedType: v.resolvedType });
            addedCount++;
          }
        }
        safeConsole(
          "log",
          `[Flair Extended Modes] Sibling collection "${sibling.name}" (same library "${targetLibraryEntry.libraryName}"): ` +
            `${siblingVariables.length} variable(s), ${addedCount} added as fallback matches not already covered by the target collection.`
        );
      } catch (err) {
        safeConsole("warn", `[Flair Extended Modes] Could not read sibling collection "${sibling.name}":`, err);
      }
    }
  }

  // Resolve the target library's actual modes (e.g. Betsson/Starcasino/Nordicbet
  // vs Spino/Btssn.io) so designers can pick exactly which brand to pin to —
  // libraries here have no 1:1 mode correspondence, so a "default mode" guess
  // isn't good enough. This needs one variable imported to resolve the
  // (remote) VariableCollection object, since LibraryVariableCollection itself
  // doesn't expose modes.
  currentTargetModes = [];
  currentTargetDefaultModeId = null;
  currentTargetVariableCollectionId = null;
  if (targetVariables.length > 0) {
    try {
      const probeVariable = await figma.variables.importVariableByKeyAsync(targetVariables[0].key);
      const collection = await figma.variables.getVariableCollectionByIdAsync(probeVariable.variableCollectionId);
      if (collection) {
        currentTargetModes = collection.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
        currentTargetDefaultModeId = collection.defaultModeId;
        currentTargetVariableCollectionId = collection.id;
        safeConsole("log", `[Flair Extended Modes] Target library modes: ${currentTargetModes.map((m) => m.name).join(", ")} (default: ${collection.modes.find((m) => m.modeId === collection.defaultModeId)?.name})`);
      }
    } catch (err) {
      safeConsole("warn", "[Flair Extended Modes] Could not resolve target library's modes:", err);
    }
  }

  const nodes = getScanNodes();
  const rawRefs: BoundRef[] = [];
  for (const node of nodes) {
    rawRefs.push(...collectBoundVariableRefs(node));
  }
  safeConsole("log", `[Flair Extended Modes] Scanned ${nodes.length} node(s), found ${rawRefs.length} bound-variable reference(s).`);

  const resolved: ResolvedRef[] = [];
  const variableCache = new Map<string, Variable | null>();
  const collectionNameCache = new Map<string, string>();
  for (const ref of rawRefs) {
    let variable = variableCache.get(ref.aliasId);
    if (variable === undefined) {
      variable = await figma.variables.getVariableByIdAsync(ref.aliasId);
      variableCache.set(ref.aliasId, variable);
    }
    if (!variable) continue; // dangling reference, skip

    let currentCollectionName = collectionNameCache.get(variable.variableCollectionId);
    if (currentCollectionName === undefined) {
      try {
        const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
        currentCollectionName = collection?.name ?? "(unknown collection)";
      } catch {
        currentCollectionName = "(unknown collection)";
      }
      collectionNameCache.set(variable.variableCollectionId, currentCollectionName);
    }

    resolved.push({
      ...ref,
      variableName: variable.name,
      resolvedType: variable.resolvedType,
      currentKey: variable.key,
      currentCollectionName,
    });
  }

  const plan: PlanItem[] = resolved.map((ref) => {
    const match = targetByName.get(ref.variableName);
    if (!match || match.resolvedType !== ref.resolvedType) {
      return { ...ref, status: "unmatched" };
    }
    if (match.key === ref.currentKey) {
      return { ...ref, status: "same" };
    }
    return { ...ref, status: "match", targetKey: match.key };
  });

  const unmatchedByCollection = new Map<string, Set<string>>();
  for (const p of plan) {
    if (p.status !== "unmatched") continue;
    const coll = p.currentCollectionName ?? "(unknown collection)";
    const set = unmatchedByCollection.get(coll) ?? new Set<string>();
    set.add(p.variableName);
    unmatchedByCollection.set(coll, set);
  }
  if (unmatchedByCollection.size > 0) {
    safeConsole(
      "log",
      `[Flair Extended Modes] Unmatched variables grouped by their CURRENT collection (if any of these aren't "${targetKey}"'s own collection, that's why they don't match — this plugin only searches the one collection you picked as target):`,
      [...unmatchedByCollection.entries()].map(([coll, names]) => `${coll}: ${[...names].join(", ")}`)
    );
  }

  currentPlan = plan;
  safeConsole(
    "log",
    `[Flair Extended Modes] Plan: ${plan.filter((p) => p.status === "match").length} match, ` +
      `${plan.filter((p) => p.status === "same").length} same, ` +
      `${plan.filter((p) => p.status === "unmatched").length} unmatched.`,
    plan.map((p) => `${p.nodeName} :: ${p.field}${p.subField ? "." + p.subField : ""} :: ${p.variableName} -> ${p.status}`)
  );

  if (!includeStyles) {
    currentStylePlan = [];
    styleCandidatesByName = new Map();
  } else {
    const styleRefsRaw: StyleBoundRef[] = [];
    for (const node of nodes) {
      styleRefsRaw.push(...collectStyleRefs(node));
    }

    const styleResolveCache = new Map<string, BaseStyle | null>();
    const resolvedStyleRefs: ResolvedStyleRef[] = [];
    for (const ref of styleRefsRaw) {
      let style = styleResolveCache.get(ref.currentStyleId);
      if (style === undefined) {
        style = await figma.getStyleByIdAsync(ref.currentStyleId);
        styleResolveCache.set(ref.currentStyleId, style);
      }
      if (!style) continue;
      resolvedStyleRefs.push({ ...ref, styleName: style.name, styleType: style.type, currentStyleKey: style.key });
    }
    safeConsole("log", `[Flair Extended Modes] Found ${resolvedStyleRefs.length} style reference(s) on the selection.`);

    if (!styleIndexReady) {
      safeConsole("log", `[Flair Extended Modes] Building whole-document remote style index for the first time (this can take a moment; later scans reuse it)...`);
      styleCandidatesByName = await buildRemoteStyleIndex();
      styleIndexReady = true;
      safeConsole("log", `[Flair Extended Modes] Document style index: ${styleCandidatesByName.size} distinct remote style name(s) found.`);
    } else {
      safeConsole("log", `[Flair Extended Modes] Reusing cached document style index (${styleCandidatesByName.size} style name(s)). Click "Rebuild style index" if you've added new style usages elsewhere in the file.`);
    }

    currentStylePlan = resolvedStyleRefs.map((ref) =>
      resolveStylePlanItem(ref, styleCandidatesByName.get(ref.styleName) ?? [], targetByName, ambiguousStyleChoices.get(ref.styleName))
    );
    safeConsole(
      "log",
      `[Flair Extended Modes] Style plan: ${currentStylePlan.filter((p) => p.status === "match").length} match, ` +
        `${currentStylePlan.filter((p) => p.status === "same").length} same, ` +
        `${currentStylePlan.filter((p) => p.status === "unmatched").length} unmatched, ` +
        `${currentStylePlan.filter((p) => p.status === "ambiguous").length} ambiguous.`
    );
  }

  postScanResult();
}

async function handleRebuildStyleIndex() {
  figma.ui.postMessage({ type: "style-index-building" });
  safeConsole("log", `[Flair Extended Modes] Rebuilding whole-document remote style index...`);
  styleCandidatesByName = await buildRemoteStyleIndex();
  styleIndexReady = true;
  safeConsole("log", `[Flair Extended Modes] Document style index rebuilt: ${styleCandidatesByName.size} distinct remote style name(s) found.`);
  figma.ui.postMessage({ type: "style-index-built", count: styleCandidatesByName.size });
}

function handleChooseStyleCandidate(styleName: string, styleKey: string) {
  ambiguousStyleChoices.set(styleName, styleKey);
  currentStylePlan = currentStylePlan.map((item) =>
    item.styleName === styleName
      ? { ...item, status: styleKey === item.currentStyleKey ? "same" : "match", targetStyleKey: styleKey }
      : item
  );
  postScanResult();
}

function postScanResult() {
  const summary = summarize(currentPlan);
  const styleSummary = {
    total: currentStylePlan.length,
    match: currentStylePlan.filter((p) => p.status === "match").length,
    same: currentStylePlan.filter((p) => p.status === "same").length,
    unmatched: currentStylePlan.filter((p) => p.status === "unmatched").length,
    ambiguous: currentStylePlan.filter((p) => p.status === "ambiguous").length,
  };

  const ambiguousNames = [...new Set(currentStylePlan.filter((p) => p.status === "ambiguous").map((p) => p.styleName))];

  figma.ui.postMessage({
    type: "scan-result",
    summary,
    styleSummary,
    targetModes: currentTargetModes,
    targetDefaultModeId: currentTargetDefaultModeId,
    items: currentPlan.map((p) => ({
      kind: "variable",
      nodeName: p.nodeName,
      field: formatFieldLabel(p),
      variableName: p.variableName,
      resolvedType: p.resolvedType,
      status: p.status,
    })),
    styleItems: currentStylePlan.map((p) => ({
      kind: "style",
      nodeName: p.nodeName,
      field: p.field,
      variableName: `${p.styleName} (${p.styleType})`,
      resolvedType: p.styleType,
      status: p.status,
    })),
    ambiguousStyles: ambiguousNames.map((name) => ({
      name,
      chosen: ambiguousStyleChoices.get(name) ?? null,
      candidates: (styleCandidatesByName.get(name) ?? []).map((c) => ({
        key: c.key,
        sampleLocation: c.sampleLocation,
        matchedVariableName: c.matchedVariableName,
      })),
    })),
  });
}

async function handleApply(pinModeId: string | null) {
  if (currentPlan.length === 0) {
    throw new Error("Run a scan first.");
  }

  const toApply = currentPlan.filter((p) => p.status === "match");
  safeConsole("group", `[Flair Extended Modes] Apply Remap — ${toApply.length} binding(s) to process (target library key=${currentTargetKey})`);

  const importedCache = new Map<string, Variable>();
  let remapped = 0;
  let failed = 0;
  const failures: string[] = [];
  const logRows: Array<{
    node: string;
    property: string;
    token: string;
    fromKey: string;
    toKey: string;
    result: string;
  }> = [];

  for (const item of currentPlan) {
    if (item.status !== "match" || !item.targetKey) continue;
    const property = formatFieldLabel(item);
    try {
      let imported = importedCache.get(item.targetKey);
      if (!imported) {
        imported = await figma.variables.importVariableByKeyAsync(item.targetKey);
        importedCache.set(item.targetKey, imported);
        safeConsole("log", `[Flair Extended Modes] Imported "${imported.name}" (key=${imported.key}) from target library.`);
      }

      const node = await figma.getNodeByIdAsync(item.nodeId);
      if (!node) throw new Error(`Node ${item.nodeName} no longer exists`);

      safeConsole("log", `[Flair Extended Modes] Rebinding "${node.name}" :: ${property} :: "${item.variableName}" (was key=${item.currentKey}) -> imported key=${imported.key}`);
      applyBinding(node as SceneNode, item, imported);

      const after = getBoundVariableIdForItem(node as SceneNode, item);
      const ok = after === imported.id;
      safeConsole("log", `[Flair Extended Modes]   -> after rebind, bound variable id on node: ${after ?? "(none found)"} (expected id=${imported.id}) [${ok ? "OK" : "FAILED"}]`);

      logRows.push({
        node: item.nodeName,
        property,
        token: item.variableName,
        fromKey: item.currentKey,
        toKey: imported.key,
        result: ok ? "remapped" : "did not take effect",
      });

      if (!ok) {
        failed++;
        failures.push(`${item.nodeName} (${property}): binding did not take effect (still ${after ?? "unbound"})`);
        continue;
      }

      remapped++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole("error", `[Flair Extended Modes] Error rebinding "${item.nodeName}" :: ${property}:`, err);
      logRows.push({
        node: item.nodeName,
        property,
        token: item.variableName,
        fromKey: item.currentKey,
        toKey: item.targetKey ?? "",
        result: `error: ${message}`,
      });
      failed++;
      failures.push(`${item.nodeName} (${property}): ${message}`);
    }
  }

  let styleRemapped = 0;
  let styleFailed = 0;
  const importedStyleCache = new Map<string, BaseStyle>();

  for (const item of currentStylePlan) {
    if (item.status !== "match" || !item.targetStyleKey) continue;
    try {
      let importedStyle = importedStyleCache.get(item.targetStyleKey);
      if (!importedStyle) {
        importedStyle = await figma.importStyleByKeyAsync(item.targetStyleKey);
        importedStyleCache.set(item.targetStyleKey, importedStyle);
        safeConsole("log", `[Flair Extended Modes] Imported style "${importedStyle.name}" (key=${importedStyle.key}) from target library.`);
      }

      const node = await figma.getNodeByIdAsync(item.nodeId);
      if (!node) throw new Error(`Node ${item.nodeName} no longer exists`);

      safeConsole("log", `[Flair Extended Modes] Rebinding style "${node.name}" :: ${item.field} :: "${item.styleName}" (was key=${item.currentStyleKey}) -> imported key=${importedStyle.key}`);
      await applyStyleBinding(node as SceneNode, item, importedStyle);

      const after = (node as unknown as Record<StyleField, unknown>)[item.field];
      const ok = after === importedStyle.id;
      safeConsole("log", `[Flair Extended Modes]   -> after rebind, style id on node: ${String(after)} (expected id=${importedStyle.id}) [${ok ? "OK" : "FAILED"}]`);

      logRows.push({
        node: item.nodeName,
        property: item.field,
        token: item.styleName,
        fromKey: item.currentStyleKey,
        toKey: importedStyle.key,
        result: ok ? "remapped" : "did not take effect",
      });

      if (!ok) {
        styleFailed++;
        failures.push(`${item.nodeName} (${item.field}): style binding did not take effect`);
        continue;
      }

      styleRemapped++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeConsole("error", `[Flair Extended Modes] Error rebinding style on "${item.nodeName}" :: ${item.field}:`, err);
      styleFailed++;
      failures.push(`${item.nodeName} (${item.field}): ${message}`);
    }
  }

  if (logRows.length > 0) {
    safeConsole("table", logRows);
  }

  // Clean up stale explicit-mode pins. Figma's explicitVariableModes is a
  // map keyed by collection ID, so a node can carry MULTIPLE simultaneous
  // pins — one per collection it's ever been pinned to. Without this, a
  // node remapped from Library A -> Library B keeps its old pin for
  // Library A's collection forever, which stays frozen/"not reactive" and
  // makes anything still resolving from that old collection look stuck on
  // the previous brand. Only ONE managed [Lib] collection should ever be
  // pinned at a time, and only on the selection root(s) (descendants should
  // simply inherit) — so: clear every OTHER managed collection's pin
  // everywhere in the subtree, and clear the current target's own pin on
  // non-root descendants too (only the root should hold it).
  let clearedCount = 0;
  const managedCollectionIds = new Set(
    cachedLibraries.map((l) => l.variableCollectionId).filter((id): id is string => Boolean(id))
  );
  if (managedCollectionIds.size > 0) {
    const collectionCache = new Map<string, VariableCollection | null>();
    const getCollection = async (id: string) => {
      let c = collectionCache.get(id);
      if (c === undefined) {
        c = await figma.variables.getVariableCollectionByIdAsync(id);
        collectionCache.set(id, c);
      }
      return c;
    };

    const rootIds = new Set(figma.currentPage.selection.map((n) => n.id));
    const scopeNodes = getScanNodes();
    for (const node of scopeNodes) {
      const explicitModes = (node as SceneNode).explicitVariableModes || {};
      for (const collectionId of Object.keys(explicitModes)) {
        if (!managedCollectionIds.has(collectionId)) continue;
        const isRoot = rootIds.has(node.id);
        const isCurrentTargetOnRoot = isRoot && collectionId === currentTargetVariableCollectionId && Boolean(pinModeId);
        if (isCurrentTargetOnRoot) continue; // will be overwritten by the pin step below
        try {
          const collection = await getCollection(collectionId);
          if (collection) {
            (node as SceneNode).clearExplicitVariableModeForCollection(collection);
            clearedCount++;
          }
        } catch (err) {
          failures.push(`Could not clear stale mode pin on "${node.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (clearedCount > 0) {
      safeConsole(
        "log",
        `[Flair Extended Modes] Cleared ${clearedCount} stale mode pin(s) (previous/other [Lib] library collections) across the selection subtree.`
      );
    }
  }

  let pinnedCount = 0;
  let pinnedModeName = "";
  if (pinModeId && currentTargetVariableCollectionId) {
    try {
      const collection = await figma.variables.getVariableCollectionByIdAsync(currentTargetVariableCollectionId);
      if (collection) {
        pinnedModeName = collection.modes.find((m) => m.modeId === pinModeId)?.name ?? pinModeId;
        for (const root of figma.currentPage.selection) {
          try {
            (root as SceneNode).setExplicitVariableModeForCollection(collection, pinModeId);
            pinnedCount++;
          } catch (err) {
            failures.push(`Could not pin mode on "${root.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        safeConsole("log", `[Flair Extended Modes] Pinned ${pinnedCount} selection root node(s) to mode "${pinnedModeName}".`);
      }
    } catch (err) {
      failures.push(`Could not resolve target collection to pin mode: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const unmatched = currentPlan.filter((p) => p.status === "unmatched");
  const styleUnmatched = currentStylePlan.filter((p) => p.status === "unmatched" || p.status === "ambiguous");

  safeConsole(
    "log",
    `[Flair Extended Modes] Apply Remap finished: ${remapped} remapped, ${unmatched.length} unmatched, ${failed} failed` +
      (styleRemapped || styleFailed || styleUnmatched.length
        ? ` | styles: ${styleRemapped} remapped, ${styleUnmatched.length} unmatched, ${styleFailed} failed`
        : "") +
      (pinnedCount ? `, pinned ${pinnedCount} node(s) to "${pinnedModeName}"` : "") +
      "."
  );
  if (failures.length > 0) {
    safeConsole("warn", "[Flair Extended Modes] Failures:", failures);
  }
  safeConsole("groupEnd");

  figma.ui.postMessage({
    type: "apply-result",
    summary: {
      remapped,
      failed,
      unmatched: unmatched.length,
      pinnedCount,
      pinnedModeName,
      styleRemapped,
      styleFailed,
      styleUnmatched: styleUnmatched.length,
    },
    failures,
    unmatchedNames: [...new Set(unmatched.map((u) => `${u.variableName} (from: ${u.currentCollectionName ?? "unknown collection"})`))],
  });

  figma.notify(
    `Flair Extended Modes: ${remapped} remapped, ${unmatched.length} unmatched, ${failed} failed` +
      (styleRemapped || styleFailed || styleUnmatched.length ? ` | styles: ${styleRemapped}/${styleFailed}/${styleUnmatched.length}` : "") +
      (pinnedCount ? `, pinned ${pinnedCount} node(s) to "${pinnedModeName}"` : "") +
      "."
  );
}

function applyBinding(node: SceneNode, item: PlanItem, imported: Variable) {
  if (item.kind === "node") {
    // Scalar field bound directly on the node (opacity, cornerRadius,
    // itemSpacing, paddingLeft, fontSize, lineHeight, characters, etc.)
    (node as unknown as { setBoundVariable: (field: VariableBindableNodeField, v: Variable | null) => void }).setBoundVariable(
      item.field as VariableBindableNodeField,
      imported
    );
    return;
  }

  if (item.kind === "paint") {
    const field = item.field as "fills" | "strokes";
    const paints = (node as MinimalFillsMixin & MinimalStrokesMixin)[field] as Paint[];
    if (!Array.isArray(paints) || item.index === undefined || !item.subField) return;
    const current = paints[item.index];
    if (!current) return;

    if (item.stopIndex !== undefined) {
      // Gradient color stop: no setBoundVariableForX helper exists for this,
      // so the bound stop is built manually and the whole paint/array is
      // replaced (Paint/ColorStop objects are immutable data, like elsewhere).
      const gradient = current as Paint & { gradientStops?: ReadonlyArray<{ position: number; color: RGBA; boundVariables?: Record<string, unknown> }> };
      if (!Array.isArray(gradient.gradientStops)) return;
      const stop = gradient.gradientStops[item.stopIndex];
      if (!stop) return;
      const nextStops = gradient.gradientStops.slice();
      nextStops[item.stopIndex] = {
        ...stop,
        boundVariables: { ...stop.boundVariables, [item.subField]: figma.variables.createVariableAlias(imported) },
      };
      const updatedGradient = { ...gradient, gradientStops: nextStops } as Paint;
      const next = paints.slice();
      next[item.index] = updatedGradient;
      (node as unknown as Record<string, Paint[]>)[field] = next;
      return;
    }

    if (current.type !== "SOLID") return; // only solid paints bind a "color" field today
    const updated = figma.variables.setBoundVariableForPaint(current, item.subField as VariableBindablePaintField, imported);
    const next = paints.slice();
    next[item.index] = updated;
    (node as unknown as Record<string, Paint[]>)[field] = next;
    return;
  }

  if (item.kind === "effect") {
    const effects = (node as BlendMixin).effects as Effect[];
    if (!Array.isArray(effects) || item.index === undefined || !item.subField) return;
    const current = effects[item.index];
    if (!current) return;
    const updated = figma.variables.setBoundVariableForEffect(current, item.subField as VariableBindableEffectField, imported);
    const next = effects.slice();
    next[item.index] = updated;
    (node as unknown as { effects: Effect[] }).effects = next;
    return;
  }
}

/** Re-reads the node right after applyBinding to confirm the new variable id actually stuck. */
function getBoundVariableIdForItem(node: SceneNode, item: PlanItem): string | undefined {
  if (item.kind === "node") {
    const bv = (node as SceneNode & { boundVariables?: Record<string, unknown> }).boundVariables;
    const alias = bv?.[item.field];
    return isVariableAlias(alias) ? alias.id : undefined;
  }

  if (item.kind === "paint" && item.index !== undefined && item.subField) {
    const field = item.field as "fills" | "strokes";
    const paints = (node as MinimalFillsMixin & MinimalStrokesMixin)[field] as Paint[];
    const paint = paints?.[item.index] as (Paint & { boundVariables?: Record<string, unknown>; gradientStops?: Array<{ boundVariables?: Record<string, unknown> }> }) | undefined;
    if (item.stopIndex !== undefined) {
      const alias = paint?.gradientStops?.[item.stopIndex]?.boundVariables?.[item.subField];
      return isVariableAlias(alias) ? alias.id : undefined;
    }
    const alias = paint?.boundVariables?.[item.subField];
    return isVariableAlias(alias) ? alias.id : undefined;
  }

  if (item.kind === "effect" && item.index !== undefined && item.subField) {
    const effects = (node as BlendMixin).effects as Effect[];
    const effect = effects?.[item.index] as (Effect & { boundVariables?: Record<string, unknown> }) | undefined;
    const alias = effect?.boundVariables?.[item.subField];
    return isVariableAlias(alias) ? alias.id : undefined;
  }

  return undefined;
}

/** Human-readable property label, including which gradient stop when relevant. */
function formatFieldLabel(ref: BoundRef): string {
  if (!ref.subField) return ref.field;
  const stop = ref.stopIndex !== undefined ? `[stop ${ref.stopIndex}]` : "";
  return `${ref.field}[${ref.index}]${stop}.${ref.subField}`;
}

function summarize(plan: PlanItem[]) {
  return {
    total: plan.length,
    match: plan.filter((p) => p.status === "match").length,
    same: plan.filter((p) => p.status === "same").length,
    unmatched: plan.filter((p) => p.status === "unmatched").length,
  };
}

/** Recursively collect the selection plus every descendant (incl. nested
 * instance overrides). Uses findAll() instead of manually walking
 * `.children` — Figma's own docs call that pattern out as much slower on
 * large documents. (findAllWithCriteria is even faster but requires at
 * least one criteria like `types`, which doesn't apply when we need every
 * node regardless of type.) */
function getScanNodes(): SceneNode[] {
  const result: SceneNode[] = [];
  for (const node of figma.currentPage.selection) {
    result.push(node);
    if ("findAll" in node) {
      result.push(...(node as SceneNode & ChildrenMixin).findAll());
    }
  }
  return result;
}

/** Collects fillStyleId/strokeStyleId/effectStyleId/gridStyleId/textStyleId
 * off a node, skipping unset ids and figma.mixed (which isn't a string). */
function collectStyleRefs(node: SceneNode): StyleBoundRef[] {
  const refs: StyleBoundRef[] = [];
  const fields: StyleField[] = ["fillStyleId", "strokeStyleId", "effectStyleId", "gridStyleId", "textStyleId"];
  for (const field of fields) {
    if (!(field in node)) continue;
    const value = (node as unknown as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) {
      refs.push({ nodeId: node.id, nodeName: node.name, field, currentStyleId: value });
    }
  }
  return refs;
}

/** Resolves the first variable bound inside a style (its paints/effects/text
 * fields), used to prove which library a same-named style actually came
 * from — see the comment above the style types near the top of this file. */
async function getFirstBoundVariableInStyle(style: BaseStyle): Promise<{ name: string; key: string } | undefined> {
  const aliasIds: string[] = [];

  if (style.type === "PAINT") {
    for (const paint of style.paints as Array<Paint & { boundVariables?: Record<string, unknown>; gradientStops?: Array<{ boundVariables?: Record<string, unknown> }> }>) {
      // Solid paints bind their color directly; gradient paints have no
      // boundVariables of their own — each gradientStop carries its own.
      for (const alias of Object.values(paint.boundVariables ?? {})) {
        if (isVariableAlias(alias)) aliasIds.push(alias.id);
      }
      if (Array.isArray(paint.gradientStops)) {
        for (const stop of paint.gradientStops) {
          for (const alias of Object.values(stop.boundVariables ?? {})) {
            if (isVariableAlias(alias)) aliasIds.push(alias.id);
          }
        }
      }
    }
  } else if (style.type === "EFFECT") {
    for (const effect of style.effects as Array<Effect & { boundVariables?: Record<string, unknown> }>) {
      for (const alias of Object.values(effect.boundVariables ?? {})) {
        if (isVariableAlias(alias)) aliasIds.push(alias.id);
      }
    }
  } else if (style.type === "TEXT") {
    for (const alias of Object.values((style as TextStyle).boundVariables ?? {})) {
      if (isVariableAlias(alias)) aliasIds.push(alias.id);
    }
  }
  // GRID styles are rarely token-driven per-property; skipped for now.

  if (aliasIds.length === 0) return undefined;
  const variable = await figma.variables.getVariableByIdAsync(aliasIds[0]);
  return variable ? { name: variable.name, key: variable.key } : undefined;
}

/** Scans every page of the document for remote (library) styles that are
 * already in use, since the Plugin API has no way to browse a library's
 * styles directly. Groups candidates by style name so same-named styles
 * from different libraries can be disambiguated later. */
async function buildRemoteStyleIndex(): Promise<Map<string, RemoteStyleCandidate[]>> {
  const index = new Map<string, RemoteStyleCandidate[]>();
  const seenStyleIds = new Set<string>();
  const styleCache = new Map<string, BaseStyle | null>();

  for (const page of figma.root.children) {
    await page.loadAsync();
    // findAll() uses Figma's native traversal instead of manually walking
    // `.children` — required for large documents (see comment on
    // getScanNodes above for why the manual pattern is much slower).
    const nodes = page.findAll();
    safeConsole("log", `[Flair Extended Modes] Page "${page.name}": scanning ${nodes.length} node(s) for style usages.`);

    for (const node of nodes) {
      for (const ref of collectStyleRefs(node)) {
        if (seenStyleIds.has(ref.currentStyleId)) continue;
        seenStyleIds.add(ref.currentStyleId);

        let style = styleCache.get(ref.currentStyleId);
        if (style === undefined) {
          style = await figma.getStyleByIdAsync(ref.currentStyleId);
          styleCache.set(ref.currentStyleId, style);
        }
        if (!style || !style.remote) continue;

        const varInfo = await getFirstBoundVariableInStyle(style);
        const candidate: RemoteStyleCandidate = {
          key: style.key,
          id: style.id,
          type: style.type,
          sampleLocation: `${page.name} → ${node.name}`,
          matchedVariableName: varInfo?.name,
          matchedVariableKey: varInfo?.key,
        };

        const list = index.get(style.name) ?? [];
        if (!list.some((c) => c.key === candidate.key)) list.push(candidate);
        index.set(style.name, list);
      }
    }
  }

  return index;
}

/** Decides what a style binding should remap to. Prefers candidates whose
 * internal bound variable's key matches the target library's variable of
 * the same name (proof of origin); falls back to the only candidate found
 * when there's no ambiguity; otherwise defers to the user via
 * `ambiguousStyleChoices` / the UI picker. */
function resolveStylePlanItem(
  ref: ResolvedStyleRef,
  candidates: RemoteStyleCandidate[],
  targetByName: Map<string, { key: string; resolvedType: VariableResolvedDataType }>,
  chosenKey: string | undefined
): StylePlanItem {
  if (chosenKey) {
    return { ...ref, status: chosenKey === ref.currentStyleKey ? "same" : "match", targetStyleKey: chosenKey };
  }
  if (candidates.length === 0) {
    return { ...ref, status: "unmatched" };
  }

  const confirmed = candidates.filter(
    (c) => c.matchedVariableName && targetByName.get(c.matchedVariableName)?.key === c.matchedVariableKey
  );

  if (confirmed.length === 1) {
    return { ...ref, status: confirmed[0].key === ref.currentStyleKey ? "same" : "match", targetStyleKey: confirmed[0].key };
  }
  if (confirmed.length === 0 && candidates.length === 1) {
    return { ...ref, status: candidates[0].key === ref.currentStyleKey ? "same" : "match", targetStyleKey: candidates[0].key };
  }
  return { ...ref, status: "ambiguous" };
}

/** Rebinds a node's style field. Requires the async setters because the
 * manifest uses "documentAccess": "dynamic-page" (direct property
 * assignment is read-only in that mode). */
async function applyStyleBinding(node: SceneNode, item: StylePlanItem, style: BaseStyle) {
  const withSetters = node as unknown as Record<string, ((id: string) => Promise<void>) | undefined>;
  const setterName: Record<StyleField, string> = {
    fillStyleId: "setFillStyleIdAsync",
    strokeStyleId: "setStrokeStyleIdAsync",
    effectStyleId: "setEffectStyleIdAsync",
    gridStyleId: "setGridStyleIdAsync",
    textStyleId: "setTextStyleIdAsync",
  };
  const setter = withSetters[setterName[item.field]];
  if (typeof setter !== "function") {
    throw new Error(`Node does not support ${item.field}`);
  }
  await setter.call(node, style.id);
}

/** Walk a node's boundVariables. Scalar fields (opacity, cornerRadius,
 * itemSpacing, strokeWeight, text fields, ...) live directly on
 * `node.boundVariables[field]` as a VariableAlias. Fills/strokes/effects are
 * NOT nested there (that top-level shape is a flat, unused alias array) —
 * the real per-paint / per-effect bindings live on each individual Paint's
 * or Effect's own `.boundVariables` map, so those are read from
 * `node.fills`/`node.strokes`/`node.effects` directly. */
function collectBoundVariableRefs(node: SceneNode): BoundRef[] {
  const refs: BoundRef[] = [];

  const bv = (node as SceneNode & { boundVariables?: Record<string, unknown> }).boundVariables;
  if (bv) {
    for (const [field, value] of Object.entries(bv)) {
      if (field === "fills" || field === "strokes" || field === "effects" || field === "layoutGrids" || field === "textRangeFills") {
        continue; // handled below via the actual paint/effect objects
      }
      if (isVariableAlias(value)) {
        refs.push({ kind: "node", nodeId: node.id, nodeName: node.name, field, aliasId: value.id });
      }
    }
  }

  if ("fills" in node) {
    collectPaintRefs(node as SceneNode & MinimalFillsMixin, "fills", refs);
  }
  if ("strokes" in node) {
    collectPaintRefs(node as SceneNode & MinimalStrokesMixin, "strokes", refs);
  }
  if ("effects" in node) {
    const effects = (node as SceneNode & BlendMixin).effects as Array<Effect & { boundVariables?: Record<string, unknown> }>;
    effects.forEach((effect, index) => {
      for (const [subField, alias] of Object.entries(effect.boundVariables ?? {})) {
        if (isVariableAlias(alias)) {
          refs.push({ kind: "effect", nodeId: node.id, nodeName: node.name, field: "effects", subField, index, aliasId: alias.id });
        }
      }
    });
  }

  return refs;
}

function collectPaintRefs(node: SceneNode & { fills?: unknown; strokes?: unknown }, field: "fills" | "strokes", refs: BoundRef[]) {
  const paints = node[field] as Paint[] | typeof figma.mixed;
  if (!Array.isArray(paints)) return; // figma.mixed or unsupported
  paints.forEach((paint, index) => {
    // Solid paints bind their color directly on the paint object.
    const withVars = paint as Paint & { boundVariables?: Record<string, unknown> };
    for (const [subField, alias] of Object.entries(withVars.boundVariables ?? {})) {
      if (isVariableAlias(alias)) {
        refs.push({ kind: "paint", nodeId: node.id, nodeName: node.name, field, subField, index, aliasId: alias.id });
      }
    }

    // Gradient paints have NO boundVariables of their own — each color stop
    // inside `gradientStops` carries its own boundVariables.color instead.
    const gradient = paint as Paint & { gradientStops?: Array<{ boundVariables?: Record<string, unknown> }> };
    if (Array.isArray(gradient.gradientStops)) {
      gradient.gradientStops.forEach((stop, stopIndex) => {
        for (const [subField, alias] of Object.entries(stop.boundVariables ?? {})) {
          if (isVariableAlias(alias)) {
            refs.push({ kind: "paint", nodeId: node.id, nodeName: node.name, field, subField, index, stopIndex, aliasId: alias.id });
          }
        }
      });
    }
  });
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as VariableAlias).type === "VARIABLE_ALIAS" &&
    typeof (value as VariableAlias).id === "string"
  );
}
