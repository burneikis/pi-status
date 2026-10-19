import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── cc-usage types ───────────────────────────────────────────────────────────

interface RateLimit {
  utilization: number | null;
  resets_at?: string | null;
}

interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits?: number | null;
  utilization?: number | null;
}

type LimitKind = "session" | "weekly_all" | "weekly_scoped";

interface UsageLimit {
  kind: LimitKind | string;
  percent: number | null;
  resets_at?: string | null;
}

interface UsageData {
  five_hour?: RateLimit;
  seven_day?: RateLimit;
  seven_day_sonnet?: RateLimit;
  limits?: UsageLimit[];
  extra_usage?: ExtraUsage;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const USAGE_ITEMS = [
  "session",
  "weekly",
  "weekly_scoped",
  "session_reset",
  "weekly_reset",
  "reset",
  "extra",
] as const;

type UsageItem = (typeof USAGE_ITEMS)[number];
type PercentItem = "session" | "weekly" | "weekly_scoped";

interface StatusConfig {
  items: UsageItem[];
  labels: Record<PercentItem, string>;
}

const CONFIG_PATH = join(getAgentDir(), "pi-status.json");

const DEFAULT_CONFIG: StatusConfig = {
  items: ["session", "weekly", "reset"],
  labels: { session: "5h", weekly: "7d", weekly_scoped: "ws" },
};

function isUsageItem(value: unknown): value is UsageItem {
  return USAGE_ITEMS.includes(value as UsageItem);
}

function loadConfig(): StatusConfig {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return DEFAULT_CONFIG;
  }
  return {
    items: Array.isArray(raw?.items)
      ? raw.items.filter(isUsageItem)
      : DEFAULT_CONFIG.items,
    labels: { ...DEFAULT_CONFIG.labels, ...raw?.labels },
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const USAGE_CACHE_PATH = join(homedir(), ".claude", ".pi-usage-cache.json");
const API_URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_INTERVAL_MS = 120_000;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// pi's own Anthropic login. pi refreshes it under its auth.json lock, so
// this never races pi (or the PiOS daemon) over a rotating refresh token.
async function loadToken(ctx: ExtensionContext): Promise<string | null> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
  // Plan usage needs a subscription (OAuth) login; an API key cannot read it.
  return key?.startsWith("sk-ant-oat") ? key : null;
}

// ─── Usage cache ─────────────────────────────────────────────────────────────

interface UsageCache {
  timestamp: number;
  data: UsageData;
  rate_limited_until?: number;
  rate_limit_count?: number;
}

function readUsageCache(): UsageCache | null {
  try {
    return JSON.parse(readFileSync(USAGE_CACHE_PATH, "utf8")) as UsageCache;
  } catch {
    return null;
  }
}

function writeUsageCache(data: UsageData): void {
  try {
    const cache: UsageCache = { timestamp: Date.now(), data };
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify(cache), "utf8");
  } catch {
    // non-fatal
  }
}

async function fetchUsage(token: string): Promise<UsageData> {
  const res = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<UsageData>;
}

// ─── Compact rendering helpers ────────────────────────────────────────────────

interface UsageWindow {
  percent: number | null;
  resetsAt: string | null;
}

interface UsagePart {
  text: string;
  percent?: number;
}

function findWindow(
  data: UsageData,
  kind: LimitKind,
  legacy?: RateLimit,
): UsageWindow | null {
  // Assumes one limit per kind. weekly_scoped is currently a single
  // model-scoped limit (Fable); if several appear, render one part per
  // limit, labelled from scope.model.display_name.
  const limit = data.limits?.find((l) => l.kind === kind);
  if (limit) return { percent: limit.percent, resetsAt: limit.resets_at ?? null };
  if (legacy) {
    return { percent: legacy.utilization, resetsAt: legacy.resets_at ?? null };
  }
  return null;
}

function sessionWindow(data: UsageData): UsageWindow | null {
  return findWindow(data, "session", data.five_hour);
}

function weeklyWindow(data: UsageData): UsageWindow | null {
  return findWindow(data, "weekly_all", data.seven_day);
}

