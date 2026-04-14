import type { IosSimulatorInteractionInput, IosSimulatorStatus } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  HandIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveServerHttpOrigin } from "../serverConnection";
import { getWsRpcClient } from "../wsRpcClient";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

export type SimulatorPaneMode = "sheet" | "sidebar";

const STATUS_REFRESH_MS = 5_000;
const DEFAULT_FRAME_ASPECT_RATIO = 390 / 844;
const TAP_MAX_MOVEMENT_PX = 14;
const TAP_MAX_DURATION_MS = 280;
const MIN_SWIPE_DURATION_MS = 70;
const MAX_SWIPE_DURATION_MS = 900;
const REMOTE_FRAME_REFRESH_MS = 350;

interface GestureState {
  readonly pointerId: number;
  readonly startedAt: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startPoint: {
    readonly x: number;
    readonly y: number;
  };
  currentPoint: {
    readonly x: number;
    readonly y: number;
  };
}

function buildServerUrl(pathname: string, search?: URLSearchParams): string {
  if (typeof window === "undefined") {
    return pathname;
  }

  const resolvedServerOrigin = resolveServerHttpOrigin();
  const origin =
    pathname.startsWith("/api/") &&
    /^https?:$/.test(window.location.protocol) &&
    resolvedServerOrigin.length > 0 &&
    resolvedServerOrigin !== window.location.origin
      ? window.location.origin
      : resolvedServerOrigin || window.location.origin;
  const url = new URL(pathname, origin || window.location.origin);
  if (search) {
    url.search = search.toString();
  }
  return url.toString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function statusTone(
  status: IosSimulatorStatus | null,
  frameError: string | null,
  interactionError: string | null,
) {
  if (interactionError || frameError) return "text-amber-300";
  if (!status) return "text-muted-foreground";
  if (status.available && status.interactionAvailable) return "text-emerald-300";
  if (status.available) return "text-sky-300";
  if (!status.supported) return "text-muted-foreground";
  return "text-amber-300";
}

function normalizePointer(
  surface: HTMLDivElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return {
    x: clampUnitInterval((clientX - rect.left) / rect.width),
    y: clampUnitInterval((clientY - rect.top) / rect.height),
  };
}

function gestureDistancePx(input: GestureState, clientX: number, clientY: number): number {
  return Math.hypot(clientX - input.startClientX, clientY - input.startClientY);
}

function revokeObjectUrl(objectUrl: string | null | undefined): void {
  if (!objectUrl || typeof URL === "undefined" || !objectUrl.startsWith("blob:")) {
    return;
  }

  URL.revokeObjectURL(objectUrl);
}

function decodeBase64Image(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}

export default function SimulatorPane(props: {
  mode: SimulatorPaneMode;
  onClose?: () => void;
  active?: boolean;
}) {
  const { mode, onClose, active = true } = props;
  const [connectionMode, setConnectionMode] = useState<"local" | "remote" | "unknown">(() => {
    if (typeof window === "undefined") {
      return "local";
    }

    return window.desktopBridge ? "unknown" : "local";
  });
  const [status, setStatus] = useState<IosSimulatorStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [lastFrameLoadedAt, setLastFrameLoadedAt] = useState<number | null>(null);
  const [frameAspectRatio, setFrameAspectRatio] = useState(DEFAULT_FRAME_ASPECT_RATIO);
  const [isSendingInput, setIsSendingInput] = useState(false);
  const [frameRefreshRevision, setFrameRefreshRevision] = useState(0);
  const [isStreamConnected, setIsStreamConnected] = useState(false);
  const frameImageRef = useRef<HTMLImageElement | null>(null);
  const interactionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const activeFrameObjectUrlRef = useRef<string | null>(null);
  const staleFrameObjectUrlsRef = useRef<string[]>([]);
  const rpcClientRef = useRef(getWsRpcClient());
  const isRemoteConnection = connectionMode === "remote";

  const clearDisplayedFrame = useEffectEvent(() => {
    setHasFrame(false);
    setLastFrameLoadedAt(null);
    setFrameAspectRatio(DEFAULT_FRAME_ASPECT_RATIO);
    setIsStreamConnected(false);

    if (frameImageRef.current) {
      frameImageRef.current.removeAttribute("src");
    }

    revokeObjectUrl(activeFrameObjectUrlRef.current);
    activeFrameObjectUrlRef.current = null;

    for (const objectUrl of staleFrameObjectUrlsRef.current) {
      revokeObjectUrl(objectUrl);
    }
    staleFrameObjectUrlsRef.current = [];
  });

  const flushStaleFrameObjectUrls = useEffectEvent(() => {
    for (const objectUrl of staleFrameObjectUrlsRef.current) {
      revokeObjectUrl(objectUrl);
    }
    staleFrameObjectUrlsRef.current = [];
  });

  const commitFrameObjectUrl = useEffectEvent((objectUrl: string, capturedAt: number | null) => {
    const previousObjectUrl = activeFrameObjectUrlRef.current;
    if (previousObjectUrl) {
      staleFrameObjectUrlsRef.current.push(previousObjectUrl);
    }

    activeFrameObjectUrlRef.current = objectUrl;
    if (frameImageRef.current) {
      frameImageRef.current.src = objectUrl;
    }

    setHasFrame(true);
    setFrameError(null);
    setIsStreamConnected(true);
    if (capturedAt !== null) {
      setLastFrameLoadedAt(capturedAt);
    }
  });

  useEffect(() => () => clearDisplayedFrame(), []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.desktopBridge?.getConnectionSettings) {
      setConnectionMode("local");
      return;
    }

    let cancelled = false;
    void window.desktopBridge
      .getConnectionSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }
        setConnectionMode(settings.mode === "remote" ? "remote" : "local");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setConnectionMode("local");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      clearDisplayedFrame();
      return;
    }

    if (connectionMode === "unknown") {
      return;
    }

    let cancelled = false;
    const initialController = new AbortController();

    const loadStatus = async (signal?: AbortSignal) => {
      try {
        if (isRemoteConnection) {
          const nextStatus = await rpcClientRef.current.simulator.getStatus();
          if (cancelled) {
            return;
          }

          setStatus(nextStatus);
          setStatusError(null);
          if (!nextStatus.available) {
            clearDisplayedFrame();
            setFrameError(null);
          }
          if (nextStatus.interactionAvailable) {
            setInteractionError(null);
          }
          return;
        }

        const requestInit: RequestInit = {
          cache: "no-store",
        };
        if (signal) {
          requestInit.signal = signal;
        }
        const response = await fetch(buildServerUrl("/api/ios-simulator/status"), requestInit);
        if (!response.ok) {
          throw new Error(`Simulator status request failed (${response.status}).`);
        }

        const nextStatus = (await response.json()) as IosSimulatorStatus;
        if (cancelled) {
          return;
        }

        setStatus(nextStatus);
        setStatusError(null);
        if (!nextStatus.available) {
          clearDisplayedFrame();
          setFrameError(null);
        }
        if (nextStatus.interactionAvailable) {
          setInteractionError(null);
        }
      } catch (error) {
        if (cancelled || isAbortError(error)) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Unable to reach the simulator host endpoint.";
        setStatusError(message);
      }
    };

    void loadStatus(initialController.signal);
    const intervalId = window.setInterval(() => {
      void loadStatus();
    }, STATUS_REFRESH_MS);

    return () => {
      cancelled = true;
      initialController.abort();
      window.clearInterval(intervalId);
    };
  }, [active, connectionMode, isRemoteConnection]);

  useEffect(() => {
    if (!active) {
      clearDisplayedFrame();
      return;
    }

    if (connectionMode === "unknown") {
      return;
    }

    if (!status?.available) {
      clearDisplayedFrame();
      return;
    }

    if (!isRemoteConnection) {
      const streamUrl = buildServerUrl(
        "/api/ios-simulator/stream",
        new URLSearchParams({ r: String(frameRefreshRevision) }),
      );
      const frameImage = frameImageRef.current;

      setHasFrame(false);
      setIsStreamConnected(false);
      setFrameError(null);
      if (frameImage) {
        frameImage.src = streamUrl;
      }

      return () => {
        if (frameImage?.src === streamUrl) {
          frameImage.removeAttribute("src");
        }
        setIsStreamConnected(false);
      };
    }

    let cancelled = false;
    let inFlight = false;
    let pendingController: AbortController | null = null;

    const loadFrame = async () => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;
      const controller = new AbortController();
      pendingController = controller;
      try {
        if (isRemoteConnection) {
          const frame = await rpcClientRef.current.simulator.captureFrame();
          if (cancelled) {
            return;
          }

          const frameObjectUrl = URL.createObjectURL(
            decodeBase64Image(frame.imageBase64, frame.contentType),
          );
          commitFrameObjectUrl(
            frameObjectUrl,
            Number.isFinite(frame.capturedAt) ? frame.capturedAt : Date.now(),
          );
          return;
        }

        const response = await fetch(buildServerUrl("/api/ios-simulator/frame"), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = (await response.text()).trim();
          throw new Error(
            message.length > 0 ? message : `Simulator frame request failed (${response.status}).`,
          );
        }

        const frameBlob = await response.blob();
        if (cancelled) {
          return;
        }

        const frameObjectUrl = URL.createObjectURL(frameBlob);
        commitFrameObjectUrl(frameObjectUrl, Date.now());
      } catch (error) {
        if (cancelled || isAbortError(error)) {
          return;
        }

        setIsStreamConnected(false);
        setFrameError(
          error instanceof Error ? error.message : "The host Mac did not return a simulator frame.",
        );
      } finally {
        if (pendingController === controller) {
          pendingController = null;
        }
        inFlight = false;
      }
    };

    void loadFrame();
    const intervalId = window.setInterval(() => {
      void loadFrame();
    }, REMOTE_FRAME_REFRESH_MS);

    return () => {
      cancelled = true;
      pendingController?.abort();
      setIsStreamConnected(false);
      window.clearInterval(intervalId);
    };
  }, [active, connectionMode, frameRefreshRevision, isRemoteConnection, status?.available]);

  const sendInput = async (input: IosSimulatorInteractionInput) => {
    try {
      setIsSendingInput(true);
      if (isRemoteConnection) {
        await rpcClientRef.current.simulator.sendInput(input);
        setInteractionError(null);
        return;
      }

      const response = await fetch(buildServerUrl("/api/ios-simulator/input"), {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(
          message.length > 0 ? message : `Simulator input request failed (${response.status}).`,
        );
      }

      setInteractionError(null);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setInteractionError(
        error instanceof Error ? error.message : "Unable to forward input to the host simulator.",
      );
    } finally {
      setIsSendingInput(false);
    }
  };

  const interactionEnabled = Boolean(status?.available && status.interactionAvailable);

  const handleInteractionPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactionEnabled) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const surface = interactionSurfaceRef.current;
    if (!surface) {
      return;
    }

    const startPoint = normalizePointer(surface, event.clientX, event.clientY);
    if (!startPoint) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint,
      currentPoint: startPoint,
    };
    setInteractionError(null);
  };

  const handleInteractionPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const surface = interactionSurfaceRef.current;
    if (!surface) {
      return;
    }

    const nextPoint = normalizePointer(surface, event.clientX, event.clientY);
    if (!nextPoint) {
      return;
    }

    event.preventDefault();
    gestureRef.current = {
      ...gesture,
      currentPoint: nextPoint,
    };
  };

  const finishInteractionGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const elapsedMs = Math.round(performance.now() - gesture.startedAt);
    const distancePx = gestureDistancePx(gesture, event.clientX, event.clientY);
    const nextPoint =
      normalizePointer(event.currentTarget, event.clientX, event.clientY) ?? gesture.currentPoint;

    if (distancePx <= TAP_MAX_MOVEMENT_PX && elapsedMs <= TAP_MAX_DURATION_MS) {
      void sendInput({
        type: "tap",
        x: nextPoint.x,
        y: nextPoint.y,
        frameAspectRatio,
      });
      return;
    }

    void sendInput({
      type: "swipe",
      fromX: gesture.startPoint.x,
      fromY: gesture.startPoint.y,
      toX: nextPoint.x,
      toY: nextPoint.y,
      durationMs: Math.min(MAX_SWIPE_DURATION_MS, Math.max(MIN_SWIPE_DURATION_MS, elapsedMs)),
      frameAspectRatio,
    });
  };

  const cancelInteractionGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const activeMessage =
    interactionError ??
    frameError ??
    statusError ??
    status?.interactionMessage ??
    status?.message ??
    "Checking the host Mac for a booted iPhone simulator.";
  const footerMessage = interactionEnabled
    ? isSendingInput
      ? "Forwarding touch input to the host Mac."
      : "Tap or drag on the mirrored screen to control the host simulator."
    : (interactionError ??
      frameError ??
      statusError ??
      status?.interactionMessage ??
      "Remote mirror is live. Interaction is not ready on the host.");

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-card text-foreground",
        mode === "sheet" ? "h-full" : undefined,
      )}
    >
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-card/96 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-neutral-950 text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_24px_rgba(0,0,0,0.28)]">
            <SmartphoneIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">iPhone simulator</p>
            <p className={cn("truncate text-xs", statusTone(status, frameError, interactionError))}>
              {status?.available && status.deviceName
                ? `${status.deviceName} live from the host Mac`
                : activeMessage}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="Refresh simulator mirror"
              onClick={() => {
                setFrameError(null);
                setStatusError(null);
                setInteractionError(null);
                setFrameRefreshRevision((current) => current + 1);
              }}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            {onClose ? (
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Close simulator mirror"
                onClick={onClose}
              >
                <PanelRightCloseIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="truncate">
            {lastFrameLoadedAt
              ? `Last frame ${new Date(lastFrameLoadedAt).toLocaleTimeString()}`
              : "Waiting for the first frame"}
          </span>
          <span className="truncate">
            {interactionEnabled
              ? isRemoteConnection
                ? isStreamConnected
                  ? "WebSocket bridge mirror with touch forwarding"
                  : "Reconnecting WebSocket bridge"
                : isStreamConnected
                  ? "Direct frame mirror with touch forwarding"
                  : "Refreshing direct mirror"
              : isRemoteConnection
                ? "WebSocket bridge mirror"
                : "Direct frame mirror"}
          </span>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_40%),linear-gradient(180deg,#121212_0%,#090909_100%)] px-6 py-8">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.04),transparent_35%,rgba(255,255,255,0.03)_70%,transparent)]" />
        <div className="relative w-full max-w-[22rem]">
          <div className="relative rounded-[3rem] border border-white/12 bg-[linear-gradient(180deg,#1f1f1f_0%,#0a0a0a_100%)] p-3 shadow-[0_28px_80px_rgba(0,0,0,0.48),inset_0_1px_0_rgba(255,255,255,0.08)]">
            <div className="absolute left-1/2 top-4 z-10 h-6 w-28 -translate-x-1/2 rounded-full bg-black/90 shadow-[0_1px_0_rgba(255,255,255,0.06)]" />
            <div
              className="relative overflow-hidden rounded-[2.35rem] bg-[#030303]"
              style={{ aspectRatio: String(frameAspectRatio) }}
            >
              <img
                ref={frameImageRef}
                alt="Live iPhone simulator"
                className={cn(
                  "h-full w-full object-contain",
                  hasFrame ? "opacity-100" : "pointer-events-none opacity-0",
                )}
                decoding="async"
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    setFrameAspectRatio(naturalWidth / naturalHeight);
                  }
                  setHasFrame(true);
                  setIsStreamConnected(true);
                  setLastFrameLoadedAt(Date.now());
                  flushStaleFrameObjectUrls();
                  setFrameError(null);
                }}
                onError={() => {
                  setHasFrame(false);
                  setIsStreamConnected(false);
                  setFrameError("The host Mac did not return a simulator frame.");
                }}
              />
              {hasFrame ? (
                <>
                  <div
                    ref={interactionSurfaceRef}
                    className={cn(
                      "absolute inset-0",
                      interactionEnabled ? "cursor-pointer touch-none" : "pointer-events-none",
                    )}
                    onPointerDown={handleInteractionPointerDown}
                    onPointerMove={handleInteractionPointerMove}
                    onPointerUp={finishInteractionGesture}
                    onPointerCancel={cancelInteractionGesture}
                  />
                  <div className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-1 rounded-full border border-white/12 bg-black/45 px-2.5 py-1 text-[10px] font-medium tracking-[0.14em] text-white/75 uppercase backdrop-blur-md">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        interactionEnabled ? "bg-emerald-300" : "bg-sky-300",
                      )}
                    />
                    Live {interactionEnabled ? "interactive" : "mirror"}
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] p-8">
                  <div className="max-w-[15rem] space-y-3 text-center">
                    <div className="mx-auto flex size-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/80">
                      <AlertCircleIcon className="size-5" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-white">Mirror unavailable</p>
                      <p className="text-sm leading-6 text-white/65">{activeMessage}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="pointer-events-none absolute inset-x-5 bottom-5 rounded-2xl border border-white/10 bg-black/35 px-3 py-2 text-[11px] text-white/75 backdrop-blur-md">
                <div className="flex items-start gap-2">
                  <HandIcon className="mt-0.5 size-3.5 shrink-0" />
                  <p>{footerMessage}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
