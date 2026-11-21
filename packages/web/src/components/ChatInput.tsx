import { useState, useRef, useCallback, useEffect } from "react";
import { ModelSelector } from "./ModelSelector";
import { WeeklyUsageBadge } from "./WeeklyUsageBadge";
import {
  IconPaperclip,
  IconMic,
  IconSpinner,
  IconEye,
  IconLock,
  IconShield,
  IconShieldAlert,
  IconCheck,
  IconVoiceSpark,
} from "./Icons";
import { api } from "../api/client";
import type { LocalPermissionPolicy, MediaAttachment } from "../types";
import { prepareAttachments } from "../utils/imageAttachments";
import {
  classifyAutoPlannerType,
  resolvePlannerType,
  type PlannerMode,
  type ResolvedPlannerType,
} from "../utils/autoPlanner";
import { DEFAULT_MODEL } from "../constants";
import {
  filterPromptTemplates,
  getAllPromptTemplates,
  loadCustomPromptTemplates,
  saveCustomPromptTemplates,
  type PromptTemplateItem,
} from "../utils/promptTemplates";
const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "image/webp",
];

export type PlannerType = PlannerMode;

interface Props {
  onSend: (
    text: string,
    model: string | null,
    media?: MediaAttachment[],
    plannerType?: ResolvedPlannerType,
  ) => void;
  onStop: () => void;
  isRunning: boolean;
  disabled?: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Active conversation ID; changing chats syncs model to that chat's model. */
  conversationId?: string | null;
  /** Live model ID currently used by the active conversation, if known. */
  conversationModel?: string | null;
  /** Default model from client settings; used as initial selection. */
  defaultModel?: string | null;
  /** Called when ModelSelector auto-heals a retired/missing model ID. */
  onAutoHealDefaultModel?: (model: string) => void;
  /** Default planner type from client settings. */
  defaultPlannerType?: PlannerType;
  /** Local command auto-execution policy (Local Permissions). */
  permissionPolicy?: LocalPermissionPolicy;
  /** Called when the user changes Local Permissions from the composer menu. */
  onPermissionPolicyChange?: (policy: LocalPermissionPolicy) => void;
  /** App edition tier ("lite" = Gemini-only, "pro" = Multi-AI). */
  appTier?: import("../types").AppTier;
  /** Active project's custom instructions (optional, ChatGPT/Claude Projects style). */
  activeProjectInstruction?: {
    projectName: string;
    instructions: string;
  } | null;
}

interface AttachmentPreview {
  file: File;
  dataUrl: string;
}

const PLANNER_OPTIONS: { value: PlannerType; label: string; desc: string }[] = [
  {
    value: "auto",
    label: "自動",
    desc: "依頼内容に応じて高速 / 計画を自動切替",
  },
  {
    value: "conversational",
    label: "高速",
    desc: "即実行・質問・通常修正向け",
  },
  {
    value: "planning",
    label: "計画",
    desc: "計画を作成して確認後に着手",
  },
];

