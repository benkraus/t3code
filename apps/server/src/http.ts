import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  IosSimulatorInteractionInput,
  type IosSimulatorStatus,
  type ServerDiscoveryInfo,
} from "@t3tools/contracts";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { IosSimulator } from "./iosSimulator/Services/IosSimulator";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig } from "./config";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
export function shouldRedirectHttpRequestToDevServer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return true;
  }

  return (
    remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1"
  );
}

export const serverDiscoveryRouteLayer = HttpRouter.add(
  "GET",
  "/api/server-discovery",
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const payload: ServerDiscoveryInfo = {
      app: "t3code",
      authEnabled: Boolean(config.authToken),
    };

    return yield* HttpServerResponse.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }),
);

export const iosSimulatorStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/ios-simulator/status",
  Effect.gen(function* () {
    const simulator = yield* IosSimulator;
    const payload: IosSimulatorStatus = yield* simulator.getStatus;

    return yield* HttpServerResponse.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }),
);

export const iosSimulatorFrameRouteLayer = HttpRouter.add(
  "GET",
  "/api/ios-simulator/frame",
  Effect.gen(function* () {
    const simulator = yield* IosSimulator;
    return yield* simulator.captureFrame.pipe(
      Effect.map((frame) =>
        HttpServerResponse.uint8Array(frame.data, {
          status: 200,
          contentType: frame.contentType,
          headers: {
            "Cache-Control": "no-store",
          },
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.text(
            error instanceof Error
              ? error.message
              : "Unable to capture an iPhone simulator frame from the host Mac.",
            {
              status: 503,
              headers: {
                "Cache-Control": "no-store",
              },
            },
          ),
        ),
      ),
    );
  }),
);

export const iosSimulatorStreamRouteLayer = HttpRouter.add(
  "GET",
  "/api/ios-simulator/stream",
  Effect.gen(function* () {
    const simulator = yield* IosSimulator;
    return yield* simulator.openMjpegStream.pipe(
      Effect.map((payload) =>
        HttpServerResponse.stream(payload.stream, {
          status: 200,
          contentType: payload.contentType,
          headers: {
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.text(
            error instanceof Error
              ? error.message
              : "Unable to capture an iPhone simulator stream from the host Mac.",
            {
              status: 503,
              headers: {
                "Cache-Control": "no-store",
              },
            },
          ),
        ),
      ),
    );
  }),
);

export const iosSimulatorInputRouteLayer = HttpRouter.add(
  "POST",
  "/api/ios-simulator/input",
  Effect.gen(function* () {
    const simulator = yield* IosSimulator;

    return yield* HttpServerRequest.schemaBodyJson(IosSimulatorInteractionInput).pipe(
      Effect.flatMap((input) => simulator.sendInput(input)),
      Effect.as(
        HttpServerResponse.empty({
          status: 204,
          headers: {
            "Cache-Control": "no-store",
          },
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.text(
            Schema.isSchemaError(error)
              ? "Invalid simulator interaction payload."
              : error instanceof Error
                ? error.message
                : "Unable to forward input to the host iPhone simulator.",
            {
              status: Schema.isSchemaError(error) ? 400 : 503,
              headers: {
                "Cache-Control": "no-store",
              },
            },
          ),
        ),
      ),
    );
  }),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (
      config.devUrl &&
      shouldRedirectHttpRequestToDevServer(Option.getOrUndefined(request.remoteAddress))
    ) {
      return HttpServerResponse.redirect(config.devUrl.href, { status: 302 });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
