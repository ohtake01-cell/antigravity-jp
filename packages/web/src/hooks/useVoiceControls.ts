import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

export type VoiceLivePhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "コードブロックを省略しました。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("音声データの読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

interface UseVoiceControlsArgs {
  onInsertTranscript: (text: string) => void;
  onSendVoiceMessage: (text: string) => void;
  onError: (message: string) => void;
  latestAssistantReply?: {
    text: string;
    stepIndex: number;
    isRunning: boolean;
  } | null;
  isRunning: boolean;
}

export function useVoiceControls({
  onInsertTranscript,
  onSendVoiceMessage,
  onError,
  latestAssistantReply,
  isRunning,
}: UseVoiceControlsArgs) {
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [livePhase, setLivePhase] = useState<VoiceLivePhase>("idle");
  const [liveMuted, setLiveMuted] = useState(false);
  const [interimText, setInterimText] = useState("");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const liveActiveRef = useRef(false);
  const liveMutedRef = useRef(false);
  const lastSpokenStepRef = useRef<number>(-1);
  const awaitingReplyRef = useRef(false);

  liveActiveRef.current = liveActive;
  liveMutedRef.current = liveMuted;

  const stopAudioCapture = useCallback(() => {
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }
    recognitionRef.current = null;

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      mediaRecorderRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const stopSpeechOutput = useCallback(() => {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    return () => {
      stopAudioCapture();
      stopSpeechOutput();
    };
  }, [stopAudioCapture, stopSpeechOutput]);

  const startRecognitionSession = useCallback(
    (mode: "dictate" | "live") => {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return false;

      stopAudioCapture();
      const rec = new Ctor();
      rec.lang = "ja-JP";
      rec.continuous = mode === "dictate";
      rec.interimResults = true;
      recognitionRef.current = rec;

      let finalBuffer = "";

      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (result.isFinal) {
            finalBuffer += text;
          } else {
            interim += text;
          }
        }
        setInterimText((finalBuffer + interim).trim());

        if (mode === "dictate" && finalBuffer.trim()) {
          const toInsert = finalBuffer.trim();
          finalBuffer = "";
          onInsertTranscript(toInsert);
          setInterimText("");
        }
      };

      rec.onerror = (event) => {
        const errCode = event.error ?? "unknown";
        if (errCode === "aborted") return;
        if (errCode === "not-allowed" || errCode === "service-not-allowed") {
          onError(
            "マイクの使用が許可されていません。システム設定またはブラウザの権限を確認してください。",
          );
        } else if (errCode === "no-speech" && mode === "live") {
          // ライブ対話中に無音だった場合は静かに待機し直す
          return;
        } else {
          onError(`音声認識エラー: ${errCode}`);
        }
        if (mode === "dictate") {
          setDictating(false);
          setInterimText("");
        }
      };

      rec.onend = () => {
        recognitionRef.current = null;
        if (mode === "dictate") {
          if (finalBuffer.trim()) {
            onInsertTranscript(finalBuffer.trim());
          }
          setDictating(false);
          setInterimText("");
          return;
        }

        // Live mode
        if (!liveActiveRef.current) {
          setLivePhase("idle");
          setInterimText("");
          return;
        }

        const spoken = finalBuffer.trim();
        finalBuffer = "";
        setInterimText("");

        if (spoken) {
          awaitingReplyRef.current = true;
          setLivePhase("thinking");
          onSendVoiceMessage(spoken);
        } else if (liveActiveRef.current && !awaitingReplyRef.current) {
          // 無音で終了した場合は軽く間を置いて聞き取り再開
          setTimeout(() => {
            if (liveActiveRef.current && !awaitingReplyRef.current) {
              setLivePhase("listening");
              startRecognitionSession("live");
            }
          }, 400);
        }
      };

      try {
        rec.start();
        if (mode === "dictate") {
          setDictating(true);
        } else {
          setLivePhase("listening");
        }
        return true;
      } catch {
        recognitionRef.current = null;
        return false;
      }
    },
    [onError, onInsertTranscript, onSendVoiceMessage, stopAudioCapture],
  );

  // Fallback recorder -> LS GetTranscription RPC when Web Speech API is unavailable
  const startFallbackRecording = useCallback(
    async (mode: "dictate" | "live") => {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        onError(
          "このブラウザ／環境では音声入力（SpeechRecognition / マイク録音）を利用できません。",
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
        audioChunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
        };

        recorder.onstop = () => {
          const chunks = audioChunksRef.current;
          audioChunksRef.current = [];
          stream.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
          mediaRecorderRef.current = null;

          if (chunks.length === 0) {
            setDictating(false);
            setTranscribing(false);
            if (mode === "live") setLivePhase("idle");
            return;
          }

          setTranscribing(true);
          if (mode === "live") setLivePhase("transcribing");
          const blob = new Blob(chunks, {
            type: recorder.mimeType || "audio/webm",
          });
          void blobToBase64(blob)
            .then((base64) => api.transcribeAudio(base64))
            .then((res) => {
              const text = res.text?.trim();
              if (text) {
                if (mode === "live") {
                  awaitingReplyRef.current = true;
                  setLivePhase("thinking");
                  onSendVoiceMessage(text);
                } else {
                  onInsertTranscript(text);
                }
              } else {
                onError("音声を文字起こしできませんでした。もう一度お試しください。");
                if (mode === "live") setLivePhase("idle");
              }
            })
            .catch(() => {
              onError("音声文字起こしに失敗しました。");
              if (mode === "live") setLivePhase("idle");
            })
            .finally(() => {
              setDictating(false);
              setTranscribing(false);
            });
        };

        recorder.start();
        setDictating(true);
        if (mode === "live") setLivePhase("listening");
      } catch {
        onError(
          "マイクへのアクセスが拒否されました。システム設定でマイク権限を許可してください。",
        );
      }
    },
    [onError, onInsertTranscript, onSendVoiceMessage],
  );

  // Toggle microphone dictation button
  const toggleDictation = useCallback(() => {
    if (liveActive) {
      // ライブモード中ならライブを止めてディクテーションへ切替
      setLiveActive(false);
      liveActiveRef.current = false;
      setLivePhase("idle");
      stopAudioCapture();
      stopSpeechOutput();
    }

    if (dictating) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          stopAudioCapture();
        }
      } else if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      } else {
        setDictating(false);
      }
      return;
    }

    if (!startRecognitionSession("dictate")) {
      void startFallbackRecording("dictate");
    }
  }, [
    dictating,
    liveActive,
    startFallbackRecording,
    startRecognitionSession,
    stopAudioCapture,
    stopSpeechOutput,
  ]);

  // Toggle Live Voice conversation mode (waveform + star button)
  const toggleLiveVoice = useCallback(() => {
    if (liveActive) {
      setLiveActive(false);
      liveActiveRef.current = false;
      awaitingReplyRef.current = false;
      setLivePhase("idle");
      setInterimText("");
      stopAudioCapture();
      stopSpeechOutput();
      return;
    }

    if (dictating) {
      stopAudioCapture();
      setDictating(false);
    }

    lastSpokenStepRef.current = latestAssistantReply?.stepIndex ?? -1;
    awaitingReplyRef.current = false;
    setLiveActive(true);
    liveActiveRef.current = true;
    setInterimText("");

    if (!startRecognitionSession("live")) {
      void startFallbackRecording("live");
    }
  }, [
    dictating,
    latestAssistantReply?.stepIndex,
    liveActive,
    startFallbackRecording,
    startRecognitionSession,
    stopAudioCapture,
    stopSpeechOutput,
  ]);

  // In Live Voice mode, speak new assistant replies once generation finishes
  useEffect(() => {
    if (!liveActive || !latestAssistantReply) return;
    if (isRunning || latestAssistantReply.isRunning) {
      if (awaitingReplyRef.current) {
        setLivePhase("thinking");
      }
      return;
    }
    if (!awaitingReplyRef.current) return;
    if (latestAssistantReply.stepIndex <= lastSpokenStepRef.current) return;

    lastSpokenStepRef.current = latestAssistantReply.stepIndex;
    awaitingReplyRef.current = false;

    const resumeListening = () => {
      if (!liveActiveRef.current) return;
      setLivePhase("listening");
      if (!startRecognitionSession("live")) {
        setLivePhase("idle");
      }
    };

    const spokenText = stripMarkdownForSpeech(latestAssistantReply.text);
    if (
      liveMutedRef.current ||
      !spokenText ||
      typeof window === "undefined" ||
      typeof window.speechSynthesis === "undefined" ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      resumeListening();
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spokenText.slice(0, 1200));
      utterance.lang = "ja-JP";
      utterance.rate = 1.05;
      utterance.onend = () => resumeListening();
      utterance.onerror = () => resumeListening();
      setLivePhase("speaking");
      window.speechSynthesis.speak(utterance);
    } catch {
      resumeListening();
    }
  }, [isRunning, latestAssistantReply, liveActive, startRecognitionSession]);

  const stopSpeakingAndListen = useCallback(() => {
    stopSpeechOutput();
    if (liveActiveRef.current) {
      awaitingReplyRef.current = false;
      setLivePhase("listening");
      startRecognitionSession("live");
    }
  }, [startRecognitionSession, stopSpeechOutput]);

  return {
    dictating,
    transcribing,
    liveActive,
    livePhase,
    liveMuted,
    interimText,
    toggleDictation,
    toggleLiveVoice,
    toggleLiveMute: () => {
      setLiveMuted((v) => {
        const next = !v;
        if (next) stopSpeechOutput();
        return next;
      });
    },
    stopSpeakingAndListen,
  };
}
