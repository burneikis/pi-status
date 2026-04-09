import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

interface UsageData {
  five_hour?: RateLimit;
  seven_day?: RateLimit;
  seven_day_sonnet?: RateLimit;
  extra_usage?: ExtraUsage;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

// ─── Token management ─────────────────────────────────────────────────────────

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const USAGE_CACHE_PATH = join(homedir(), ".claude", ".pi-usage-cache.json");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const API_URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_INTERVAL_MS = 120_000;
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function readCreds(): any {
  return JSON.parse(readFileSync(CREDS_PATH, "utf8"));
}

function writeCreds(creds: any): void {
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
}

function loadTokens(): OAuthTokens | null {
  try {
    const oauth = readCreds()?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return oauth as OAuthTokens;
  } catch {
    return null;
  }
}

function isExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return Date.now() >= tokens.expiresAt - 60_000;
}

async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = await res.json();
  const newTokens: OAuthTokens = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  try {
    const creds = readCreds();
    creds.claudeAiOauth = newTokens;
    writeCreds(creds);
  } catch {
    // non-fatal
  }

  return newTokens;
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

async function fetchUsage(tokens: OAuthTokens): Promise<UsageData> {
  const res = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
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

function worstPct(data: UsageData): number {
  const vals = [
    data.five_hour?.utilization,
    data.seven_day?.utilization,
  ].filter((v): v is number => typeof v === "number");
  return vals.length ? Math.max(...vals) : 0;
}

function fmtLimit(label: string, limit?: RateLimit): string | null {
  if (!limit || limit.utilization === null || limit.utilization === undefined)
    return null;
  return `${label}:${Math.floor(limit.utilization)}%`;
}

function fmtReset(resets_at?: string | null): string | null {
  if (!resets_at) return null;
  const ms = new Date(resets_at).getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function buildParts(data: UsageData): string[] {
  const parts = [
    fmtLimit("5h", data.five_hour),
    fmtLimit("7d", data.seven_day),
  ].filter((p): p is string => p !== null);

  // Show soonest reset time (prefer 5-hour window if active)
  const resetStr =
    fmtReset(data.five_hour?.resets_at) ?? fmtReset(data.seven_day?.resets_at);
  if (resetStr) parts.push(`↺${resetStr}`);

  return parts;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    // cc-usage polling state
    let tokens: OAuthTokens | null = loadTokens();
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
        tokens = loadTokens();
        if (!tokens) {
          usageError = "no creds";
          renderFn?.();
          return;
        }
        if (isExpired(tokens)) {
          tokens = await refreshTokens(tokens);
        }
        usageData = await fetchUsage(tokens);
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

    // Kick off polling
    pollUsage();
    pollTimer = setInterval(pollUsage, POLL_INTERVAL_MS);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      // Wire up render trigger
      renderFn = () => tui.requestRender();

      return {
        dispose: () => {
          unsub();
          renderFn = null;
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
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
            const parts = buildParts(usageData);
            if (parts.length > 0) {
              const text = "  " + parts.join(" ");
              usagePlain = text;
              const worst = worstPct(usageData);
              if (worst >= 80) {
                usageColored = "  " + theme.fg("error", parts.join(" "));
              } else if (worst >= 50) {
                usageColored = "  " + theme.fg("warning", parts.join(" "));
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
