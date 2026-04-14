import type { IosSimulatorInteractionInput } from "@t3tools/contracts";
import { Data, Effect, type FileSystem, type Path } from "effect";

import { runProcess } from "../../processRunner";
import { ensureSwiftHelperBinary } from "./swiftHelper";

const IOS_SIMULATOR_INPUT_HELPER_VERSION = 2;
const IOS_SIMULATOR_INPUT_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct StatusPayload: Encodable {
    let available: Bool
    let message: String
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

struct CandidateFrame {
    let frame: CGRect
    let depth: Int
    let role: String?
}

func writeStdout(_ string: String) {
    if let data = string.data(using: .utf8) {
        FileHandle.standardOutput.write(data)
    }
}

func fail(_ message: String) -> Never {
    if let data = (message + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
    exit(1)
}

func emitStatus(_ available: Bool, _ message: String) -> Never {
    let payload = StatusPayload(available: available, message: message)
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(payload) else {
        fail("Unable to encode simulator interaction status.")
    }
    FileHandle.standardOutput.write(data)
    writeStdout("\n")
    exit(0)
}

func parseNormalizedValue(_ raw: String, label: String) throws -> Double {
    guard let value = Double(raw), value.isFinite, value >= 0.0, value <= 1.0 else {
        throw HelperFailure.usage("Invalid " + label + " coordinate. Expected a number between 0 and 1.")
    }
    return value
}

func parseAspectRatio(_ raw: String) throws -> Double {
    guard let value = Double(raw), value.isFinite, value > 0.1, value < 10 else {
        throw HelperFailure.usage("Invalid frame aspect ratio.")
    }
    return value
}

func parseDuration(_ raw: String) throws -> Int {
    guard let value = Int(raw), value > 0, value <= 10_000 else {
        throw HelperFailure.usage("Invalid swipe duration. Expected 1...10000 milliseconds.")
    }
    return value
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

func scoreCandidate(
    _ candidate: CandidateFrame,
    windowFrame: CGRect,
    aspectRatio: Double
) -> Double {
    let area = candidate.frame.width * candidate.frame.height
    if area <= 0 {
        return -.greatestFiniteMagnitude
    }

    let windowArea = windowFrame.width * windowFrame.height
    if area >= windowArea * 0.995 {
        return -.greatestFiniteMagnitude
    }

    var score = area
    let candidateAspectRatio = candidate.frame.width / max(candidate.frame.height, 1)
    score -= abs(candidateAspectRatio - aspectRatio) * 240_000

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

func resolveInputFrame(window: AXUIElement, aspectRatio: Double) throws -> CGRect {
    guard let windowFrame = frameOfElement(window) else {
        throw HelperFailure.runtime("Unable to read the Simulator window bounds.")
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
        scoreCandidate($0, windowFrame: windowFrame, aspectRatio: aspectRatio) <
            scoreCandidate($1, windowFrame: windowFrame, aspectRatio: aspectRatio)
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

func ensureInteractionContext(deviceName: String) throws -> (NSRunningApplication, AXUIElement, CGRect) {
    guard AXIsProcessTrusted() else {
        throw HelperFailure.runtime(
            "Simulator interaction requires Accessibility access. Allow Terminal or T3 Code in System Settings > Privacy & Security > Accessibility."
        )
    }

    guard let app = findSimulatorApplication() else {
        throw HelperFailure.runtime("Simulator.app is not running on the host Mac.")
    }

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = matchingWindow(for: appElement, deviceName: deviceName) else {
        throw HelperFailure.runtime(
            "Open the " + deviceName + " Simulator window on the host Mac to enable interaction."
        )
    }

    guard let windowFrame = frameOfElement(window) else {
        throw HelperFailure.runtime("Unable to read the Simulator window bounds.")
    }

    return (app, window, windowFrame)
}

func normalizedPoint(in frame: CGRect, x: Double, y: Double) -> CGPoint {
    CGPoint(
        x: frame.minX + frame.width * x,
        y: frame.minY + frame.height * y
    )
}

func postMouseEvent(_ type: CGEventType, point: CGPoint) throws {
    guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        throw HelperFailure.runtime("Unable to create a Simulator interaction event.")
    }
    event.post(tap: .cghidEventTap)
}

func sendTap(at point: CGPoint) throws {
    try postMouseEvent(.mouseMoved, point: point)
    usleep(6_000)
    try postMouseEvent(.leftMouseDown, point: point)
    usleep(14_000)
    try postMouseEvent(.leftMouseUp, point: point)
}

func sendSwipe(from start: CGPoint, to end: CGPoint, durationMs: Int) throws {
    try postMouseEvent(.mouseMoved, point: start)
    usleep(6_000)
    try postMouseEvent(.leftMouseDown, point: start)

    let steps = max(8, min(48, durationMs / 12))
    let stepDurationUs = useconds_t(max(1, durationMs / max(steps, 1)) * 1_000)

    if steps > 0 {
        for step in 1...steps {
            let progress = Double(step) / Double(steps)
            let currentPoint = CGPoint(
                x: start.x + (end.x - start.x) * progress,
                y: start.y + (end.y - start.y) * progress
            )
            try postMouseEvent(.leftMouseDragged, point: currentPoint)
            usleep(stepDurationUs)
        }
    }

    try postMouseEvent(.leftMouseUp, point: end)
}

func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        throw HelperFailure.usage("Missing Simulator interaction command.")
    }

    switch command {
    case "status":
        guard arguments.count >= 2 else {
            throw HelperFailure.usage("Usage: status <device-name>")
        }

        do {
            let (app, window, _) = try ensureInteractionContext(deviceName: arguments[1])
            _ = app.activate()
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            emitStatus(
                true,
                "Interactive control ready. Keep Simulator visible and disable device bezels for the most precise mapping."
            )
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Simulator interaction is unavailable."
            emitStatus(false, message)
        }

    case "tap":
        guard arguments.count >= 5 else {
            throw HelperFailure.usage("Usage: tap <device-name> <x> <y> <aspect-ratio>")
        }

        let deviceName = arguments[1]
        let x = try parseNormalizedValue(arguments[2], label: "x")
        let y = try parseNormalizedValue(arguments[3], label: "y")
        let aspectRatio = try parseAspectRatio(arguments[4])

        let (app, window, _) = try ensureInteractionContext(deviceName: deviceName)
        _ = app.activate()
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        usleep(18_000)

        let inputFrame = try resolveInputFrame(window: window, aspectRatio: aspectRatio)
        try sendTap(at: normalizedPoint(in: inputFrame, x: x, y: y))

    case "swipe":
        guard arguments.count >= 8 else {
            throw HelperFailure.usage(
                "Usage: swipe <device-name> <from-x> <from-y> <to-x> <to-y> <duration-ms> <aspect-ratio>"
            )
        }

        let deviceName = arguments[1]
        let fromX = try parseNormalizedValue(arguments[2], label: "from-x")
        let fromY = try parseNormalizedValue(arguments[3], label: "from-y")
        let toX = try parseNormalizedValue(arguments[4], label: "to-x")
        let toY = try parseNormalizedValue(arguments[5], label: "to-y")
        let durationMs = try parseDuration(arguments[6])
        let aspectRatio = try parseAspectRatio(arguments[7])

        let (app, window, _) = try ensureInteractionContext(deviceName: deviceName)
        _ = app.activate()
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        usleep(18_000)

        let inputFrame = try resolveInputFrame(window: window, aspectRatio: aspectRatio)
        try sendSwipe(
            from: normalizedPoint(in: inputFrame, x: fromX, y: fromY),
            to: normalizedPoint(in: inputFrame, x: toX, y: toY),
            durationMs: durationMs
        )

    default:
        throw HelperFailure.usage("Unknown Simulator interaction command: " + command)
    }
}

do {
    try run()
} catch {
    let message = (error as? LocalizedError)?.errorDescription ?? "Simulator interaction failed."
    fail(message)
}
`;

export interface IosSimulatorInteractionStatus {
  readonly supported: boolean;
  readonly available: boolean;
  readonly message: string;
}

class IosSimulatorInteractionHelperError extends Data.TaggedError(
  "IosSimulatorInteractionHelperError",
)<{
  readonly message: string;
  readonly supported?: boolean;
  readonly cause?: unknown;
}> {}

const IOS_SIMULATOR_INPUT_HELPER_DIRECTORY = "t3code-ios-simulator-input";
const IOS_SIMULATOR_INPUT_HELPER_BASENAME = `ios-simulator-input-helper-v${IOS_SIMULATOR_INPUT_HELPER_VERSION}`;

let cachedHelperPathPromise: Promise<string> | null = null;

function normalizeHelperError(
  error: unknown,
  fallback: string,
): IosSimulatorInteractionHelperError {
  return new IosSimulatorInteractionHelperError({
    message: error instanceof Error && error.message ? error.message : fallback,
    cause: error,
  });
}

async function ensureHelperBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Promise<string> {
  return ensureSwiftHelperBinary({
    ...input,
    directory: IOS_SIMULATOR_INPUT_HELPER_DIRECTORY,
    basename: IOS_SIMULATOR_INPUT_HELPER_BASENAME,
    source: IOS_SIMULATOR_INPUT_HELPER_SOURCE,
  });
}

function getHelperBinary(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<string, IosSimulatorInteractionHelperError> {
  if (!cachedHelperPathPromise) {
    cachedHelperPathPromise = ensureHelperBinary(input).catch((error) => {
      cachedHelperPathPromise = null;
      throw error;
    });
  }

  return Effect.tryPromise({
    try: () => cachedHelperPathPromise as Promise<string>,
    catch: (error) =>
      new IosSimulatorInteractionHelperError({
        message:
          error instanceof Error && error.message
            ? error.message
            : "Unable to build the iPhone simulator interaction helper on the host Mac.",
        supported: false,
        cause: error,
      }),
  });
}

function helperStatusArgs(deviceName: string): ReadonlyArray<string> {
  return ["status", deviceName];
}

function helperInputArgs(input: {
  readonly deviceName: string;
  readonly interaction: IosSimulatorInteractionInput;
}): ReadonlyArray<string> {
  const { deviceName, interaction } = input;
  if (interaction.type === "tap") {
    return [
      "tap",
      deviceName,
      String(interaction.x),
      String(interaction.y),
      String(interaction.frameAspectRatio),
    ];
  }

  return [
    "swipe",
    deviceName,
    String(interaction.fromX),
    String(interaction.fromY),
    String(interaction.toX),
    String(interaction.toY),
    String(interaction.durationMs),
    String(interaction.frameAspectRatio),
  ];
}

function parseHelperStatusPayload(stdout: string): IosSimulatorInteractionStatus {
  const parsed = JSON.parse(stdout) as {
    available?: unknown;
    message?: unknown;
  };
  return {
    supported: true,
    available: parsed.available === true,
    message:
      typeof parsed.message === "string" && parsed.message.trim().length > 0
        ? parsed.message.trim()
        : "Simulator interaction is unavailable.",
  };
}

export const getIosSimulatorInteractionStatus = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly deviceName: string;
}): Effect.Effect<IosSimulatorInteractionStatus> =>
  getHelperBinary(input).pipe(
    Effect.flatMap((helperPath) =>
      Effect.tryPromise({
        try: () =>
          runProcess(helperPath, [...helperStatusArgs(input.deviceName)], { timeoutMs: 5_000 }),
        catch: (error) =>
          normalizeHelperError(error, "Unable to inspect Simulator interaction support."),
      }),
    ),
    Effect.flatMap((result) =>
      Effect.try({
        try: () => parseHelperStatusPayload(result.stdout),
        catch: (error) =>
          new IosSimulatorInteractionHelperError({
            message:
              error instanceof Error && error.message
                ? error.message
                : "Unable to inspect Simulator interaction support.",
            cause: error,
          }),
      }),
    ),
    Effect.catch((error: IosSimulatorInteractionHelperError) =>
      Effect.succeed({
        supported: error.supported ?? true,
        available: false,
        message: error.message,
      } satisfies IosSimulatorInteractionStatus),
    ),
  );

export const sendIosSimulatorInteraction = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly deviceName: string;
  readonly interaction: IosSimulatorInteractionInput;
}): Effect.Effect<void, IosSimulatorInteractionHelperError> =>
  getHelperBinary(input).pipe(
    Effect.flatMap((helperPath) =>
      Effect.tryPromise({
        try: () =>
          runProcess(helperPath, [...helperInputArgs(input)], {
            timeoutMs:
              input.interaction.type === "swipe"
                ? Math.max(5_000, input.interaction.durationMs + 2_000)
                : 5_000,
          }),
        catch: (error) =>
          normalizeHelperError(error, "Unable to forward interaction to the host Simulator."),
      }),
    ),
    Effect.asVoid,
  );
