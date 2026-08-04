import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PersephoneConfig } from "./types.ts";

export interface CamofoxBrowserParams {
  action: "open" | "close" | "run";
  name?: string;
  url?: string;
  app?: {
    path?: string;
    cdp_url?: string;
    relay?: boolean;
    args?: string[];
    target?: string;
  };
  viewport?: { width: number; height: number; scale?: number };
  wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  dialogs?: "accept" | "dismiss";
  code?: string;
  timeout?: number;
  all?: boolean;
  kill?: boolean;
}

export interface CamofoxBrowserResult {
  text: string;
  details: {
    action: CamofoxBrowserParams["action"];
    name?: string;
    url?: string;
    browser: "camofox";
    tabId?: string;
    result?: string;
  };
}

interface CamofoxConnection {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  userId: string;
}

interface TrackedTab {
  name: string;
  tabId: string;
  userId: string;
  url: string;
}

interface RunRequest {
  connection: CamofoxConnection;
  tab: TrackedTab;
  code: string;
}

export interface RunResponse {
  displays: unknown[];
  returnValue?: unknown;
  url: string;
}

interface SnapshotPayload {
  url?: string;
  snapshot?: string;
  refsCount?: number;
  truncated?: boolean;
  totalChars?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
}

const DEFAULT_TAB = "main";

/**
 * OMP browser-tool compatibility backed entirely by the local Camofox HTTP
 * service. The Camofox MCP remains registered for its larger specialist tool
 * surface, while this adapter preserves the native open/run/close workflow
 * used by OMP's browser-aware skills.
 */
export class CamofoxBrowserAdapter {
  private readonly tabs = new Map<string, TrackedTab>();
  private readonly connection: CamofoxConnection;

  constructor(config: PersephoneConfig, private readonly fetchImpl: typeof fetch = fetch) {
    const apiKey = process.env[config.web.camofox.apiKeyEnv]?.trim();
    this.connection = {
      baseUrl: config.web.camofox.url.replace(/\/+$/, ""),
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 60_000,
      userId: config.web.camofox.userId,
    };
  }

  async execute(params: CamofoxBrowserParams, signal?: AbortSignal): Promise<CamofoxBrowserResult> {
    const name = params.name?.trim() || DEFAULT_TAB;
    switch (params.action) {
      case "open":
        return this.open(name, params, signal);
      case "close":
        return this.close(name, params, signal);
      case "run":
        return this.run(name, params, signal);
    }
  }

  private async open(name: string, params: CamofoxBrowserParams, signal?: AbortSignal): Promise<CamofoxBrowserResult> {
    if (params.app?.path || params.app?.cdp_url || params.app?.relay) {
      throw new Error("Camofox owns browser process selection; app.path, app.cdp_url, and app.relay are unavailable.");
    }
    const existing = this.tabs.get(name);
    if (existing) {
      if (params.url) {
        const navigated = await this.json(`/tabs/${encodeURIComponent(existing.tabId)}/navigate`, {
          method: "POST",
          body: JSON.stringify({ url: params.url, userId: existing.userId }),
        }, signal) as { url?: string; title?: string };
        existing.url = navigated.url || params.url;
      }
      return result("open", name, existing.url, existing.tabId, `Reused Camofox tab ${JSON.stringify(name)}\nURL: ${existing.url}`);
    }

    const payload: Record<string, unknown> = {
      userId: this.connection.userId,
      sessionKey: `omp-${name}`,
    };
    if (params.url) payload.url = params.url;
    if (params.viewport) payload.viewport = { width: params.viewport.width, height: params.viewport.height };
    const created = await this.json("/tabs", { method: "POST", body: JSON.stringify(payload) }, signal) as {
      tabId?: string;
      id?: string;
      tab?: { id?: string };
      url?: string;
      title?: string;
    };
    const tabId = created.tabId || created.id || created.tab?.id;
    if (!tabId) throw new Error("Camofox did not return a tab ID");
    const tab: TrackedTab = {
      name,
      tabId,
      userId: this.connection.userId,
      url: created.url || params.url || "about:blank",
    };
    this.tabs.set(name, tab);
    return result("open", name, tab.url, tab.tabId, `Opened Camofox tab ${JSON.stringify(name)}\nURL: ${tab.url}`);
  }

