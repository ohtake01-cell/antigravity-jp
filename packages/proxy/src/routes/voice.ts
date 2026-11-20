/**
 * /api/voice/* routes — Native Antigravity LS Speech-to-Text (primary),
 * with optional fallback to a user-configured Whisper-compatible ASR endpoint.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Hono } from "hono";
import type { LSInstance } from "../discovery.js";
import { discovery } from "../routing.js";
import {
  getTransportOrder,
  rememberSuccessfulTransport,
  type TransportProtocol,
} from "../transport-hints.js";

const SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const NATIVE_AUDIO_CHUNK_BYTES = 32 * 1024;

function normalizeLanguageCode(lang: string): string {
  const lower = lang.trim().toLowerCase();
  if (!lower || lower === "ja" || lower === "ja-jp") return "ja-JP";
  if (lower === "en" || lower === "en-us") return "en-US";
  return lang.trim();
}

function postNativeJson(
  inst: LSInstance,
  protocol: TransportProtocol,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const requestFn = protocol === "https" ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port: inst.httpsPort,
        path: `/${SERVICE_PREFIX}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": inst.csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Native voice RPC ${method} timed out`));
    });
    req.write(payload);
    req.end();
  });
}

async function transcribeWithNativeLSProtocol(
  inst: LSInstance,
  protocol: TransportProtocol,
  audioBuf: Buffer,
  mimeType: string,
  language: string,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startPayload = Buffer.from(
      JSON.stringify({
        mimeType,
        languageCodes: [normalizeLanguageCode(language)],
      }),
      "utf-8",
    );
    // Connect server-streaming envelope: 1 byte flags + 4 byte big-endian length + JSON
    const frame = Buffer.alloc(5 + startPayload.length);
    frame[0] = 0;
    frame.writeUInt32BE(startPayload.length, 1);
    startPayload.copy(frame, 5);

    let settled = false;
    const finish = (err?: unknown, text?: string) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(text ?? "");
    };

    const requestFn = protocol === "https" ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port: inst.httpsPort,
        path: `/${SERVICE_PREFIX}/StreamAudioTranscription`,
        method: "POST",
        headers: {
          "Content-Type": "application/connect+json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": inst.csrfToken,
          "Content-Length": frame.length,
        },
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        if (res.statusCode !== 200) {
          const errChunks: Buffer[] = [];
          res.on("data", (c: Buffer) => errChunks.push(c));
          res.on("end", () => {
            finish(
              new Error(
                `Native StreamAudioTranscription HTTP ${res.statusCode}: ${Buffer.concat(errChunks).toString("utf-8").slice(0, 200)}`,
              ),
            );
          });
          return;
        }

        let acc = Buffer.alloc(0);
        let latestText = "";
        let finalText = "";
        let sentChunks = false;

        res.on("data", (chunk: Buffer) => {
          acc = Buffer.concat([acc, chunk]);
          while (acc.length >= 5) {
            const flags = acc[0];
            const len = acc.readUInt32BE(1);
            if (acc.length < 5 + len) break;
            const rawMsg = acc.subarray(5, 5 + len).toString("utf-8");
            acc = acc.subarray(5 + len);

            try {
              const msg = JSON.parse(rawMsg) as {
                ready?: { sessionId?: string };
                transcription?: { text?: string; isFinal?: boolean };
                complete?: Record<string, unknown>;
                error?: { code?: string; message?: string };
              };

              if (msg.error) {
                finish(
                  new Error(
                    msg.error.message || msg.error.code || "Native audio stream error",
                  ),
                );
                req.destroy();
                return;
              }

              if (msg.ready?.sessionId && !sentChunks) {
                sentChunks = true;
                const sessionId = msg.ready.sessionId;
                void (async () => {
                  try {
                    let seq = 0;
                    for (
                      let offset = 0;
                      offset < audioBuf.length;
                      offset += NATIVE_AUDIO_CHUNK_BYTES
                    ) {
                      seq++;
                      const slice = audioBuf.subarray(
                        offset,
                        Math.min(audioBuf.length, offset + NATIVE_AUDIO_CHUNK_BYTES),
                      );
                      const chunkRes = await postNativeJson(
                        inst,
                        protocol,
                        "SendAudioChunk",
                        {
                          sessionId,
                          data: slice.toString("base64"),
                          sequenceNumber: seq,
                        },
                      );
                      if (chunkRes.statusCode !== 200) {
                        throw new Error(
                          `SendAudioChunk HTTP ${chunkRes.statusCode}: ${chunkRes.body.slice(0, 150)}`,
                        );
                      }
                    }
                    const endRes = await postNativeJson(
                      inst,
                      protocol,
                      "EndAudioSession",
                      {
                        sessionId,
                        lastSequenceNumber: seq,
                      },
                    );
                    if (endRes.statusCode !== 200) {
                      throw new Error(
                        `EndAudioSession HTTP ${endRes.statusCode}: ${endRes.body.slice(0, 150)}`,
                      );
                    }
                  } catch (streamErr) {
                    finish(streamErr);
                    req.destroy();
                  }
                })();
              }

              if (typeof msg.transcription?.text === "string") {
                const t = msg.transcription.text.trim();
                if (t) {
                  latestText = t;
                  if (msg.transcription.isFinal) {
                    finalText = t;
                  }
                }
              }

              if (msg.complete || (flags & 0x02) !== 0) {
                // Stream finished cleanly
              }
            } catch {
              // Ignore malformed envelope frames
            }
          }
        });

        res.on("end", () => {
          finish(undefined, (finalText || latestText).trim());
        });
        res.on("error", (err) => finish(err));
      },
    );

    req.on("error", (err) => finish(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Native StreamAudioTranscription timed out"));
      finish(new Error("Native StreamAudioTranscription timed out"));
    });
    req.write(frame);
    req.end();
  });
}

async function tryNativeAntigravityTranscribe(
  file: File,
  language: string,
): Promise<{ text: string; engine: string; model: string } | null> {
  if (process.env.VITEST && process.env.PORTA_VOICE_NATIVE !== "1") {
    return null;
  }
  const instances = await discovery.getInstances(false).catch(() => []);
  const target =
    instances.find((i) => i.modelCount === undefined || i.modelCount > 0) ??
    instances[0];
  if (!target) return null;

  const audioBuf = Buffer.from(await file.arrayBuffer());
  const rawType = (file.type || "").toLowerCase();
  const fileName = (file.name || "").toLowerCase();
  const mimeType =
    rawType.includes("wav") || fileName.endsWith(".wav")
      ? "audio/wav"
      : rawType.includes("pcm") || fileName.endsWith(".pcm")
        ? "audio/pcm;rate=16000"
        : rawType || "audio/wav";

  let lastErr: unknown;
  for (const protocol of getTransportOrder(target)) {
    try {
      const text = await transcribeWithNativeLSProtocol(
        target,
        protocol,
        audioBuf,
        mimeType,
        language,
      );
      rememberSuccessfulTransport(target, protocol);
      return {
        text,
        engine: "antigravity-native",
        model: "antigravity-native-stt",
      };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    console.warn(
      "[voice] Native Antigravity STT failed; falling back to local ASR:",
      lastErr instanceof Error ? lastErr.message : String(lastErr),
    );
  }
  return null;
}

export function resolveAsrTranscribeUrl(): string | null {
  const url = (process.env.PORTA_ASR_URL || "").trim();
  return url || null;
}

export function resolveAsrFallbackUrl(): string | null {
  const primary = resolveAsrTranscribeUrl();
  const fallback = (process.env.PORTA_ASR_FALLBACK_URL || "").trim();
  if (!fallback || fallback === primary) return null;
  return fallback;
}

async function postAudio(
  url: string,
  file: File,
  language: string,
  timeoutMs = 30_000,
): Promise<Response> {
  const upstreamForm = new FormData();
  upstreamForm.append("model", "whisper-1");
  upstreamForm.append("language", language);
  upstreamForm.append("file", file, file.name || "voice.webm");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      body: upstreamForm,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function registerVoiceRoutes(app: Hono): void {
  app.post("/api/voice/transcribe", async (c) => {
    const t0 = Date.now();
    try {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "音声ファイルが見つかりません" }, 400);
      }
      if (file.size === 0) {
        return c.json({ error: "音声が空です" }, 400);
      }
      if (file.size > MAX_AUDIO_BYTES) {
        return c.json({ error: "音声ファイルが大きすぎます（上限25MB）" }, 413);
      }

      const language =
        (typeof formData.get("language") === "string"
          ? String(formData.get("language")).trim()
          : "") || "ja";

      // 1. Prefer Antigravity's native Language Server speech-to-text RPC
      const nativeResult = await tryNativeAntigravityTranscribe(file, language);
      if (nativeResult) {
        return c.json({
          text: nativeResult.text,
          model: nativeResult.model,
          engine: nativeResult.engine,
          elapsedMs: Date.now() - t0,
        });
      }

      // 2. Optional fallback to user-configured Whisper-compatible ASR server
      const primaryUrl = resolveAsrTranscribeUrl();
      const fallbackUrl = resolveAsrFallbackUrl();
      if (!primaryUrl && !fallbackUrl) {
        return c.json(
          {
            error:
              "Antigravity ネイティブ音声認識が利用できませんでした。外部 Whisper 互換サーバーを使う場合は PORTA_ASR_URL を設定してください。",
          },
          503,
        );
      }
      let upstreamRes: Response | null = null;
      let primaryErr: unknown = null;

      try {
        if (primaryUrl) {
          upstreamRes = await postAudio(primaryUrl, file, language);
          if (!upstreamRes.ok && upstreamRes.status >= 500 && fallbackUrl) {
            upstreamRes = await postAudio(fallbackUrl, file, language);
          }
        } else if (fallbackUrl) {
          upstreamRes = await postAudio(fallbackUrl, file, language);
        }
      } catch (err) {
        primaryErr = err;
        if (fallbackUrl) {
          upstreamRes = await postAudio(fallbackUrl, file, language);
        }
      }

      if (!upstreamRes) {
        throw primaryErr ?? new Error("音声認識サーバーに接続できませんでした");
      }

      if (!upstreamRes.ok) {
        const detail = await upstreamRes.text().catch(() => "");
        return c.json(
          {
            error: "音声認識サーバーがエラーを返しました",
            detail: detail.slice(0, 200),
          },
          502,
        );
      }

      const payload = (await upstreamRes.json()) as {
        text?: string;
        model?: string;
      };
      return c.json({
        text: (payload.text ?? "").trim(),
        model: payload.model,
        engine: "whisper",
        elapsedMs: Date.now() - t0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: "音声認識サーバーへ接続できませんでした",
          detail: msg,
        },
        503,
      );
    }
  });
}
