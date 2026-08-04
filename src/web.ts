import type { PersephoneConfig } from "./types.ts";

export type SearchRecency = "day" | "week" | "month" | "year";

export interface FirecrawlSearchParams {
  query: string;
  recency?: SearchRecency;
  limit?: number;
  num_search_results?: number;
}

export interface FirecrawlSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface FirecrawlSearchResult {
  provider: "firecrawl";
  backend: "self-hosted";
  requestId?: string;
  authMode: "api_key" | "keyless";
  sources: FirecrawlSource[];
}

interface FirecrawlResponse {
  success?: boolean;
  id?: string | null;
  data?: {
    web?: Array<{
      title?: string | null;
      url?: string | null;
      description?: string | null;
      markdown?: string | null;
    }> | null;
  } | null;
}

const RECENCY: Record<SearchRecency, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

export async function searchLocalFirecrawl(
  config: PersephoneConfig,
  params: FirecrawlSearchParams,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<FirecrawlSearchResult> {
  const query = params.query.trim();
  if (!query) throw new Error("Search query cannot be empty");
  const requested = params.num_search_results ?? params.limit ?? 10;
  const limit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(requested) ? requested : 10)));
  const apiKey = process.env[config.web.firecrawl.apiKeyEnv]?.trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = {
    query,
    limit,
    sources: [{ type: "web" }],
  };
  if (params.recency) body.tbs = RECENCY[params.recency];

  const timeout = AbortSignal.timeout(config.web.firecrawl.timeoutSeconds * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetch ?? fetch)(`${stripSlash(config.web.firecrawl.url)}/v2/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = truncate((await response.text()).trim(), 500);
    throw new Error(`Local Firecrawl returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = (await response.json()) as FirecrawlResponse;
  if (payload.success === false) throw new Error("Local Firecrawl reported an unsuccessful search");
  const sources: FirecrawlSource[] = [];
  for (const item of payload.data?.web ?? []) {
    const url = item.url?.trim();
    if (!url) continue;
    const source: FirecrawlSource = {
      title: item.title?.trim() || url,
      url,
    };
    const snippet = (item.description || item.markdown || "").trim();
    if (snippet) source.snippet = truncate(snippet, 240);
    sources.push(source);
  }
  return {
    provider: "firecrawl",
    backend: "self-hosted",
    ...(payload.id ? { requestId: payload.id } : {}),
    authMode: apiKey ? "api_key" : "keyless",
    sources: sources.slice(0, limit),
  };
}

export function formatFirecrawlResult(result: FirecrawlSearchResult): string {
  if (result.sources.length === 0) return "Local Firecrawl returned no web results.";
  return result.sources
    .map((source, index) => {
      const lines = [`[${index + 1}] ${source.title}`, `    ${source.url}`];
      if (source.snippet) lines.push(`    ${source.snippet}`);
      return lines.join("\n");
    })
    .join("\n");
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}