  private async close(name: string, params: CamofoxBrowserParams, signal?: AbortSignal): Promise<CamofoxBrowserResult> {
    if (params.all) {
      const count = this.tabs.size;
      await this.request(`/sessions/${encodeURIComponent(this.connection.userId)}`, { method: "DELETE" }, signal);
      this.tabs.clear();
      return result("close", name, undefined, undefined, `Closed ${count} Camofox tab(s)`);
    }
    const tab = this.tabs.get(name);
    if (!tab) return result("close", name, undefined, undefined, `No Camofox tab named ${JSON.stringify(name)}`);
    await this.request(`/tabs/${encodeURIComponent(tab.tabId)}`, {
      method: "DELETE",
      body: JSON.stringify({ userId: tab.userId }),
    }, signal);
    this.tabs.delete(name);
    return result("close", name, undefined, tab.tabId, `Closed Camofox tab ${JSON.stringify(name)}`);
  }

  private async run(name: string, params: CamofoxBrowserParams, signal?: AbortSignal): Promise<CamofoxBrowserResult> {
    if (!params.code?.trim()) throw new Error("Missing required parameter 'code' for browser action 'run'");
    const tab = this.tabs.get(name);
    if (!tab) throw new Error(`No Camofox tab named ${JSON.stringify(name)}. Call browser action=open first.`);
    const timeoutMs = Math.max(1, Math.min(params.timeout ?? 60, 300)) * 1000;
    const response = await executeInWorker({ connection: this.connection, tab, code: params.code }, timeoutMs, signal);
    tab.url = response.url || tab.url;
    const values = [...response.displays];
    if (response.returnValue !== undefined) values.push(response.returnValue);
    const text = values.length ? values.map(formatValue).join("\n") : `Ran code on Camofox tab ${JSON.stringify(name)}`;
    return result("run", name, tab.url, tab.tabId, text);
  }

  private async json(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(pathname, init, signal);
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Camofox returned non-JSON content for ${pathname}`);
    }
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.connection.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.connection.apiKey) {
      headers.set("x-api-key", this.connection.apiKey);
      headers.set("authorization", `Bearer ${this.connection.apiKey}`);
    }
    const response = await this.fetchImpl(`${this.connection.baseUrl}${pathname}`, { ...init, headers, signal: combined });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(`Local Camofox returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    return response;
  }
}

