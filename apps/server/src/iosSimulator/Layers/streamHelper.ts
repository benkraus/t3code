import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Stream as NodeStream } from "node:stream";
import { Data, Effect, Stream, type FileSystem, type Path } from "effect";

import { ensureSwiftHelperBinary } from "./swiftHelper";

const IOS_SIMULATOR_STREAM_HELPER_VERSION = 2;
const IOS_SIMULATOR_STREAM_BOUNDARY = "frame";
const IOS_SIMULATOR_STREAM_HELPER_DIRECTORY = "t3code-ios-simulator-stream";
const IOS_SIMULATOR_STREAM_HELPER_BASENAME = `ios-simulator-stream-helper-v${IOS_SIMULATOR_STREAM_HELPER_VERSION}`;
const IOS_SIMULATOR_STREAM_HELPER_READY_MARKER = "__T3CODE_STREAM_READY__";
const IOS_SIMULATOR_STREAM_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct CandidateFrame {
    let frame: CGRect
    let depth: Int
    let role: String?
}

enum HelperFailure: LocalizedError {
    case usage(String)
    case runtime(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message):
            return message
        case .runtime(let message):
            return message
        }
    }
}

func fail(_ message: String) -> Never {
    if let data = (message + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
    exit(1)
}

func writeReady() {
    if let data = "${IOS_SIMULATOR_STREAM_HELPER_READY_MARKER}\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func copyAttributeValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = copyAttributeValue(element, attribute) else { return nil }
    return value as? String
}

func childElements(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = copyAttributeValue(element, kAXChildrenAttribute as String) else {
        return []
    }
    return value as? [AXUIElement] ?? []
}

func frameOfElement(_ element: AXUIElement) -> CGRect? {
    guard
        let positionRaw = copyAttributeValue(element, kAXPositionAttribute as String),
        let sizeRaw = copyAttributeValue(element, kAXSizeAttribute as String)
    else {
        return nil
    }

    let positionValue = unsafeDowncast(positionRaw, to: AXValue.self)
    let sizeValue = unsafeDowncast(sizeRaw, to: AXValue.self)

    var position = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetType(positionValue) == .cgPoint,
        AXValueGetValue(positionValue, .cgPoint, &position),
        AXValueGetType(sizeValue) == .cgSize,
        AXValueGetValue(sizeValue, .cgSize, &size)
    else {
        return nil
    }

    return CGRect(origin: position, size: size)
}

func collectCandidateFrames(
    from element: AXUIElement,
    depth: Int,
    maxDepth: Int,
    windowFrame: CGRect,
    into output: inout [CandidateFrame]
) {
    guard depth <= maxDepth else { return }

    if let frame = frameOfElement(element) {
        let normalizedFrame = frame.intersection(windowFrame)
        if normalizedFrame.width > 40 && normalizedFrame.height > 40 {
            output.append(
                CandidateFrame(
                    frame: normalizedFrame,
                    depth: depth,
                    role: stringAttribute(element, kAXRoleAttribute as String)
                )
            )
        }
    }

    for child in childElements(element) {
        collectCandidateFrames(
            from: child,
            depth: depth + 1,
            maxDepth: maxDepth,
            windowFrame: windowFrame,
            into: &output
        )
    }
}

func scoreCandidate(_ candidate: CandidateFrame, windowFrame: CGRect) -> Double {
    let area = candidate.frame.width * candidate.frame.height
    if area <= 0 {
        return -.greatestFiniteMagnitude
    }

    let windowArea = windowFrame.width * windowFrame.height
    if area >= windowArea * 0.995 {
        return -.greatestFiniteMagnitude
    }

    var score = area

    if candidate.frame.minY <= windowFrame.minY + 20 {
        score -= 160_000
    }

    if candidate.frame.width < windowFrame.width * 0.4 || candidate.frame.height < windowFrame.height * 0.4 {
        score -= 120_000
    }

    switch candidate.role {
    case String(kAXImageRole):
        score += 200_000
    case "AXScrollArea":
        score += 160_000
    case String(kAXGroupRole):
        score += 110_000
    default:
        break
    }

    score += Double(candidate.depth) * 6_000
    return score
}

func fallbackContentFrame(for windowFrame: CGRect) -> CGRect {
    let titleBarHeight = min(34.0, max(22.0, windowFrame.height * 0.08))
    return CGRect(
        x: windowFrame.minX + 4,
        y: windowFrame.minY + titleBarHeight,
        width: max(1, windowFrame.width - 8),
        height: max(1, windowFrame.height - titleBarHeight - 4)
    )
}

func resolveContentFrame(window: AXUIElement) -> CGRect? {
    guard let windowFrame = frameOfElement(window) else {
        return nil
    }

    var candidates: [CandidateFrame] = []
    collectCandidateFrames(
        from: window,
        depth: 0,
        maxDepth: 6,
        windowFrame: windowFrame,
        into: &candidates
    )

    let bestFrame = candidates.max {
        scoreCandidate($0, windowFrame: windowFrame) < scoreCandidate($1, windowFrame: windowFrame)
    }?.frame

    return bestFrame ?? fallbackContentFrame(for: windowFrame)
}

func findSimulatorApplication() -> NSRunningApplication? {
    let bundleMatches = NSRunningApplication.runningApplications(
        withBundleIdentifier: "com.apple.iphonesimulator"
    )
    if let app = bundleMatches.first(where: { !$0.isTerminated }) {
        return app
    }

    return NSWorkspace.shared.runningApplications.first {
        $0.localizedName == "Simulator" && !$0.isTerminated
    }
}

func matchingWindow(for appElement: AXUIElement, deviceName: String) -> AXUIElement? {
    let windowsValue = copyAttributeValue(appElement, kAXWindowsAttribute as String)
    let windows = windowsValue as? [AXUIElement] ?? []
    let loweredDeviceName = deviceName.lowercased()

    let framedWindows = windows.filter { frameOfElement($0) != nil }
    if let exact = framedWindows.first(where: {
        (stringAttribute($0, kAXTitleAttribute as String) ?? "").lowercased().contains(loweredDeviceName)
    }) {
        return exact
    }

    return framedWindows.first
}

func resolveCropRect(deviceName: String, simulatorWindowFrame: CGRect) -> CGRect {
    let titleBarFallback = fallbackContentFrame(for: simulatorWindowFrame)
    guard AXIsProcessTrusted() else {
        return titleBarFallback
    }

    guard let app = findSimulatorApplication() else {
        return titleBarFallback
    }

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = matchingWindow(for: appElement, deviceName: deviceName) else {
        return titleBarFallback
    }

    return resolveContentFrame(window: window) ?? titleBarFallback
}

func findCaptureWindow(deviceName: String) async throws -> SCWindow {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    if let exact = content.windows.first(where: { window in
        window.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator" &&
        (window.title?.lowercased().contains(deviceName.lowercased()) ?? false)
    }) {
        return exact
    }

    if let fallback = content.windows.first(where: {
        $0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator"
    }) {
        return fallback
    }

    throw HelperFailure.runtime("Open the \(deviceName) Simulator window on the host Mac to enable live streaming.")
}

final class SimulatorStreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let ciContext = CIContext()
    private let cropRect: CGRect
    private let windowFrame: CGRect
    private let jpegQuality: CGFloat
    private let outputHandle: FileHandle
    private var isProcessingFrame = false
    private let lock = NSLock()

    init(windowFrame: CGRect, cropRect: CGRect, jpegQuality: CGFloat) {
        self.windowFrame = windowFrame
        self.cropRect = cropRect
        self.jpegQuality = jpegQuality
        self.outputHandle = FileHandle.standardOutput
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(error.localizedDescription)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }

        lock.lock()
        if isProcessingFrame {
            lock.unlock()
            return
        }
        isProcessingFrame = true
        lock.unlock()

        defer {
            lock.lock()
            isProcessingFrame = false
            lock.unlock()
        }

        guard let imageBuffer = sampleBuffer.imageBuffer else {
            return
        }

        let image = CIImage(cvPixelBuffer: imageBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            return
        }

        let scaleX = CGFloat(cgImage.width) / max(windowFrame.width, 1)
        let scaleY = CGFloat(cgImage.height) / max(windowFrame.height, 1)
        let cropOriginX = max(0, (cropRect.minX - windowFrame.minX) * scaleX)
        let cropOriginYFromTop = max(0, (cropRect.minY - windowFrame.minY) * scaleY)
        let cropWidth = min(CGFloat(cgImage.width), max(1, cropRect.width * scaleX))
        let cropHeight = min(CGFloat(cgImage.height), max(1, cropRect.height * scaleY))
        let cropOriginY = max(0, CGFloat(cgImage.height) - cropOriginYFromTop - cropHeight)
        let pixelCropRect = CGRect(
            x: cropOriginX,
            y: cropOriginY,
            width: min(cropWidth, CGFloat(cgImage.width) - cropOriginX),
            height: min(cropHeight, CGFloat(cgImage.height) - cropOriginY)
        ).integral

        guard let croppedImage = cgImage.cropping(to: pixelCropRect) else {
            return
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            return
        }

        CGImageDestinationAddImage(
            destination,
            croppedImage,
            [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            return
        }

        var header = Data()
        header.append("--${IOS_SIMULATOR_STREAM_BOUNDARY}\r\n".data(using: .utf8)!)
        header.append("Content-Type: image/jpeg\r\n".data(using: .utf8)!)
        header.append("Content-Length: \(data.length)\r\n\r\n".data(using: .utf8)!)
        outputHandle.write(header)
        outputHandle.write(data as Data)
        outputHandle.write("\r\n".data(using: .utf8)!)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let deviceName = arguments.first, !deviceName.isEmpty else {
    fail("Missing Simulator device name.")
}

let fps = arguments.count >= 2 ? max(2, min(30, Int(arguments[1]) ?? 12)) : 12
let jpegQualityRaw = arguments.count >= 3 ? Double(arguments[2]) ?? 0.6 : 0.6
let jpegQuality = CGFloat(max(0.2, min(0.95, jpegQualityRaw)))

_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

Task { @MainActor in
    do {
        let captureWindow = try await findCaptureWindow(deviceName: deviceName)
        let windowFrame = captureWindow.frame
        let cropRect = resolveCropRect(deviceName: deviceName, simulatorWindowFrame: windowFrame)

        let filter = SCContentFilter(desktopIndependentWindow: captureWindow)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(max(1, cropRect.width) * 2)
        configuration.height = Int(max(1, cropRect.height) * 2)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = 2
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true

        let output = SimulatorStreamOutput(
            windowFrame: windowFrame,
            cropRect: cropRect,
            jpegQuality: jpegQuality
        )
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(
            output,
            type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "t3code.simulator.stream")
        )
        try await stream.startCapture()
        writeReady()
    } catch {
        fail((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
    }
}

dispatchMain()
`;

export interface IosSimulatorMjpegStream {
  readonly contentType: string;
  readonly stream: Stream.Stream<Uint8Array, Error>;
}

class IosSimulatorStreamHelperError extends Data.TaggedError("IosSimulatorStreamHelperError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

let cachedHelperPathPromise: Promise<string> | null = null;

async function ensureHelperBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Promise<string> {
  return ensureSwiftHelperBinary({
    ...input,
    directory: IOS_SIMULATOR_STREAM_HELPER_DIRECTORY,
    basename: IOS_SIMULATOR_STREAM_HELPER_BASENAME,
    source: IOS_SIMULATOR_STREAM_HELPER_SOURCE,
  });
}

function getHelperBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<string, IosSimulatorStreamHelperError> {
  if (!cachedHelperPathPromise) {
    cachedHelperPathPromise = ensureHelperBinary(input).catch((error) => {
      cachedHelperPathPromise = null;
      throw error;
    });
  }

  return Effect.tryPromise({
    try: () => cachedHelperPathPromise as Promise<string>,
    catch: (error) =>
      new IosSimulatorStreamHelperError({
        message:
          error instanceof Error && error.message
            ? error.message
            : "Unable to build the iPhone simulator stream helper on the host Mac.",
        cause: error,
      }),
  });
}

function toHelperError(error: unknown, fallback: string): IosSimulatorStreamHelperError {
  return new IosSimulatorStreamHelperError({
    message: error instanceof Error && error.message ? error.message : fallback,
    cause: error,
  });
}

type StreamHelperProcess = ChildProcessByStdio<null, Readable, Readable>;

async function waitForHelperReady(process: StreamHelperProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.kill("SIGTERM");
      reject(new Error("Timed out waiting for the simulator stream helper to start."));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      process.stderr.off("data", onStderr);
      process.off("error", onError);
      process.off("exit", onExit);
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onStderr = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      stderr += text;
      if (stderr.includes(IOS_SIMULATOR_STREAM_HELPER_READY_MARKER)) {
        finish(resolve);
      }
    };
    const onError = (error: Error) => {
      finish(() => reject(error));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const message = stderr.replace(IOS_SIMULATOR_STREAM_HELPER_READY_MARKER, "").trim();
      finish(() =>
        reject(
          new Error(
            message.length > 0
              ? message
              : `Simulator stream helper exited before streaming (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
          ),
        ),
      );
    };

    process.stderr.on("data", onStderr);
    process.once("error", onError);
    process.once("exit", onExit);
  });
}

