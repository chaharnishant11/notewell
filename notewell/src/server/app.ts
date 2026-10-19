import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { EnhanceRequest, Enhancer } from "../core/enhance/enhancer.js";
import { TEMPLATES } from "../core/enhance/templates.js";
import type { MeetingStore } from "../core/store/meetings.js";
import type { Engine } from "./engine.js";
import { LiveSession } from "./live-session.js";

export interface AppOptions {
  engine: Engine;
  meetings: MeetingStore;
  enhancer: Enhancer;
  /** Directory holding index.html / styles.css. */
  publicDir?: string;
  /** Directory holding the compiled browser modules. */
  clientDir?: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};
const MAX_JSON_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Local HTTP + WebSocket server. It only answers requests addressed to a
 * loopback host and rejects foreign origins, so web pages you visit cannot
 * drive it through DNS rebinding or cross-site requests.
 */
export function createApp(options: AppOptions): Server {
  const publicDir = options.publicDir ?? join(PACKAGE_ROOT, "public");
  const clientDir = options.clientDir ?? join(PACKAGE_ROOT, "dist", "public");
  const { meetings, enhancer, engine } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
      else res.end();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const match = /^\/api\/meetings\/([0-9a-f-]{36})\/live$/.exec(pathOf(req));
    if (!match || !isTrustedRequest(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => new LiveSession(ws, match[1]!, engine, meetings));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedRequest(req)) throw new HttpError(403, "forbidden origin or host");
    const path = pathOf(req);
    const method = req.method ?? "GET";

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      if (path.startsWith("/app/")) return serveFile(res, clientDir, path.slice("/app/".length));
      return serveFile(res, publicDir, path === "/" ? "index.html" : path.slice(1));
    }

    if (path === "/api/status" && method === "GET") {
      return sendJson(res, 200, { llm: enhancer.describe() });
    }
    if (path === "/api/templates" && method === "GET") {
      return sendJson(res, 200, TEMPLATES.map(({ id, name, description }) => ({ id, name, description })));
    }
    if (path === "/api/meetings" && method === "GET") return sendJson(res, 200, await meetings.list());
    if (path === "/api/meetings" && method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 201, await meetings.create({ title: str(body.title), context: str(body.context) }));
    }

    const match = /^\/api\/meetings\/([0-9a-f-]{36})(\/enhance)?$/.exec(path);
    if (!match) throw new HttpError(404, "not found");
    const id = match[1]!;

    if (match[2]) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await readJson(req);
      return streamEnhancement(res, id, { templateId: str(body.templateId) ?? "general" });
    }
    if (method === "GET") {
      const meeting = await meetings.get(id);
      if (!meeting) throw new HttpError(404, "meeting not found");
      return sendJson(res, 200, meeting);
    }
    if (method === "PATCH") {
      const body = await readJson(req);
      const meeting = await meetings.update(id, (m) => {
        if (typeof body.title === "string") m.title = body.title.slice(0, 300);
        if (typeof body.context === "string") m.context = body.context;
        if (typeof body.notes === "string") m.notes = body.notes;
      });
      if (!meeting) throw new HttpError(404, "meeting not found");
      return sendJson(res, 200, meeting);
    }
    if (method === "DELETE") {
      if (!(await meetings.delete(id))) throw new HttpError(404, "meeting not found");
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(405, "method not allowed");
  }

  /** Streams Markdown deltas as SSE, then saves the finished notes. */
  async function streamEnhancement(
    res: ServerResponse,
    id: string,
    request: Pick<EnhanceRequest, "templateId">,
  ): Promise<void> {
    const meeting = await meetings.get(id);
    if (!meeting) throw new HttpError(404, "meeting not found");
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await enhancer.enhance(
        { meeting, templateId: request.templateId, signal: abort.signal },
        (delta) => event("delta", { text: delta }),
      );
      const saved = await meetings.update(id, (m) => {
        m.enhanced = result;
      });
      event("done", saved?.enhanced ?? result);
    } catch (err) {
      if (!abort.signal.aborted) event("error", { message: (err as Error).message });
    } finally {
      res.end();
    }
  }

  return server;
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isTrustedRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK_HOST.test(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and non-browser clients
  try {
    return LOOPBACK_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

async function serveFile(res: ServerResponse, root: string, relative: string): Promise<void> {
  const target = normalize(join(root, decodeURIComponent(relative)));
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) throw new HttpError(404, "not found");
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "not found");
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  createReadStream(target).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "expected a JSON object body");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