export async function executeCamofoxCode(request: RunRequest): Promise<RunResponse> {
  const client = new CamofoxPageClient(request.connection, request.tab);
  const displays: unknown[] = [];
  const display = (value: unknown): unknown => {
    displays.push(value);
    return value;
  };
  const assert = (condition: unknown, message = "Browser assertion failed"): asserts condition => {
    if (!condition) throw new Error(message);
  };
  const wait = async (predicate: () => unknown | Promise<unknown>, timeoutMs = 10_000): Promise<unknown> => {
    const started = Date.now();
    let value: unknown;
    while (Date.now() - started < timeoutMs) {
      value = await predicate();
      if (value) return value;
      await Bun.sleep(200);
    }
    throw new Error(`Browser wait timed out after ${timeoutMs}ms`);
  };
  const browser = {
    backend: "camofox",
    tabs: {
      current: () => client,
      list: () => [{ name: request.tab.name, tabId: request.tab.tabId, url: client.url }],
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction("tab", "page", "browser", "display", "assert", "wait", request.code);
  const returnValue = await fn(client, client, browser, display, assert, wait);
  return { displays, ...(returnValue === undefined ? {} : { returnValue }), url: client.url };
}

class CamofoxPageClient {
  url: string;

  constructor(private readonly connection: CamofoxConnection, private readonly tab: TrackedTab) {
    this.url = tab.url;
  }

  async goto(url: string): Promise<unknown> {
    const response = await this.json(`/tabs/${encodeURIComponent(this.tab.tabId)}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url, userId: this.tab.userId }),
    }) as { url?: string };
    this.url = response.url || url;
    return response;
  }

  async observe(): Promise<ReturnType<typeof parseObservation>> {
    const snapshot = await this.snapshotPayload();
    this.url = snapshot.url || this.url;
    return parseObservation(snapshot.snapshot || "", this.url, snapshot);
  }

  async ariaSnapshot(): Promise<string> {
    const snapshot = await this.snapshotPayload();
    this.url = snapshot.url || this.url;
    return snapshot.snapshot || "";
  }

  ref(value: string): CamofoxElementHandle {
    return new CamofoxElementHandle(this, normalizeRef(value));
  }

  id(value: string | number): CamofoxElementHandle {
    return this.ref(String(value));
  }

  async click(selector: string): Promise<unknown> {
    return this.json(`/tabs/${encodeURIComponent(this.tab.tabId)}/click`, {
      method: "POST",
      body: JSON.stringify({ ...locator(selector), userId: this.tab.userId }),
    });
  }

  async type(selector: string, text: string): Promise<void> {
    await this.noContent(`/tabs/${encodeURIComponent(this.tab.tabId)}/type`, {
      method: "POST",
      body: JSON.stringify({ ...locator(selector), text, userId: this.tab.userId }),
    });
  }

  async fill(selector: string, text: string): Promise<void> {
    await this.type(selector, text);
  }

  async press(key: string): Promise<void> {
    await this.noContent(`/tabs/${encodeURIComponent(this.tab.tabId)}/press`, {
      method: "POST",
      body: JSON.stringify({ key, userId: this.tab.userId }),
    });
  }

  async scroll(directionOrAmount: "up" | "down" | number = "down", amount?: number): Promise<void> {
    const direction = typeof directionOrAmount === "number" ? (directionOrAmount < 0 ? "up" : "down") : directionOrAmount;
    const pixels = typeof directionOrAmount === "number" ? Math.abs(directionOrAmount) : amount;
    await this.noContent(`/tabs/${encodeURIComponent(this.tab.tabId)}/scroll`, {
      method: "POST",
      body: JSON.stringify({ direction, ...(pixels ? { amount: pixels } : {}), userId: this.tab.userId }),
    });
  }

  async evaluate(expression: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const source = typeof expression === "function"
      ? `(${expression.toString()})(...${JSON.stringify(args)})`
      : expression;
    const response = await this.json(`/tabs/${encodeURIComponent(this.tab.tabId)}/evaluate`, {
      method: "POST",
      body: JSON.stringify({ expression: source, userId: this.tab.userId, timeout: 30_000 }),
    }) as { ok?: boolean; result?: unknown; error?: string };
    if (response.ok === false) throw new Error(response.error || "Camofox JavaScript evaluation failed");
    return response.result;
  }

  async extract(selector = "body"): Promise<unknown> {
    return this.evaluate((value) => {
      const element = document.querySelector(String(value));
      return element ? { text: element.textContent || "", html: element.outerHTML } : null;
    }, selector);
  }

  async waitForSelector(selector: string, options: { timeout?: number } = {}): Promise<boolean> {
    const timeout = options.timeout ?? 10_000;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate((value) => Boolean(document.querySelector(String(value))), selector)) return true;
      await Bun.sleep(200);
    }
    throw new Error(`Selector ${JSON.stringify(selector)} was not found within ${timeout}ms`);
  }

  async waitForUrl(expected: string | RegExp, options: { timeout?: number } = {}): Promise<string> {
    const timeout = options.timeout ?? 10_000;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const snapshot = await this.snapshotPayload();
      this.url = snapshot.url || this.url;
      if (typeof expected === "string" ? this.url.includes(expected) : expected.test(this.url)) return this.url;
      await Bun.sleep(200);
    }
    throw new Error(`URL did not match within ${timeout}ms`);
  }

  async waitForNavigation(options: { timeout?: number } = {}): Promise<string> {
    const initial = this.url;
    const timeout = options.timeout ?? 10_000;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const snapshot = await this.snapshotPayload();
      this.url = snapshot.url || this.url;
      if (this.url !== initial) return this.url;
      await Bun.sleep(200);
    }
    throw new Error(`Navigation did not complete within ${timeout}ms`);
  }

  async waitFor(timeoutMs = 1_000): Promise<void> {
    await Bun.sleep(timeoutMs);
  }

  async scrollIntoView(selector: string): Promise<void> {
    await this.evaluate((value) => document.querySelector(String(value))?.scrollIntoView({ block: "center" }), selector);
  }

  async select(selector: string, value: string): Promise<void> {
    await this.evaluate((selectorValue, optionValue) => {
      const element = document.querySelector(String(selectorValue));
      if (!(element instanceof HTMLSelectElement)) throw new Error("Select element not found");
      element.value = String(optionValue);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, selector, value);
  }

  async screenshot(): Promise<string> {
    const response = await this.request(`/tabs/${encodeURIComponent(this.tab.tabId)}/screenshot?userId=${encodeURIComponent(this.tab.userId)}`, {
      method: "GET",
    });
    const directory = path.join(os.tmpdir(), "persephone-browser");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${this.tab.name}-${randomUUID()}.png`);
    await Bun.write(file, await response.arrayBuffer());
    return file;
  }

  private async snapshotPayload(offset?: number): Promise<SnapshotPayload> {
    const params = new URLSearchParams({ userId: this.tab.userId });
    if (offset !== undefined) params.set("offset", String(offset));
    return this.json(`/tabs/${encodeURIComponent(this.tab.tabId)}/snapshot?${params}`, { method: "GET" }) as Promise<SnapshotPayload>;
  }

  private async json(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(pathname, init);
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Camofox returned non-JSON content for ${pathname}`);
    }
  }

  private async noContent(pathname: string, init: RequestInit): Promise<void> {
    await this.request(pathname, init);
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.connection.apiKey) {
      headers.set("x-api-key", this.connection.apiKey);
      headers.set("authorization", `Bearer ${this.connection.apiKey}`);
    }
    const response = await fetch(`${this.connection.baseUrl}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.connection.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(`Local Camofox returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    return response;
  }
}

class CamofoxElementHandle {
  constructor(private readonly tab: CamofoxPageClient, private readonly refValue: string) {}
  click(): Promise<unknown> { return this.tab.click(this.refValue); }
  type(text: string): Promise<void> { return this.tab.type(this.refValue, text); }
  fill(text: string): Promise<void> { return this.tab.fill(this.refValue, text); }
  press(key: string): Promise<void> { return this.tab.press(key); }
}

function parseObservation(snapshot: string, url: string, metadata: SnapshotPayload) {
  const elements: Array<{ id: string; ref: string; role: string; name: string; raw: string }> = [];
  for (const raw of snapshot.split(/\r?\n/)) {
    const ref = raw.match(/(?:\[ref=|\bref[=:]\s*)(e\d+)\]?/i)?.[1];
    if (!ref) continue;
    const role = raw.match(/^\s*(?:[-*]\s*)?([A-Za-z][\w-]*)/)?.[1]?.toLowerCase() || "element";
    const name = raw.match(/["']([^"']+)["']/)?.[1] || raw.replace(/\[ref=.*$/, "").trim();
    elements.push({ id: ref, ref, role, name, raw: raw.trim() });
  }
  return {
    url,
    elements,
    snapshot,
    text: snapshot,
    refsCount: metadata.refsCount ?? elements.length,
    truncated: metadata.truncated ?? false,
    totalChars: metadata.totalChars ?? snapshot.length,
    hasMore: metadata.hasMore ?? false,
    nextOffset: metadata.nextOffset ?? null,
  };
}

function locator(selector: string): { ref?: string; selector?: string } {
  const ref = selector.match(/^(?:aria-ref=|\[ref=)?(e\d+)\]?$/i)?.[1];
  return ref ? { ref } : { selector };
}

function normalizeRef(value: string): string {
  return value.match(/(e\d+)/i)?.[1] || value;
}

function result(
  action: CamofoxBrowserParams["action"],
  name: string,
  url: string | undefined,
  tabId: string | undefined,
  text: string,
): CamofoxBrowserResult {
  return {
    text,
    details: {
      action,
      name,
      ...(url ? { url } : {}),
      browser: "camofox",
      ...(tabId ? { tabId } : {}),
      result: text,
    },
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

async function executeInWorker(request: RunRequest, timeoutMs: number, signal?: AbortSignal): Promise<RunResponse> {
  const worker = new Worker(new URL("./camofox-browser-worker.ts", import.meta.url).href);
  return new Promise<RunResponse>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      worker.terminate();
      callback();
    };
    const aborted = () => finish(() => reject(new DOMException("Browser operation aborted", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error(`Camofox browser run timed out after ${timeoutMs}ms`))), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: true; result: RunResponse } | { ok: false; error: string }>) => {
      const data = event.data;
      if (data.ok === true) {
        const value = data.result;
        finish(() => resolve(value));
      } else {
        const message = data.error;
        finish(() => reject(new Error(message)));
      }
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Camofox browser worker failed")));
    worker.postMessage(request);
  });
}
