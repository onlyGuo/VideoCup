import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Connect, Plugin } from "vite";
import {
  createNativeExportService,
  renderErrorResponse,
} from "./native-export.ts";
import type { NativeExportServiceOptions } from "./native-export.ts";

export function nativeExportPlugin(
  options: NativeExportServiceOptions = {},
): Plugin {
  const service = createNativeExportService(options);
  async function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction,
  ) {
    if (!req.url?.split("?")[0]?.startsWith("/api/render/")) return next();
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on("aborted", abort);
    res.on("close", abort);
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (value) headers.set(key, value.join(", "));
      }
      const url = new URL(
        req.url,
        `http://${headers.get("host") ?? "127.0.0.1"}`,
      );
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers,
        signal: controller.signal,
      };
      if (req.method === "POST" || req.method === "PUT") {
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      await send(
        await service.handle(new Request(url, init)),
        res,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent)
        await send(renderErrorResponse(error), res, controller.signal);
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  }
  const dispose = () => {
    void service.dispose();
  };
  return {
    name: "video-cup-native-export",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", dispose);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once("close", dispose);
    },
    async closeBundle() {
      await service.dispose();
    },
  };
}
async function send(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
) {
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel();
    return;
  }
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (response.body)
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      res,
      { signal },
    );
  else res.end();
}