function childStdoutChunks(input: {
  readonly process: StreamHelperProcess;
  readonly stderrRef: { current: string };
}): AsyncIterable<Uint8Array> {
  const { process, stderrRef } = input;

  return {
    async *[Symbol.asyncIterator]() {
      const onStderr = (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        stderrRef.current += text;
      };

      process.stderr.on("data", onStderr);
      try {
        for await (const chunk of process.stdout as NodeStream & AsyncIterable<Buffer>) {
          yield new Uint8Array(chunk);
        }

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            process.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        if (exit.code !== 0 && exit.signal !== "SIGTERM" && exit.signal !== "SIGINT") {
          const message = stderrRef.current
            .replace(IOS_SIMULATOR_STREAM_HELPER_READY_MARKER, "")
            .trim();
          throw new Error(
            message.length > 0
              ? message
              : `Simulator stream helper exited unexpectedly (code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}).`,
          );
        }
      } finally {
        process.stderr.off("data", onStderr);
        if (!process.killed) {
          process.kill("SIGTERM");
        }
      }
    },
  };
}

export const IOS_SIMULATOR_MJPEG_CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${IOS_SIMULATOR_STREAM_BOUNDARY}`;

export const getIosSimulatorMjpegStream = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly deviceName: string;
  readonly fps?: number;
  readonly jpegQuality?: number;
}): Effect.Effect<IosSimulatorMjpegStream, IosSimulatorStreamHelperError> =>
  Effect.gen(function* () {
    const binaryPath = yield* getHelperBinary(input);
    const fps = Math.max(2, Math.min(30, Math.round(input.fps ?? 12)));
    const jpegQuality = Math.max(0.2, Math.min(0.95, input.jpegQuality ?? 0.6));

    const process = yield* Effect.try({
      try: () =>
        spawn(binaryPath, [input.deviceName, String(fps), String(jpegQuality)], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: (error) =>
        toHelperError(error, "Unable to start the iPhone simulator stream helper on the host Mac."),
    });

    yield* Effect.tryPromise({
      try: () => waitForHelperReady(process),
      catch: (error) =>
        toHelperError(error, "Unable to start the iPhone simulator live stream on the host Mac."),
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (!process.killed) {
            process.kill("SIGTERM");
          }
        }),
      ),
    );

    const stderrRef = { current: "" };
    return {
      contentType: IOS_SIMULATOR_MJPEG_CONTENT_TYPE,
      stream: Stream.fromAsyncIterable(
        childStdoutChunks({ process, stderrRef }),
        (cause) => new Error(String(cause)),
      ),
    } satisfies IosSimulatorMjpegStream;
  });
