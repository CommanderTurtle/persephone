import { expect, test } from "bun:test";

import { CamofoxBrowserAdapter, executeCamofoxCode } from "../src/camofox-browser.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("browser open and close use only the configured local Camofox service", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const adapter = new CamofoxBrowserAdapter(config, (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method || "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    });
    if (String(input).endsWith("/tabs")) {
      return Response.json({ tabId: "tab-1", url: "https://example.com", title: "Example" });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch);

  const opened = await adapter.execute({ action: "open", name: "docs", url: "https://example.com" });
  expect(opened.details.browser).toBe("camofox");
  expect(opened.details.tabId).toBe("tab-1");
  expect(requests[0]).toEqual({
    url: "http://127.0.0.1:9377/tabs",
    method: "POST",
    body: {
      userId: "omp-persephone",
      sessionKey: "omp-docs",
      url: "https://example.com",
    },
  });

  await adapter.execute({ action: "close", all: true });
  expect(requests[1]?.url).toBe("http://127.0.0.1:9377/sessions/omp-persephone");
});

test("OMP-style browser code operates against Camofox snapshots and refs", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/snapshot?")) {
      return Response.json({
        url: "https://example.com",
        snapshot: '- document "Example"\n  - link "Sign in" [ref=e5]',
        refsCount: 1,
      });
    }
    if (url.endsWith("/click")) return Response.json({ success: true, navigated: false });
    throw new Error(`Unexpected test URL: ${url}`);
  }) as typeof fetch;
  try {
    const response = await executeCamofoxCode({
      connection: {
        baseUrl: "http://127.0.0.1:9377",
        timeoutMs: 5_000,
        userId: "omp-persephone",
      },
      tab: {
        name: "docs",
        tabId: "tab-1",
        userId: "omp-persephone",
        url: "https://example.com",
      },
      code: "const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'missing link'); await (await tab.id(link.id)).click(); display(obs.elements); return link.id;",
    });
    expect(response.returnValue).toBe("e5");
    expect(response.displays).toHaveLength(1);
    expect(requests.some((url) => url.endsWith("/tabs/tab-1/click"))).toBeTrue();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser run executes OMP-style code in the bounded Camofox worker", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/tabs" && request.method === "POST") {
        return Response.json({ tabId: "tab-worker", url: "https://example.com" });
      }
      if (url.pathname === "/tabs/tab-worker/snapshot") {
        return Response.json({
          url: "https://example.com",
          snapshot: '- document "Example"\n  - link "Continue" [ref=e7]',
          refsCount: 1,
        });
      }
      if (url.pathname === "/sessions/omp-persephone" && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  });
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.web.camofox.url = `http://127.0.0.1:${server.port}`;
    const adapter = new CamofoxBrowserAdapter(config);
    await adapter.execute({ action: "open", name: "worker", url: "https://example.com" });
    const response = await adapter.execute({
      action: "run",
      name: "worker",
      timeout: 5,
      code: "const obs = await tab.observe(); return obs.elements[0].name;",
    });
    expect(response.text).toBe("Continue");
    expect(response.details.browser).toBe("camofox");
    await adapter.execute({ action: "close", all: true });
  } finally {
    server.stop(true);
  }
});
