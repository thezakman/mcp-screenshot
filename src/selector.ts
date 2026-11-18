import { descriptionSchema } from "./manifest.js";
import type { EvidenceContext } from "./evidence.js";
import { ScreenshotError } from "./errors.js";
import { CaptureService } from "./capture.js";
import {
  ProfileStore,
  profileName,
  regionSchema,
  selectRegion,
} from "./regions.js";
import { saveDestination } from "./settings.js";
import { windowToken } from "./native.js";
import { z } from "zod";
export const selectionSuggestionSchema = z.object({
  region: regionSchema,
  source_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("SHA-256 of the uncropped preview inspected by the agent."),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "Explain what visible content this region includes; shown to the user.",
    ),
});
const actionSchema = z.object({
  action: z.enum([
    "target",
    "refresh",
    "destination",
    "rename",
    "delete",
    "confirm",
    "capture",
  ]),
  name: z.string().optional(),
  draft_name: z.string().optional(),
  description_text: z.string().trim().max(2000).optional(),
  description_language: z.string().optional(),
  case_id: z.string().max(120).optional(),
  new_name: z.string().optional(),
  destination: z.string().optional(),
  target: z.string().optional(),
  region: regionSchema.optional(),
});
async function runSelectorSession(
  service: CaptureService,
  initial: EvidenceContext & {
    reject_same_as?: string[];
    request?: string;
    suggestion?: z.infer<typeof selectionSuggestionSchema>;
    case_id?: string;
    window_id?: number;
    app_name?: string;
    title?: string;
    display?: number;
    name?: string;
    expected_window_token?: string;
  },
  signal: AbortSignal,
) {
  const profiles = new ProfileStore(service.profileDirectory);
  const {
    request,
    suggestion,
    reject_same_as,
    label,
    note,
    description: initialDescription,
    exchange_id,
    tags,
    ...captureTarget
  } = initial;
  let description = initialDescription;
  let target = { ...captureTarget };
  let pendingSuggestion = suggestion;
  let suggestionReason: string | undefined;
  let error: string | undefined;
  let draft: unknown;
  let draftName = initial.name ?? "";
  let project = initial.case_id ?? "";
  let frozen:
    | { metadata: import("./evidence.js").CaptureMetadata; image: string }
    | undefined;
  for (let iteration = 0; iteration < 100; iteration++) {
    signal.throwIfAborted();
    const windows = await service.windows();
    const displays = await service.displays();
    if (!target.window_id && !target.app_name && !target.display) {
      throw new Error(
        "WINDOW_REQUIRED: choose an initial window_id or display.",
      );
    }
    const cached = pendingSuggestion
      ? await service.suggestedPreview(pendingSuggestion.source_sha256, target)
      : undefined;
    const result =
      frozen ??
      cached ??
      (await service.localPreview(
        { ...target, persist: false, include_image: true },
        signal,
      ));
    if (!result.image) throw new Error("Preview unavailable");
    frozen = { metadata: result.metadata, image: result.image };
    if (pendingSuggestion) {
      if (pendingSuggestion.source_sha256 === result.metadata.sha256) {
        draft = pendingSuggestion.region;
        suggestionReason = pendingSuggestion.reason;
      } else {
        error =
          "A imagem mudou desde a sugestão. Selecione a região na prévia atual; o recorte antigo não foi aplicado.";
        draftName = "";
      }
      pendingSuggestion = undefined;
    }
    const w = result.metadata.window;
    // Once inspected, keep refreshes bound to this OS window rather than resolving an app again.
    if (w) target = { window_id: w.id, expected_window_token: windowToken(w) };
    const inventory = await profiles.scan();
    const compatible = inventory.profiles.filter(
      (p) =>
        w &&
        p.app === (w.bundleId || w.app) &&
        p.width === w.bounds.width &&
        p.height === w.bounds.height,
    );
    const context = {
      request,
      captured_at: result.metadata.captured_at,
      description,
      suggestion_reason: suggestionReason,
      destination: service.store.root,
      profiles_directory: profiles.root + "/profiles",
      destination_locked: !!process.env.MCP_SCREENSHOT_DIR,
      profiles: compatible,
      all_profiles: inventory.profiles,
      name: draftName,
      case_id: project,
      initial_region:
        draft ?? compatible.find((p) => p.name === draftName)?.region,
      error:
        [error, ...inventory.warnings].filter(Boolean).join("\n") || undefined,
      targets: [
        ...windows.map((w) => ({
          id: "window:" + w.id,
          title: w.app + " — " + w.title,
        })),
        ...displays.map((d) => ({
          id: "display:" + d.display,
          title: "Monitor " + d.display,
        })),
      ],
      current_target: w ? "window:" + w.id : "display:" + target.display,
    };
    const action = actionSchema.parse(
      await selectRegion(Buffer.from(result.image, "base64"), signal, context),
    );
    signal.throwIfAborted();
    error = undefined;
    if (action.case_id !== undefined) project = action.case_id.trim();
    if (action.region) draft = action.region;
    if (action.draft_name !== undefined) draftName = action.draft_name;
    if (
      action.name !== undefined &&
      ["confirm", "capture"].includes(action.action)
    )
      draftName = action.name;
    try {
      if (
        action.description_text !== undefined &&
        action.action !== "refresh" &&
        action.action !== "target"
      ) {
        const text = action.description_text;
        const language =
          action.description_language ?? description?.language ?? "pt-BR";
        description = text
          ? descriptionSchema.parse({
              text,
              language,
              source:
                text === description?.text && language === description?.language
                  ? description.source
                  : "user",
            })
          : undefined;
      }
      if (action.action === "refresh") {
        description = undefined;
        frozen = undefined;
        draft = undefined;
        draftName = "";
        suggestionReason = undefined;
        // Preserve the selected identity token: refreshing must not adopt a reused OS ID.
      } else if (action.action === "target") {
        description = undefined;
        const match = /^(window|display):(\d+)$/.exec(action.target ?? "");
        if (!match) throw new Error("Invalid target");
        frozen = undefined;
        draft = undefined;
        suggestionReason = undefined;
        draftName = "";
        const id = Number(match[2]);
        if (match[1] === "window") {
          const win = windows.find((w) => w.id === id);
          if (!win) throw new Error("Window no longer available");
          target = { window_id: id, expected_window_token: windowToken(win) };
        } else target = { display: id };
      } else if (action.action === "destination") {
        service.store.root = await saveDestination(action.destination ?? "");
      } else if (action.action === "rename") {
        await profiles.rename(
          profileName.parse(action.name),
          profileName.parse(action.new_name),
        );
        if (draftName === action.name) draftName = action.new_name ?? "";
      } else if (action.action === "delete") {
        await profiles.delete(profileName.parse(action.name));
        if (draftName === action.name) draftName = "";
      } else {
        const region = regionSchema.parse(action.region);
        let profile;
        let pendingProfile;
        if (action.name) {
          if (!w)
            throw new Error(
              "Profiles require a window. Choose a window to save a profile.",
            );
          const candidate = {
            name: profileName.parse(action.name),
            version: 1 as const,
            app: w.bundleId || w.app,
            width: w.bounds.width,
            height: w.bounds.height,
            region,
          };
          const existing = (await profiles.list()).find(
            (p) => p.name === candidate.name,
          );
          if (
            existing &&
            (existing.app !== candidate.app ||
              existing.width !== candidate.width ||
              existing.height !== candidate.height ||
              Object.keys(region).some(
                (k) =>
                  Math.abs(
                    existing.region[k as keyof typeof region] -
                      region[k as keyof typeof region],
                  ) > 1e-8,
              ))
          )
            throw new Error(
              "Name already exists. Use a new name to save adjusted geometry.",
            );
          profile = existing;
          if (!existing) pendingProfile = candidate;
        }
        if (action.action === "capture") {
          const saved = await service.savePreview(
            frozen,
            region,
            {
              case_id: project || undefined,
              label,
              note,
              description,
              exchange_id,
              tags,
            },
            reject_same_as,
            signal,
          );
          if (pendingProfile) {
            try {
              profile = await profiles.save(pendingProfile);
            } catch (e) {
              saved.metadata.warnings.push(
                `Evidence saved, but profile was not created: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          return { region, profile, ...saved };
        }
        signal.throwIfAborted();
        if (pendingProfile) profile = await profiles.save(pendingProfile);
        return {
          region,
          profile,
          window: w,
          display: target.display,
          profile_directory: profiles.root + "/profiles",
          evidence_directory: service.store.root,
        };
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error("Too many selector operations. Reopen the selector.");
}

// Protect the entire multi-step session, including previews, settings and persistence,
// not just the interval while the native dialog is open.
let selectorActive = false;
export async function runSelector(
  ...args: Parameters<typeof runSelectorSession>
) {
  if (selectorActive)
    throw new ScreenshotError(
      "SELECTION_BUSY",
      "Finish or cancel the current selection before opening another.",
      true,
    );
  selectorActive = true;
  try {
    return await runSelectorSession(...args);
  } finally {
    selectorActive = false;
  }
}
