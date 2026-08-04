import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatFirecrawlResult, searchLocalFirecrawl } from "../src/web.ts";

test("self-hosted Firecrawl keeps OMP search semantics local", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.web.firecrawl.url = "http://127.0.0.1:3002/";
  const originalKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "local-test-key";
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  try {
    const result = await searchLocalFirecrawl(config, {
      query: "Bun runtime",
      recency: "week",
      limit: 2,
    }, {
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({
          success: true,
          id: "request-1",
          data: { web: [{ title: "Bun", url: "https://bun.sh", description: "A JavaScript runtime." }] },
        });
      }) as typeof fetch,
    });
    expect(requestUrl).toBe("http://127.0.0.1:3002/v2/search");
    expect((requestInit?.headers as Record<string, string>).Authorization).toBe("Bearer local-test-key");
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      query: "Bun runtime",
      limit: 2,
      sources: [{ type: "web" }],
      tbs: "qdr:w",
    });
    expect(result.backend).toBe("self-hosted");
    expect(result.authMode).toBe("api_key");
    expect(formatFirecrawlResult(result)).toContain("https://bun.sh");
  } finally {
    if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalKey;
  }
});