function fmtDuration(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function percentPart(label: string, window: UsageWindow | null): UsagePart | null {
  if (typeof window?.percent !== "number") return null;
  const percent = Math.floor(window.percent);
  return { text: `${label}:${percent}%`, percent };
}

function resetPart(resetsAt: string | null | undefined): UsagePart | null {
  return resetsAt ? { text: `↺${fmtDuration(resetsAt)}` } : null;
}

function soonestReset(data: UsageData): string | null {
  const times = [sessionWindow(data)?.resetsAt, weeklyWindow(data)?.resetsAt]
    .filter((t): t is string => !!t)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return times[0] ?? null;
}

function extraPart(extra?: ExtraUsage): UsagePart | null {
  if (!extra?.is_enabled) return null;
  const used = extra.used_credits;
  const limit = extra.monthly_limit;
  if (typeof used !== "number" || typeof limit !== "number") return null;
  const text = `$${(used / 100).toFixed(2)}/$${(limit / 100).toFixed(2)}`;
  return limit > 0 ? { text, percent: Math.floor((used / limit) * 100) } : { text };
}

function buildPart(
  item: UsageItem,
  data: UsageData,
  labels: StatusConfig["labels"],
): UsagePart | null {
  switch (item) {
    case "session":
      return percentPart(labels.session, sessionWindow(data));
    case "weekly":
      return percentPart(labels.weekly, weeklyWindow(data));
    case "weekly_scoped":
      return percentPart(labels.weekly_scoped, findWindow(data, "weekly_scoped"));
    case "session_reset":
      return resetPart(sessionWindow(data)?.resetsAt);
    case "weekly_reset":
      return resetPart(weeklyWindow(data)?.resetsAt);
    case "reset":
      return resetPart(soonestReset(data));
    case "extra":
      return extraPart(data.extra_usage);
  }
}

function buildParts(data: UsageData, config: StatusConfig): UsagePart[] {
  return config.items
    .map((item) => buildPart(item, data, config.labels))
    .filter((p): p is UsagePart => p !== null);
}

function worstPercent(parts: UsagePart[]): number {
  return Math.max(0, ...parts.map((p) => p.percent ?? 0));
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let stopPolling: (() => void) | null = null;

  pi.on("session_shutdown", () => {
    stopPolling?.();
    stopPolling = null;
  });

  pi.on("session_start", (_event, ctx) => {
    stopPolling?.();

    const config = loadConfig();

    // cc-usage polling state
    let usageData: UsageData | null = null;
    let usageError: string | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let renderFn: (() => void) | null = null;

    async function pollUsage() {
      try {
        // Check shared cache first — avoids rate limits with multiple instances
        const cache = readUsageCache();
        if (cache) {
          // Serve stale cache if we are in a rate-limit backoff window
          if (cache.rate_limited_until && Date.now() < cache.rate_limited_until) {
            usageData = cache.data;
            usageError = null;
            renderFn?.();
            return;
          }
          if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
            usageData = cache.data;
            usageError = null;
            renderFn?.();
            return;
          }
        }

        // Cache is stale or missing — fetch fresh data
        const token = await loadToken(ctx);
        if (!token) {
          usageError = "no creds";
          renderFn?.();
          return;
        }
        usageData = await fetchUsage(token);
        // Successful fetch — reset rate-limit counter
        try {
          const existing = readUsageCache();
          if (existing?.rate_limit_count) {
            writeFileSync(
              USAGE_CACHE_PATH,
              JSON.stringify({ timestamp: Date.now(), data: usageData }),
              "utf8",
            );
          } else {
            writeUsageCache(usageData);
          }
        } catch {
          writeUsageCache(usageData);
        }
        usageError = null;
      } catch (err: any) {
        const msg: string = err?.message ?? "unknown error";
        // On rate limit, record a backoff deadline in the cache so all
        // instances (including statusline-command.sh) honour it
        if (msg.includes("429")) {
          try {
            const existing = readUsageCache();
            const count = (existing?.rate_limit_count ?? 0) + 1;
            const backoffMs =
              count === 1 ? 5 * 60_000 : count === 2 ? 10 * 60_000 : 30 * 60_000;
            const patched: UsageCache = {
              timestamp: existing?.timestamp ?? Date.now(),
              data: existing?.data ?? {},
              rate_limited_until: Date.now() + backoffMs,
              rate_limit_count: count,
            };
            writeFileSync(USAGE_CACHE_PATH, JSON.stringify(patched), "utf8");
            if (existing?.data) usageData = existing.data;
          } catch {
            // non-fatal
          }
        }
        usageError = msg;
      }
      renderFn?.();
    }

    const stop = () => {
      renderFn = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    stopPolling = stop;

    // In non-interactive / print mode (`pi -p`) there is no TUI footer, so
    // the footer's dispose() never runs to clear the poll timer. A live
    // setInterval keeps the Node event loop alive and the process hangs after
    // printing. Detect headless mode and skip background polling entirely.
    const isHeadless = !process.stdout.isTTY || !ctx.ui?.setFooter;
    if (!isHeadless) {
      // Kick off polling
      pollUsage();
      pollTimer = setInterval(pollUsage, POLL_INTERVAL_MS);
      // Defensive: never let the timer keep the process alive on its own.
      pollTimer.unref?.();
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      // Wire up render trigger
      renderFn = () => tui.requestRender();

      return {
        dispose: () => {
          unsub();
          stop();
        },
        invalidate() {},
        render(width: number): string[] {
          // ── Session cost ──────────────────────────────────────────
          let totalCost = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              const m = entry.message as AssistantMessage;
              totalCost += m.usage.cost.total;
            }
          }

          // ── Context usage ─────────────────────────────────────────
          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? 0;
          const contextPercent =
            contextUsage?.percent !== null
              ? contextUsage?.percent?.toFixed(1)
              : "?";
          const contextPercentValue = contextUsage?.percent ?? 0;

          const fmt = (n: number) => {
            if (n < 1000) return n.toString();
            if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
            if (n < 1000000) return `${Math.round(n / 1000)}k`;
            if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
            return `${Math.round(n / 1000000)}M`;
          };

          const contextDisplay = `${contextPercent}%/${fmt(contextWindow)}`;
          let contextStr: string;
          if (contextPercentValue > 90) {
            contextStr = theme.fg("error", contextDisplay);
          } else if (contextPercentValue > 70) {
            contextStr = theme.fg("warning", contextDisplay);
          } else {
            contextStr = contextDisplay;
          }

          // ── cc-usage inline ──────────────────────────────────────
          let usagePlain = "";
          let usageColored = "";
          if (usageData) {
            const parts = buildParts(usageData, config);
            if (parts.length > 0) {
              const joined = parts.map((p) => p.text).join(" ");
              const text = "  " + joined;
              usagePlain = text;
              const worst = worstPercent(parts);
              if (worst >= 80) {
                usageColored = "  " + theme.fg("error", joined);
              } else if (worst >= 50) {
                usageColored = "  " + theme.fg("warning", joined);
              } else {
                usageColored = theme.fg("dim", text);
              }
            }
          }

          const leftBase = `$${totalCost.toFixed(3)}  ${contextStr}`;
          const left = leftBase + usagePlain;

          // ── Model + thinking ──────────────────────────────────────
          const modelName = ctx.model?.id || "no-model";
          let right = modelName;
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            right =
              level === "off"
                ? `${modelName} • thinking off`
                : `${modelName} • ${level}`;
          }

          // ── pwd + branch ──────────────────────────────────────────
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          // ── Layout: stats line ────────────────────────────────────
          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(right);
          const pad = " ".repeat(Math.max(2, width - leftWidth - rightWidth));

          const dimLeft = theme.fg("dim", leftBase) + usageColored;
          const dimRight = theme.fg("dim", pad + right);

          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "..."),
          );

          const statsLine = truncateToWidth(
            dimLeft + dimRight,
            width,
            theme.fg("dim", "..."),
          );

          const lines = [pwdLine, statsLine];

          // ── Extension statuses ────────────────────────────────────
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const statusLine = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) =>
                text
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim(),
              )
              .join(" ");
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });
  });
}