function PlannerTypeSelector({
  plannerType,
  draft,
  onSelect,
}: {
  plannerType: PlannerType;
  draft: string;
  onSelect: (v: PlannerType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const resolvedPreview =
    plannerType === "auto" && draft.trim().length > 0
      ? classifyAutoPlannerType(draft) === "planning"
        ? "自動 · 計画"
        : "自動 · 高速"
      : null;

  const activeLabel =
    resolvedPreview ??
    PLANNER_OPTIONS.find((o) => o.value === plannerType)?.label ??
    "自動";

  return (
    <div className="model-selector" ref={ref}>
      <button
        className="model-selector-btn"
        onClick={() => setOpen((v) => !v)}
        title="実行モードを選択"
      >
        <span className="model-selector-label">{activeLabel}</span>
        <span className="model-selector-caret">▾</span>
      </button>
      {open && (
        <div className="model-selector-dropdown">
          {PLANNER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`model-option ${plannerType === opt.value ? "active" : ""}`}
              onClick={() => {
                onSelect(opt.value);
                setOpen(false);
              }}
            >
              <span className="model-option-label">{opt.label}</span>
              <span className="model-option-meta">{opt.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const LOCAL_PERMISSION_OPTIONS: ReadonlyArray<{
  value: LocalPermissionPolicy;
  label: string;
  desc: string;
  isDefault?: boolean;
}> = [
  {
    value: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
    label: "確認必須",
    desc: "すべてのコマンド実行前に承認を求める",
  },
  {
    value: "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX",
    label: "標準",
    desc: "重要な操作の前に確認を求める",
  },
  {
    value: "CASCADE_COMMANDS_AUTO_EXECUTION_AUTO",
    label: "自動判断",
    desc: "コマンドを実行するか自動で判断する",
  },
  {
    value: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
    label: "ターボ",
    desc: "制限なしですべてのコマンドを自動実行する",
    isDefault: true,
  },
];

function PermissionPolicyIcon({
  policy,
  size = 14,
}: {
  policy: LocalPermissionPolicy;
  size?: number;
}) {
  switch (policy) {
    case "CASCADE_COMMANDS_AUTO_EXECUTION_OFF":
      return <IconEye size={size} />;
    case "CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX":
      return <IconLock size={size} />;
    case "CASCADE_COMMANDS_AUTO_EXECUTION_AUTO":
      return <IconShield size={size} />;
    case "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER":
    default:
      return <IconShieldAlert size={size} />;
  }
}

function LocalPermissionsSelector({
  policy,
  onSelect,
}: {
  policy: LocalPermissionPolicy;
  onSelect: (next: LocalPermissionPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current =
    LOCAL_PERMISSION_OPTIONS.find((o) => o.value === policy) ??
    LOCAL_PERMISSION_OPTIONS[3];

  return (
    <div
      className="model-selector permission-selector"
      ref={ref}
      data-testid="local-permissions-selector"
    >
      <button
        type="button"
        className="model-selector-btn permission-selector-btn"
        onClick={() => setOpen((v) => !v)}
        title={`ローカル実行権限: ${current.label}（${current.desc}）`}
        aria-label={`ローカル実行権限: ${current.label}`}
        aria-expanded={open}
      >
        <span className="permission-selector-icon" aria-hidden="true">
          <PermissionPolicyIcon policy={current.value} size={13} />
        </span>
        <span className="model-selector-label">{current.label}</span>
        <span className="model-selector-caret">▾</span>
      </button>
      {open && (
        <div
          className="model-selector-dropdown permission-dropdown"
          role="menu"
          aria-label="ローカル実行権限"
        >
          <div className="permission-dropdown-header">ローカル実行権限</div>
          {LOCAL_PERMISSION_OPTIONS.map((opt) => {
            const active = opt.value === current.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`model-option permission-option ${active ? "active" : ""}`}
                onClick={() => {
                  onSelect(opt.value);
                  setOpen(false);
                }}
              >
                <span className="permission-option-icon" aria-hidden="true">
                  <PermissionPolicyIcon policy={opt.value} size={15} />
                </span>
                <span className="permission-option-body">
                  <span className="permission-option-title-row">
                    <span className="model-option-label">{opt.label}</span>
                    {opt.isDefault && (
                      <span className="permission-default-badge">既定</span>
                    )}
                  </span>
                  <span className="model-option-meta">{opt.desc}</span>
                </span>
                {active && (
                  <span className="permission-option-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Encode a browser-recorded audio Blob into 16kHz 16-bit mono WAV for Antigravity native STT. */
async function convertBlobToWav16k(blob: Blob): Promise<Blob | null> {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;

  const ctx = new AudioCtx();
  try {
    const arrBuf = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrBuf.slice(0));
    const targetRate = 16_000;
    const length = Math.max(1, Math.ceil(decoded.duration * targetRate));

    let samples: Float32Array;
    if (typeof OfflineAudioContext !== "undefined") {
      const offline = new OfflineAudioContext(1, length, targetRate);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      samples = rendered.getChannelData(0);
    } else {
      const ch0 = decoded.getChannelData(0);
      const ratio = decoded.sampleRate / targetRate;
      samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const idx = Math.min(ch0.length - 1, Math.floor(i * ratio));
        samples[i] = ch0[idx];
      }
    }

    const dataBytes = samples.length * 2;
    const wavBuf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(wavBuf);
    const writeStr = (off: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(off + i, str.charCodeAt(i));
      }
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([wavBuf], { type: "audio/wav" });
  } catch {
    return null;
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

export function ChatInput({
  onSend,
  onStop,
  isRunning,
  disabled,
  draft,
  onDraftChange,
  conversationId,
  conversationModel,
  defaultModel,
  onAutoHealDefaultModel,
  defaultPlannerType,
  permissionPolicy = "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
  onPermissionPolicyChange,
  appTier = "lite",
  activeProjectInstruction = null,
}: Props) {
  const [slashMenuManualOpen, setSlashMenuManualOpen] = useState(false);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplateItem[]>(
    () => getAllPromptTemplates(),
  );
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [newTplCmd, setNewTplCmd] = useState("");
  const [newTplLabel, setNewTplLabel] = useState("");
  const [newTplBody, setNewTplBody] = useState("");
  const [projectInstructionEnabled, setProjectInstructionEnabled] =
    useState(true);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const slashAutoTrigger = /^\/[^\s\n]*$/.test(draft);
  const slashMenuOpen = slashMenuManualOpen || slashAutoTrigger;
  const filteredTemplates = filterPromptTemplates(
    slashAutoTrigger ? draft : "",
    promptTemplates,
  );

  const applyPromptTemplate = useCallback(
    (item: PromptTemplateItem) => {
      onDraftChange(item.template);
      setSlashMenuManualOpen(false);
      setAddingTemplate(false);
      setSlashSelectedIdx(0);
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 200) + "px";
          el.setSelectionRange(item.template.length, item.template.length);
        }
      }, 0);
    },
    [onDraftChange],
  );

  const handleSaveCustomTemplate = () => {
    const rawCmd = newTplCmd.trim();
    const body = newTplBody.trim();
    if (!rawCmd || !body) return;
    const command = rawCmd.startsWith("/") ? rawCmd : `/${rawCmd}`;
    const item: PromptTemplateItem = {
      id: `custom-${Date.now().toString(36)}`,
      command,
      label: newTplLabel.trim() || command.slice(1),
      description: body.slice(0, 48),
      template: body.endsWith("\n") ? body : `${body}\n\n`,
    };
    const nextCustom = [item, ...loadCustomPromptTemplates()];
    saveCustomPromptTemplates(nextCustom);
    setPromptTemplates(getAllPromptTemplates());
    setNewTplCmd("");
    setNewTplLabel("");
    setNewTplBody("");
    setAddingTemplate(false);
  };

  const handleDeleteCustomTemplate = (id: string) => {
    const nextCustom = loadCustomPromptTemplates().filter((t) => t.id !== id);
    saveCustomPromptTemplates(nextCustom);
    setPromptTemplates(getAllPromptTemplates());
  };
  const effectiveDefault = defaultModel ?? DEFAULT_MODEL;
  const [model, setModel] = useState<string | null>(
    conversationModel ?? effectiveDefault,
  );
  const convKey = conversationId ?? "__new__";
  const prevConvKeyRef = useRef<string>(convKey);
  const manualOverrideConvRef = useRef<string | null>(null);

  // Sync model when switching chats or when the active chat's model resolves,
  // while preserving explicit manual model picks within the same conversation.
  useEffect(() => {
    const switchedChat = prevConvKeyRef.current !== convKey;
    if (switchedChat) {
      prevConvKeyRef.current = convKey;
      manualOverrideConvRef.current = null;
      setModel(conversationModel ?? effectiveDefault);
      return;
    }
    if (manualOverrideConvRef.current === convKey) {
      return;
    }
    setModel(conversationModel ?? effectiveDefault);
  }, [convKey, conversationModel, effectiveDefault]);

  const handleManualModelSelect = useCallback(
    (nextModel: string) => {
      manualOverrideConvRef.current = convKey;
      setModel(nextModel);
    },
    [convKey],
  );

  const effectivePlanner = defaultPlannerType ?? "auto";
  const [plannerType, setPlannerType] = useState<PlannerType>(effectivePlanner);
  const [localPolicy, setLocalPolicy] =
    useState<LocalPermissionPolicy>(permissionPolicy);

  // Sync planner type & permission policy when settings change
  useEffect(() => {
    setPlannerType(effectivePlanner);
  }, [effectivePlanner]);
  useEffect(() => {
    setLocalPolicy(permissionPolicy);
  }, [permissionPolicy]);

  const handleSelectPermissionPolicy = useCallback(
    (next: LocalPermissionPolicy) => {
      setLocalPolicy(next);
      onPermissionPolicyChange?.(next);
    },
    [onPermissionPolicyChange],
  );
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [httpsHintUrl, setHttpsHintUrl] = useState<string | null>(null);
  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceMode, setVoiceMode] = useState<"draft" | "autoSend">("draft");
  const voiceModeRef = useRef<"draft" | "autoSend">("draft");
  const modelRef = useRef(model);
  modelRef.current = model;
  const plannerTypeRef = useRef(plannerType);
  plannerTypeRef.current = plannerType;
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPickerQuery, setAppPickerQuery] = useState("");
  const [installedApps, setInstalledApps] = useState<Array<{ name: string; fileName: string; path: string }>>([]);
  const [appPickerLoading, setAppPickerLoading] = useState(false);
  const appPickerRef = useRef<HTMLDivElement>(null);
  const fileErrorTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndRef = useRef(0);
  const isSubmittingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const stopVoiceStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      stopVoiceStream();
    };
  }, [stopVoiceStream]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [draft]);

  const insertPathMentions = useCallback(
    (paths: string[]) => {
      const cleaned = paths.map((p) => p.trim()).filter(Boolean);
      if (cleaned.length === 0) return;
      const tokens = cleaned.map((p) => `@[${p}]`).join(" ");
      const cur = draftRef.current;
      const sep = cur.length > 0 && !/\s$/.test(cur) ? " " : "";
      onDraftChange(`${cur}${sep}${tokens} `);
      textareaRef.current?.focus();
    },
    [onDraftChange],
  );

  // Listen for native macOS app (.app / folder / file) drag-and-drop events
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ paths?: string[] }>).detail;
      if (detail?.paths && Array.isArray(detail.paths) && detail.paths.length > 0) {
        insertPathMentions(detail.paths);
      }
    };
    window.addEventListener("antigravity-jp-file-drop", handler);
    window.addEventListener("antigravity-jp:insert-paths", handler);
    return () => {
      window.removeEventListener("antigravity-jp-file-drop", handler);
      window.removeEventListener("antigravity-jp:insert-paths", handler);
    };
  }, [insertPathMentions]);

  // Close app picker on outside click
  useEffect(() => {
    if (!appPickerOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (appPickerRef.current && !appPickerRef.current.contains(e.target as Node)) {
        setAppPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [appPickerOpen]);

  const loadInstalledApps = useCallback(async () => {
    setAppPickerLoading(true);
    try {
      const base = import.meta.env.VITE_API_BASE ?? "";
      const res = await fetch(`${base}/api/files/apps`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as {
          apps?: Array<{ name: string; fileName: string; path: string }>;
        };
        setInstalledApps(Array.isArray(data.apps) ? data.apps : []);
      }
    } catch {
      // ignore
    } finally {
      setAppPickerLoading(false);
    }
  }, []);

  const showFileError = useCallback((msg: string, hintUrl?: string) => {
    setFileError(msg);
    setHttpsHintUrl(hintUrl ?? null);
    if (fileErrorTimer.current) clearTimeout(fileErrorTimer.current);
    fileErrorTimer.current = setTimeout(() => {
      setFileError(null);
      setHttpsHintUrl(null);
    }, hintUrl ? 10000 : 4000);
  }, []);

  const handleToggleVoice = useCallback(
    async (mode: "draft" | "autoSend" = "draft") => {
      if (voiceState === "transcribing") return;

      if (voiceState === "recording") {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== "inactive") {
          rec.stop();
        } else {
          stopVoiceStream();
          setVoiceState("idle");
        }
        return;
      }

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        showFileError(
          "音声入力は HTTPS またはローカル環境（localhost / 127.0.0.1）で有効です",
        );
        return;
      }

      voiceModeRef.current = mode;
      setVoiceMode(mode);

      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            },
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];

        const preferredTypes = [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/mp4",
        ];
        const supportedMime =
          typeof MediaRecorder.isTypeSupported === "function"
            ? preferredTypes.find((t) => MediaRecorder.isTypeSupported(t))
            : undefined;

        const recorder = supportedMime
          ? new MediaRecorder(stream, { mimeType: supportedMime })
          : new MediaRecorder(stream);

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            audioChunksRef.current.push(ev.data);
          }
        };

        recorder.onstop = async () => {
          const chunks = audioChunksRef.current;
          audioChunksRef.current = [];
          const mimeType = recorder.mimeType || supportedMime || "audio/webm";
          stopVoiceStream();

          const rawBlob = new Blob(chunks, { type: mimeType });
          if (rawBlob.size < 400) {
            setVoiceState("idle");
            showFileError("音声が短すぎました。もう一度お試しください");
            return;
          }

          setVoiceState("transcribing");
          try {
            // Convert to 16kHz mono WAV so Antigravity's native LS speech-to-text handles it directly
            const wavBlob = await convertBlobToWav16k(rawBlob);
            const uploadBlob = wavBlob ?? rawBlob;
            const uploadName = wavBlob
              ? "voice.wav"
              : mimeType.includes("mp4")
                ? "voice.mp4"
                : "voice.webm";
            const result = await api.transcribeVoice(uploadBlob, uploadName, "ja");
            const recognized = result.text?.trim();
            if (recognized) {
              const current = draftRef.current;
              const sep =
                current.length > 0 && !/[\s\n]$/.test(current) ? " " : "";
              const combined = `${current}${sep}${recognized}`.trim();
              if (voiceModeRef.current === "autoSend" && !disabled) {
                const resolvedPlanner = resolvePlannerType(
                  plannerTypeRef.current,
                  combined,
                );
                onSend(combined, modelRef.current, undefined, resolvedPlanner);
                onDraftChange("");
              } else {
                onDraftChange(`${current}${sep}${recognized}`);
                setTimeout(() => textareaRef.current?.focus(), 20);
              }
            } else {
              showFileError("音声を聞き取れませんでした。もう一度お試しください");
            }
          } catch (err) {
            showFileError(
              err instanceof Error ? err.message : "音声の文字起こしに失敗しました",
            );
          } finally {
            setVoiceState("idle");
          }
        };

        mediaRecorderRef.current = recorder;
        recorder.start();
        setVoiceState("recording");
      } catch (err) {
        stopVoiceStream();
        setVoiceState("idle");
        const msg = err instanceof Error ? err.message : String(err);
        showFileError(`マイクを使用できません: ${msg}`);
      }
    },
    [voiceState, disabled, onSend, onDraftChange, showFileError, stopVoiceStream],
  );

  // Listen to native macOS floating pill / global shortcut (⌃⌥M) and Control+M (⌃M) voice trigger
  useEffect(() => {
    const onVoiceTrigger = () => {
      void handleToggleVoice("draft");
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "m"
      ) {
        e.preventDefault();
        void handleToggleVoice("autoSend");
      }
    };
    window.addEventListener("antigravity-jp-voice-trigger", onVoiceTrigger);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("antigravity-jp-voice-trigger", onVoiceTrigger);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleToggleVoice]);

  const uploadAnyFilesToPaths = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setIsUploadingFiles(true);
      try {
        const base = import.meta.env.VITE_API_BASE ?? "";
        const insertedPaths: string[] = [];
        for (const file of files) {
          if (file.name.toLowerCase().endsWith(".app")) {
            try {
              const res = await fetch(`${base}/api/files/apps`, { cache: "no-store" });
              if (res.ok) {
                const data = (await res.json()) as {
                  apps?: Array<{ name: string; fileName: string; path: string }>;
                };
                const match = (data.apps ?? []).find(
                  (a) => a.fileName.toLowerCase() === file.name.toLowerCase(),
                );
                insertedPaths.push(match?.path ?? `/Applications/${file.name}`);
                continue;
              }
            } catch {
              // fall through
            }
            insertedPaths.push(`/Applications/${file.name}`);
            continue;
          }

          const form = new FormData();
          form.append("file", file, file.name || "attachment.bin");
          const resp = await fetch(`${base}/api/files/upload`, {
            method: "POST",
            body: form,
          });
          if (!resp.ok) {
            let errMsg = `ファイル添付に失敗しました (${resp.status})`;
            try {
              const errJson = (await resp.json()) as { error?: string };
              if (errJson.error) errMsg = errJson.error;
            } catch {
              // ignore
            }
            showFileError(errMsg);
            continue;
          }
          const payload = (await resp.json()) as { ok?: boolean; path?: string };
          if (payload.path) {
            insertedPaths.push(payload.path);
          }
        }
        if (insertedPaths.length > 0) {
          insertPathMentions(insertedPaths);
        }
      } catch (err) {
        showFileError(
          err instanceof Error ? err.message : "ファイルのアップロードに失敗しました",
        );
      } finally {
        setIsUploadingFiles(false);
      }
    },
    [insertPathMentions, showFileError],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const nonImageFiles: File[] = [];
      for (const file of fileArray) {
        if (ALLOWED_TYPES.includes(file.type)) {
          const dataUrl = URL.createObjectURL(file);
          setAttachments((prev) => {
            if (prev.length >= 5) return prev; // max 5 inline image attachments
            return [...prev, { file, dataUrl }];
          });
        } else {
          nonImageFiles.push(file);
        }
      }
      if (nonImageFiles.length > 0) {
        void uploadAnyFilesToPaths(nonImageFiles);
      }
    },
    [uploadAnyFilesToPaths],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      URL.revokeObjectURL(prev[index].dataUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = draft.trim();
    if (
      (!trimmed && attachments.length === 0) ||
      disabled ||
      isPreparingAttachments ||
      isSubmittingRef.current
    ) {
      return;
    }

    isSubmittingRef.current = true;
    setIsPreparingAttachments(true);

    try {
      let media: MediaAttachment[] | undefined;
      if (attachments.length > 0) {
        const prepared = await prepareAttachments(attachments.map((a) => a.file));
        media = prepared.map((attachment) => ({
          mimeType: attachment.mimeType,
          inlineData: attachment.inlineData,
        }));
      }

      const resolvedPlanner = resolvePlannerType(plannerType, trimmed);
      let outgoingText = trimmed || " ";
      if (
        !conversationId &&
        activeProjectInstruction?.instructions &&
        projectInstructionEnabled &&
        trimmed
      ) {
        outgoingText = `【プロジェクト専用指示: ${activeProjectInstruction.projectName}】\n${activeProjectInstruction.instructions}\n\n---\n\n${trimmed}`;
      }
      onSend(outgoingText, model, media, resolvedPlanner);
      onDraftChange("");
      attachments.forEach((attachment) => {
        URL.revokeObjectURL(attachment.dataUrl);
      });
      setAttachments([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch (err) {
      showFileError(
        err instanceof Error ? err.message : "添付ファイルの処理に失敗しました",
      );
    } finally {
      setIsPreparingAttachments(false);
      setTimeout(() => {
        isSubmittingRef.current = false;
      }, 0);
    }
  }, [
    draft,
    attachments,
    disabled,
    isPreparingAttachments,
    onSend,
    model,
    plannerType,
    onDraftChange,
    showFileError,
    conversationId,
    activeProjectInstruction,
    projectInstructionEnabled,
  ]);

  const inputDisabled = disabled || isPreparingAttachments;

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndRef.current = Date.now();
  };

  const handleBlur = () => {
    // Prevent stuck IME composing state if focus leaves textarea mid-composition
    isComposingRef.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      isComposingRef.current = false;
      if (slashMenuOpen) {
        setSlashMenuManualOpen(false);
        setAddingTemplate(false);
      }
      return;
    }
    if (slashMenuOpen && !addingTemplate && filteredTemplates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelectedIdx((i) => (i + 1) % filteredTemplates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelectedIdx(
          (i) => (i - 1 + filteredTemplates.length) % filteredTemplates.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && slashAutoTrigger)) {
        const picked =
          filteredTemplates[slashSelectedIdx % filteredTemplates.length];
        if (picked) {
          e.preventDefault();
          applyPromptTemplate(picked);
          return;
        }
      }
    }
    // Never send on Enter while Japanese/CJK IME composition is active
    // or during the brief post-compositionend window on macOS WebKit/Chromium.
    if (
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      isComposingRef.current ||
      Date.now() - lastCompositionEndRef.current < 80
    ) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // On touch phones (narrow coarse-pointer screens), Enter inserts a newline — send via button.
      // On macOS desktop narrow windows, Enter still sends immediately!
      const isTouchPhone =
        window.innerWidth <= 480 &&
        (window.matchMedia?.("(pointer: coarse)")?.matches ||
          (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0));
      if (isTouchPhone || inputDisabled || isSubmittingRef.current) return;
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onDraftChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  // Paste handler for images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  // Drag & drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      const dt = e.dataTransfer;
      const uriList = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
      const droppedFileUrls = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("file://"))
        .map((line) => {
          try {
            return decodeURIComponent(new URL(line).pathname).replace(/\/+$/, "");
          } catch {
            return "";
          }
        })
        .filter(Boolean);

      const files = Array.from(dt.files ?? []);
      const imageFiles = files.filter((f) => ALLOWED_TYPES.includes(f.type));
      const nonImageFiles = files.filter((f) => !ALLOWED_TYPES.includes(f.type));

      if (imageFiles.length > 0) {
        addFiles(imageFiles);
      }

      // 1. Direct file:// paths (if provided by browser/OS)
      const nonImageUrlPaths = droppedFileUrls.filter(
        (p) => !/\.(?:png|jpe?g|gif|svg|webp)$/i.test(p),
      );
      if (nonImageUrlPaths.length > 0) {
        insertPathMentions(nonImageUrlPaths);
        return;
      }

      // 2. Any non-image files (.app, PDF, code, Office, zip, audio, video, etc.):
      //    route through addFiles -> uploadAnyFilesToPaths so zero formats are rejected!
      if (nonImageFiles.length > 0) {
        addFiles(nonImageFiles);
      }
    },
    [addFiles, insertPathMentions],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addFiles(e.target.files);
        e.target.value = ""; // reset so same file can be selected again
      }
    },
    [addFiles],
  );

  return (
    <div
      className={`chat-input-area ${dragOver ? "drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File / voice error toast */}
      {fileError && (
        <div className="file-error-toast" role="alert">
          <span>{fileError}</span>
          {httpsHintUrl && (
            <a
              href={httpsHintUrl}
              className="voice-https-link"
              style={{ marginLeft: "10px", textDecoration: "underline", color: "#93c5fd", fontWeight: 600 }}
            >
              HTTPS版を開く →
            </a>
          )}
        </div>
      )}
      {/* Attachment previews (top) */}
      {attachments.length > 0 && (
        <div className="attachment-previews">
          {attachments.map((a, i) => (
            <div key={a.dataUrl} className="attachment-thumb">
              <img src={a.dataUrl} alt="attachment" />
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="chat-input-wrap"
        onClick={(e) => {
          // If the user clicks the wrapping container but not a button or input explicitly, focus the textarea.
          // This prevents "dead zones" where the browser doesn't know what to focus, leading to cursor bugs.
          const target = e.target as HTMLElement;
          if (
            target.tagName !== "BUTTON" &&
            target.tagName !== "TEXTAREA" &&
            target.tagName !== "INPUT" &&
            target.closest("button") === null &&
            target.closest(".model-selector") === null
          ) {
            textareaRef.current?.focus();
          }
        }}
      >
        <div className="chat-input-top" style={{ position: "relative" }}>
          {!conversationId && activeProjectInstruction?.instructions && (
            <div className="chat-project-instruction-pill">
              <button
                type="button"
                className={`chat-project-instruction-toggle ${projectInstructionEnabled ? "on" : "off"}`}
                onClick={() => setProjectInstructionEnabled((v) => !v)}
                title={activeProjectInstruction.instructions}
              >
                📝 {activeProjectInstruction.projectName} の専用指示:{" "}
                {projectInstructionEnabled ? "適用ON" : "一時OFF"}
              </button>
            </div>
          )}
          {slashMenuOpen && (
            <div
              className="slash-command-popover"
              ref={slashMenuRef}
              data-testid="slash-command-popover"
            >
              <div className="slash-command-head">
                <span>⚡ プロンプト＆スラッシュコマンド</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="slash-command-head-btn"
                    onClick={() => setAddingTemplate((v) => !v)}
                  >
                    {addingTemplate ? "一覧へ戻る" : "＋ 自作を追加"}
                  </button>
                  <button
                    type="button"
                    className="slash-command-head-btn"
                    onClick={() => {
                      setSlashMenuManualOpen(false);
                      setAddingTemplate(false);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {addingTemplate ? (
                <div className="slash-command-add-form">
                  <div className="slash-command-add-row">
                    <input
                      type="text"
                      className="ext-input"
                      placeholder="/コマンド名（例: /日報）"
                      value={newTplCmd}
                      onChange={(e) => setNewTplCmd(e.target.value)}
                    />
                    <input
                      type="text"
                      className="ext-input"
                      placeholder="表示名（例: 日報作成）"
                      value={newTplLabel}
                      onChange={(e) => setNewTplLabel(e.target.value)}
                    />
                  </div>
                  <textarea
                    className="ext-textarea"
                    rows={3}
                    placeholder="呼び出した時に挿入するプロンプト本文…"
                    value={newTplBody}
                    onChange={(e) => setNewTplBody(e.target.value)}
                  />
                  <button
                    type="button"
                    className="settings-archive-btn primary"
                    disabled={!newTplCmd.trim() || !newTplBody.trim()}
                    onClick={handleSaveCustomTemplate}
                  >
                    テンプレートを保存
                  </button>
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="slash-command-empty">
                  一致するテンプレートはありません
                </div>
              ) : (
                <div className="slash-command-list">
                  {filteredTemplates.map((item, idx) => (
                    <div
                      key={item.id}
                      className={`slash-command-item ${idx === slashSelectedIdx % filteredTemplates.length ? "active" : ""}`}
                    >
                      <button
                        type="button"
                        className="slash-command-pick-btn"
                        onClick={() => applyPromptTemplate(item)}
                      >
                        <span className="slash-command-cmd">{item.command}</span>
                        <span className="slash-command-label">{item.label}</span>
                        <span className="slash-command-desc">
                          {item.description}
                        </span>
                      </button>
                      {!item.isBuiltin && (
                        <button
                          type="button"
                          className="slash-command-del-btn"
                          title="この自作テンプレートを削除"
                          onClick={() => handleDeleteCustomTemplate(item.id)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder="メッセージを入力..."
            value={draft}
            onChange={handleInput}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={inputDisabled}
          />
        </div>

        <div className="chat-input-bottom">
          <div className="chat-input-bottom-left">
            <button
              className="chat-action-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              title={isUploadingFiles ? "ファイルを保存中..." : "ファイルを添付（画像・PDF・コード・全形式対応）"}
              disabled={inputDisabled || isUploadingFiles}
            >
              {isUploadingFiles ? <IconSpinner size={16} /> : <IconPaperclip size={18} />}
            </button>
            <div className="model-selector" ref={appPickerRef}>
              <button
                type="button"
                className="chat-action-icon-btn"
                onClick={() => {
                  const next = !appPickerOpen;
                  setAppPickerOpen(next);
                  if (next) {
                    setAppPickerQuery("");
                    void loadInstalledApps();
                  }
                }}
                title="Macアプリを参照入力 (@[/Applications/...])"
                aria-label="Macアプリを参照"
                disabled={inputDisabled}
                style={{ fontWeight: 700, fontSize: "14px" }}
              >
                @
              </button>
              {appPickerOpen && (
                <div
                  className="model-selector-dropdown"
                  style={{ left: 0, right: "auto", minWidth: "240px", maxWidth: "300px" }}
                >
                  <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-subtle, #2a2f3d)" }}>
                    <input
                      type="text"
                      value={appPickerQuery}
                      onChange={(e) => setAppPickerQuery(e.target.value)}
                      placeholder="Macアプリを検索 (例: Safari)..."
                      autoFocus
                      style={{
                        width: "100%",
                        background: "var(--bg-primary, #0d0f13)",
                        color: "var(--text-primary, #f3f4f6)",
                        border: "1px solid var(--border-subtle, #2a2f3d)",
                        borderRadius: "6px",
                        padding: "6px 8px",
                        fontSize: "13px",
                        outline: "none",
                      }}
                    />
                  </div>
                  <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                    {appPickerLoading && installedApps.length === 0 ? (
                      <div className="model-option-meta" style={{ padding: "10px 12px" }}>
                        読み込み中…
                      </div>
                    ) : (
                      installedApps
                        .filter((a) => {
                          const q = appPickerQuery.trim().toLowerCase();
                          return !q || a.name.toLowerCase().includes(q) || a.fileName.toLowerCase().includes(q);
                        })
                        .slice(0, 40)
                        .map((app) => (
                          <button
                            key={app.path}
                            type="button"
                            className="model-option"
                            onClick={() => {
                              insertPathMentions([app.path]);
                              setAppPickerOpen(false);
                            }}
                          >
                            <span className="model-option-label">{app.name}</span>
                            <span className="model-option-meta">{app.path}</span>
                          </button>
                        ))
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={`chat-action-icon-btn ${slashMenuOpen ? "active" : ""}`}
              onClick={() => setSlashMenuManualOpen((v) => !v)}
              title="プロンプト集・スラッシュコマンドを開く (/)"
              aria-label="プロンプト集を開く"
              disabled={inputDisabled}
              style={{ fontWeight: 700, fontSize: "14px" }}
              data-testid="slash-command-trigger-btn"
            >
              /
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              style={{
                position: "absolute",
                width: 0,
                height: 0,
                overflow: "hidden",
                opacity: 0,
                pointerEvents: "none",
              }}
              onChange={handleFileSelect}
              disabled={inputDisabled}
            />
          </div>

          <div className="chat-input-bottom-right">
            <WeeklyUsageBadge selectedModel={model} appTier={appTier} />
            <ModelSelector
              selectedModel={model}
              onSelect={handleManualModelSelect}
              onAutoHeal={onAutoHealDefaultModel}
            />
            <PlannerTypeSelector
              plannerType={plannerType}
              draft={draft}
              onSelect={setPlannerType}
            />
            <LocalPermissionsSelector
              policy={localPolicy}
              onSelect={handleSelectPermissionPolicy}
            />
            <button
              type="button"
              className={`chat-action-icon-btn chat-voice-btn ${voiceState === "recording" && voiceMode === "draft" ? "recording" : ""} ${voiceState === "transcribing" && voiceMode === "draft" ? "transcribing" : ""}`}
              onClick={() => void handleToggleVoice("draft")}
              title={
                voiceState === "recording" && voiceMode === "draft"
                  ? "録音を停止して文字起こし"
                  : voiceState === "transcribing" && voiceMode === "draft"
                    ? "本家Antigravity音声で文字起こし中..."
                    : "音声入力（本家Antigravity文字起こし → 入力欄へ挿入）"
              }
              aria-label={
                voiceState === "recording" && voiceMode === "draft"
                  ? "録音を停止"
                  : voiceState === "transcribing" && voiceMode === "draft"
                    ? "文字起こし中"
                    : "音声入力"
              }
              disabled={inputDisabled || voiceState === "transcribing"}
            >
              {voiceState === "transcribing" && voiceMode === "draft" ? (
                <IconSpinner size={15} />
              ) : (
                <IconMic size={16} />
              )}
              {voiceState === "recording" && voiceMode === "draft" && (
                <span className="chat-voice-rec-label">録音中</span>
              )}
            </button>
            {isRunning && (
              <button
                type="button"
                className="chat-stop-btn"
                onClick={onStop}
                title="生成を停止"
              >
                ■
              </button>
            )}
            {draft.trim() || attachments.length > 0 ? (
              <button
                type="button"
                className="chat-send-btn"
                onClick={handleSubmit}
                disabled={inputDisabled}
                title={isPreparingAttachments ? "画像を処理中..." : "送信 (Enter)"}
              >
                ↑
              </button>
            ) : (
              <button
                type="button"
                className={`chat-audio-orb-btn ${voiceState === "recording" && voiceMode === "autoSend" ? "recording" : ""} ${voiceState === "transcribing" && voiceMode === "autoSend" ? "transcribing" : ""}`}
                onClick={() => void handleToggleVoice("autoSend")}
                disabled={inputDisabled || voiceState === "transcribing"}
                title={
                  voiceState === "recording" && voiceMode === "autoSend"
                    ? "録音を停止して自動送信 (⌃M)"
                    : voiceState === "transcribing" && voiceMode === "autoSend"
                      ? "文字起こし＆送信中..."
                      : "音声で即送信 (⌃M)"
                }
                aria-label={
                  voiceState === "recording" && voiceMode === "autoSend"
                    ? "音声即送信の録音を停止"
                    : "音声で即送信"
                }
              >
                {voiceState === "transcribing" && voiceMode === "autoSend" ? (
                  <IconSpinner size={15} />
                ) : (
                  <IconVoiceSpark size={16} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
