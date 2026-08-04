import { executeCamofoxCode } from "./camofox-browser.ts";

type WorkerRequest = Parameters<typeof executeCamofoxCode>[0];

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await executeCamofoxCode(event.data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
