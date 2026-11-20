import type { Hono } from "hono";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_TTL_MS = 30_000;
let cachedPayload: Record<string, unknown> | null = null;
let cachedAt = 0;

const JP_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}(${JP_WEEKDAYS[d.getDay()]})`;
}

async function collectAntigravityWeeklySummary(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (cachedPayload && now - cachedAt < CACHE_TTL_MS) {
    return cachedPayload;
  }

  // Build 7-day buckets (oldest -> newest)
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days: Array<{
    date: string;
    label: string;
    active: number;
    gross: number;
  }> = [];
  const dayMap = new Map<string, { active: number; gross: number }>();

  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
    const key = formatDateKey(d);
    const entry = { date: key, label: formatDayLabel(d), active: 0, gross: 0 };
    days.push(entry);
    dayMap.set(key, entry);
  }

  const windowStartMs = today.getTime() - 6 * 24 * 60 * 60 * 1000;
  const dirs = [
    join(homedir(), ".gemini", "antigravity", "conversations"),
    join(homedir(), ".gemini", "antigravity-ide", "conversations"),
    join(homedir(), ".gemini", "antigravity-cli", "conversations"),
  ];

  let conversations = 0;
  let totalActive = 0;
  let totalGross = 0;

  for (const dir of dirs) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".pb") && !file.endsWith(".db")) continue;
        try {
          const st = await stat(join(dir, file));
          if (st.mtimeMs >= windowStartMs) {
            conversations++;
            // Estimate active and gross token volume from local trajectory size
            const activeEst = Math.max(250, Math.round(st.size / 6));
            const grossEst = Math.round(activeEst * 3.2);
            totalActive += activeEst;
            totalGross += grossEst;

            const key = formatDateKey(new Date(st.mtimeMs));
            const bucket = dayMap.get(key);
            if (bucket) {
              bucket.active += activeEst;
              bucket.gross += grossEst;
            }
          }
        } catch {
          // ignore unreadable file
        }
      }
    } catch {
      // directory missing
    }
  }

  const emptyBucket = {
    active_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    gross_tokens: 0,
    conversations: 0,
    weekly_quota: null,
  };

  const payload = {
    updated_at: new Date(now).toISOString(),
    window: {
      start_date: days[0].date,
      end_date: days[days.length - 1].date,
      days: 7,
    },
    gear: {
      active_tokens: totalActive,
      uncached_input_tokens: Math.round(totalActive * 0.78),
      output_tokens: Math.round(totalActive * 0.22),
      cached_input_tokens: Math.max(0, totalGross - totalActive),
      gross_tokens: totalGross,
      conversations,
      weekly_quota: null,
    },
    codex: emptyBucket,
    code: emptyBucket,
    combined: {
      active_tokens: totalActive,
      gross_tokens: totalGross,
    },
    daily: days.map((d) => ({
      date: d.date,
      label: d.label,
      gear_active: d.active,
      codex_active: 0,
      code_active: 0,
      total_active: d.active,
      gear_gross: d.gross,
      total_gross: d.gross,
    })),
  };

  cachedPayload = payload;
  cachedAt = now;
  return payload;
}

export function registerUsageRoutes(app: Hono): void {
  app.get("/api/usage/weekly", async (c) => {
    try {
      if (c.req.query("refresh") === "1") {
        cachedAt = 0;
      }
      const data = await collectAntigravityWeeklySummary();
      return c.json(data);
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to collect weekly token usage",
        },
        500,
      );
    }
  });
}
