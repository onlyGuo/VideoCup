import type { Connect, Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createEdgeHandler,
  edgeErrorResponse,
  EdgeTtsError,
  MAX_REQUEST_BYTES,
} from "./edge-tts.ts";
import type { EdgeTtsOptions } from "./edge-tts.ts";

export function edgeTtsPlugin(options: EdgeTtsOptions = {}): Plugin {
  const handler = createEdgeHandler(options);
  async function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction,
  ) {
    const path = req.url?.split("?")[0];
    if (path !== "/api/edge/speech" && path !== "/api/edge/voices")
      return next();
    const abortController = new AbortController();
    const abort = () => {
      if (!res.writableEnded) abortController.abort();
    };
    req.on("aborted", abort);
    res.on("close", abort);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (value) headers.set(name, value.join(", "));
      }
      const url = new URL(
        req.url ?? "/",
        `http://${headers.get("host") ?? "127.0.0.1"}`,
      );
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))
        throw new EdgeTtsError(
          403,
          "local_access_only",
          "内置语音服务仅允许通过本机地址访问。",
        );
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (Number(headers.get("content-length")) > MAX_REQUEST_BYTES) {
        req.resume();
        throw new EdgeTtsError(413, "request_too_large", "语音请求内容过大。");
      }
      if (req.method === "POST") {
        const parts: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.byteLength;
          if (length > MAX_REQUEST_BYTES) {
            req.resume();
            throw new EdgeTtsError(
              413,
              "request_too_large",
              "语音请求内容过大。",
            );
          }
          parts.push(chunk);
        }
        body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of parts) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      await send(
        await handler(
          new Request(url, {
            method: req.method,
            headers,
            body,
            signal: abortController.signal,
          }),
        ),
        res,
      );
    } catch (error) {
      if (!abortController.signal.aborted)
        await send(edgeErrorResponse(error), res);
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  }
  return {
    name: "video-cup-local-edge-tts",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
async function send(response: Response, res: ServerResponse) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(new Uint8Array(await response.arrayBuffer()));
}
