import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { MockTachiAdapter } from "@opentill/adapter";
import { createApp, type App } from "../src/app";
import type { GatewayConfig } from "../src/config";

export const API_KEY = "test_api_key";
export const WEBHOOK_SECRET = "test_webhook_secret";

export interface Harness extends App {
  mock: MockTachiAdapter;
  dir: string;
  destroy(): Promise<void>;
}

export interface HarnessOptions {
  commitLatencyMs?: number;
  configOverrides?: Partial<GatewayConfig>;
}

/** Boots the gateway against a temp SQLite file and a mock adapter. Timers stay off. */
export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "opentill-test-"));
  // Commits are driven explicitly via `mock.forceCommitAll()` in tests rather
  // than by wall-clock latency, so nothing here races.
  const mock = new MockTachiAdapter({ mockCommitLatencyMs: opts.commitLatencyMs ?? 60_000 });

  const config: GatewayConfig = {
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    dbPath: join(dir, "test.db"),
    adapterMode: "mock",
    port: 0,
    host: "127.0.0.1",
    pollIntervalMs: 50,
    expirySweepIntervalMs: 50,
    webhookSweepIntervalMs: 50,
    devRoutesEnabled: true,
    devPublicSimulate: false,
    sseHeartbeatMs: 15_000,
    webDistPath: join(dir, "no-dist"),
    payoutWebhookUrl: null,
    payoutPollIntervalMs: 50,
    merchantName: "OpenTill",
    ...opts.configOverrides,
  };

  const app = await createApp(config, { adapter: mock });

  return Object.assign(app, {
    mock,
    dir,
    async destroy() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

export function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };
}

export interface CapturedWebhook {
  body: string;
  signature: string;
  parsed: Record<string, unknown>;
}

export interface WebhookSink {
  url: string;
  received: CapturedWebhook[];
  /** Resolves once `count` deliveries have landed, or rejects on timeout. */
  waitFor(count: number, timeoutMs?: number): Promise<CapturedWebhook[]>;
  setResponseStatus(status: number): void;
  close(): Promise<void>;
}

/** Local HTTP sink that records signed webhook deliveries. */
export async function startWebhookSink(): Promise<WebhookSink> {
  const received: CapturedWebhook[] = [];
  let responseStatus = 200;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({
        body,
        signature: String(req.headers["x-opentill-signature"] ?? ""),
        parsed: JSON.parse(body) as Record<string, unknown>,
      });
      res.writeHead(responseStatus).end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setResponseStatus(status: number) {
      responseStatus = status;
    },
    async waitFor(count: number, timeoutMs = 5000): Promise<CapturedWebhook[]> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} webhooks, got ${received.length}`);
        }
        await sleep(10);
      }
      return received;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseClient {
  /** Every event received so far, in order. */
  events: SseEvent[];
  /** Resolves with the next unconsumed event matching the predicate. */
  waitForEvent(
    predicate: (e: SseEvent) => boolean,
    label?: string,
    timeoutMs?: number,
  ): Promise<SseEvent>;
  close(): void;
}

/** Minimal EventSource stand-in over fetch streaming, enough for our tests. */
export async function connectSse(url: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (res.status !== 200 || !res.body) {
    controller.abort();
    throw new Error(`SSE connect failed with status ${res.status}`);
  }

  const events: SseEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length > 0) events.push({ event, data: data.join("\n") });
        }
      }
    } catch {
      /* stream aborted by close() */
    }
  })();

  let cursor = 0;
  return {
    events,
    async waitForEvent(predicate, label = "sse event", timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < events.length) {
          const candidate = events[cursor]!;
          cursor += 1;
          if (predicate(candidate)) return candidate;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(10);
      }
    },
    close() {
      controller.abort();
    },
  };
}

/** Polls `predicate` until it holds. Used where a result lands just after the observable side effect. */
export async function waitUntil(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
