import { useMemo, useState, useCallback, useEffect } from "react";
import { api } from "../api/client";
import { usePolling } from "./usePolling";
import type { ConversationSummary, ConversationsResponse } from "../types";

export interface ConversationEntry {
  id: string;
  summary: ConversationSummary;
}

export function useConversations(intervalMs = 15_000) {
  const [hasAnyRunning, setHasAnyRunning] = useState(false);
  const effectiveInterval = hasAnyRunning ? Math.min(intervalMs, 5_000) : intervalMs;
  const { data, error, loading, refresh } = usePolling<ConversationsResponse>(
    api.conversations,
    effectiveInterval,
  );

  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  const optimisticRemove = useCallback((id: string) => {
    setDeletedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const conversations = useMemo<ConversationEntry[]>(() => {
    if (!data?.trajectorySummaries) return [];

    const finalArray = Object.entries(data.trajectorySummaries)
      .filter(([id]) => !deletedIds.has(id))
      .map(([id, summary]) => ({ id, summary }))
      .sort((a, b) => {
        const aRunning =
          a.summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
          a.summary.hasRunningSubagent === true;
        const bRunning =
          b.summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
          b.summary.hasRunningSubagent === true;
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        return (
          new Date(b.summary.lastModifiedTime).getTime() -
          new Date(a.summary.lastModifiedTime).getTime()
        );
      });

    return finalArray;
  }, [data, deletedIds]);

  const anyRunning = conversations.some(
    (c) =>
      c.summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
      c.summary.hasRunningSubagent === true,
  );
  useEffect(() => {
    setHasAnyRunning((prev) => (prev === anyRunning ? prev : anyRunning));
  }, [anyRunning]);

  return { conversations, error, loading, refresh, optimisticRemove };
}
