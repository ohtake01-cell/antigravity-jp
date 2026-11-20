/**
 * /api/permissions & /api/voice/transcribe routes
 *
 * - GET /api/permissions: Read Antigravity global permission preset via GetPermissionSettings RPC
 * - PATCH /api/permissions: Update Antigravity global permission preset via UpdatePermissionSettings RPC
 * - POST /api/voice/transcribe: Transcribe recorded audio via LS GetTranscription RPC
 */

import type { Hono } from "hono";
import { extractTargetAppDataDir, rpcAny } from "../routing.js";
import { handleRPCError } from "../errors.js";

export type LocalPermissionPreset =
  | "request_review"
  | "default"
  | "auto"
  | "turbo";

const PRESET_TO_PROTO: Record<LocalPermissionPreset, string> = {
  request_review: "AGENT_PERMISSION_PRESET_REQUEST_REVIEW",
  default: "AGENT_PERMISSION_PRESET_DEFAULT",
  auto: "AGENT_PERMISSION_PRESET_AUTO",
  turbo: "AGENT_PERMISSION_PRESET_TURBO",
};

const PROTO_TO_PRESET: Record<string, LocalPermissionPreset> = {
  AGENT_PERMISSION_PRESET_REQUEST_REVIEW: "request_review",
  AGENT_PERMISSION_PRESET_DEFAULT: "default",
  AGENT_PERMISSION_PRESET_AUTO: "auto",
  AGENT_PERMISSION_PRESET_TURBO: "turbo",
};

export function protoToLocalPermission(
  proto?: string,
): LocalPermissionPreset {
  if (!proto) return "default";
  return PROTO_TO_PRESET[proto] ?? "default";
}

export function localPermissionToProto(
  preset: unknown,
): string | undefined {
  if (typeof preset !== "string") return undefined;
  return PRESET_TO_PROTO[preset as LocalPermissionPreset];
}

export function registerPermissionAndVoiceRoutes(app: Hono): void {
  app.get("/api/permissions", async (c) => {
    const targetApp = extractTargetAppDataDir(c);
    try {
      const data = await rpcAny<{
        globalPreset?: string;
        globalArtifactReviewMode?: string;
      }>("GetPermissionSettings", {}, targetApp);
      return c.json({
        supported: true,
        preset: protoToLocalPermission(data.globalPreset),
        rawPreset: data.globalPreset ?? null,
        artifactReviewMode: data.globalArtifactReviewMode ?? null,
      });
    } catch {
      return c.json({
        supported: false,
        preset: "default" as LocalPermissionPreset,
        rawPreset: null,
        artifactReviewMode: null,
      });
    }
  });

  app.patch("/api/permissions", async (c) => {
    const targetApp = extractTargetAppDataDir(c);
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const protoPreset = localPermissionToProto(body.preset);
      if (!protoPreset) {
        return c.json(
          {
            error:
              "無効な権限プリセットです（request_review / default / auto / turbo を指定してください）。",
          },
          400,
        );
      }

      const data = await rpcAny(
        "UpdatePermissionSettings",
        { preset: protoPreset },
        targetApp,
      );
      return c.json({
        ok: true,
        preset: body.preset,
        rawPreset: protoPreset,
        data,
      });
    } catch (err) {
      return handleRPCError(c, err);
    }
  });
}
