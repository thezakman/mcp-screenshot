import { CaptureService } from "./capture.js";
import {
  ProfileStore,
  profileName,
  regionSchema,
  selectRegion,
} from "./regions.js";
import { profilesRoot, saveDestination } from "./settings.js";
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
    "destination",
    "rename",
    "delete",
    "confirm",
    "capture",
  ]),
  name: z.string().optional(),
  draft_name: z.string().optional(),
  case_id: z.string().max(120).optional(),
  new_name: z.string().optional(),
  destination: z.string().optional(),
  target: z.string().optional(),
  region: regionSchema.optional(),
});
export async function runSelector(
  service: CaptureService,
  initial: {
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
  const profiles = new ProfileStore(profilesRoot());
  const { request, suggestion, reject_same_as, ...captureTarget } = initial;
  let target = { ...captureTarget };
  let pendingSuggestion = suggestion;
  let suggestionReason: string | undefined;
  let error: string | undefined;
  let draft: unknown;
  let draftName = initial.name ?? "";
  let project = initial.case_id ?? "";
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
      cached ??
      (await service.capture(
        { ...target, persist: false, include_image: true },
        signal,
      ));
    if (!result.image) throw new Error("Preview unavailable");
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
    const compatible = (await profiles.list()).filter(
      (p) =>
        w &&
        p.app === (w.bundleId || w.app) &&
        p.width === w.bounds.width &&
        p.height === w.bounds.height,
    );
    const context = {
      request,
      suggestion_reason: suggestionReason,
      destination: service.store.root,
      profiles_directory: profiles.root + "/profiles",
      destination_locked: !!process.env.MCP_SCREENSHOT_DIR,
      profiles: compatible,
      all_profiles: await profiles.list(),
      name: draftName,
      case_id: project,
      initial_region:
        draft ?? compatible.find((p) => p.name === draftName)?.region,
      error,
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
      if (action.action === "target") {
        const match = /^(window|display):(\d+)$/.exec(action.target ?? "");
        if (!match) throw new Error("Invalid target");
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
          profile = existing ?? (await profiles.save(candidate));
        }
        if (action.action === "capture")
          return {
            region,
            profile,
            ...(await service.capture(
              {
                ...target,
                case_id: project || undefined,
                name: undefined,
                profile: undefined,
                region,
                reject_same_as,
                persist: true,
                include_image: false,
              } as Parameters<CaptureService["capture"]>[0],
              signal,
            )),
          };
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
