import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PanelRightCloseIcon,
  RotateCwIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react";

import { isElectron } from "../env";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

const DEFAULT_BROWSER_URL = "https://example.com";

export type BrowserPaneMode = "sheet" | "sidebar";

function looksLikeLocalHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.0.0.1:") ||
    normalized.startsWith("0.0.0.0:") ||
    normalized.startsWith("[::1]:")
  );
}

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_BROWSER_URL;
  }

  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|about:|blob:|data:|file:|javascript:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }

  return `${looksLikeLocalHost(trimmed) ? "http" : "https"}://${trimmed}`;
}

function syncNavigationState(webview: ElectronWebviewElement | null) {
  if (!webview) {
    return {
      canGoBack: false,
      canGoForward: false,
      title: "Browser",
      url: DEFAULT_BROWSER_URL,
    };
  }

  return {
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward(),
    title: webview.getTitle() || "Browser",
    url: webview.getURL() || webview.src || DEFAULT_BROWSER_URL,
  };
}

function readPendingUrl(webview: ElectronWebviewElement | null) {
  return webview?.src || DEFAULT_BROWSER_URL;
}

export default function BrowserPane(props: { mode: BrowserPaneMode; onClose?: () => void }) {
  const { mode, onClose } = props;
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const [locationInput, setLocationInput] = useState(DEFAULT_BROWSER_URL);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_BROWSER_URL);
  const [pageTitle, setPageTitle] = useState("Browser");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDomReady, setIsDomReady] = useState(false);

  const refreshNavigationState = useCallback(() => {
    if (!isDomReady) {
      const pendingUrl = readPendingUrl(webviewRef.current);
      setCanGoBack(false);
      setCanGoForward(false);
      setPageTitle("Browser");
      setCurrentUrl(pendingUrl);
      setLocationInput(pendingUrl);
      return;
    }

    const nextState = syncNavigationState(webviewRef.current);
    setCanGoBack(nextState.canGoBack);
    setCanGoForward(nextState.canGoForward);
    setPageTitle(nextState.title);
    setCurrentUrl(nextState.url);
    setLocationInput(nextState.url);
  }, [isDomReady]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleDomReady = () => {
      setIsDomReady(true);
      refreshNavigationState();
    };
    const handleLoadStart = () => {
      setIsLoading(true);
      refreshNavigationState();
    };
    const handleLoadStop = () => {
      setIsLoading(false);
      refreshNavigationState();
    };
    const handleNavigate = () => {
      refreshNavigationState();
    };
    const handlePageTitleUpdated = () => {
      refreshNavigationState();
    };

    setIsDomReady(false);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleLoadStop);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);

    refreshNavigationState();

    return () => {
      setIsDomReady(false);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleLoadStop);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
    };
  }, [refreshNavigationState]);

  const navigateTo = useCallback(
    (rawValue: string) => {
      const normalizedUrl = normalizeBrowserUrl(rawValue);
      setCurrentUrl(normalizedUrl);
      setLocationInput(normalizedUrl);
      if (isDomReady) {
        webviewRef.current?.loadURL(normalizedUrl);
      }
    },
    [isDomReady],
  );

  if (!isElectron) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col bg-card text-foreground",
          mode === "sheet" ? "h-full" : undefined,
        )}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="flex size-8 items-center justify-center rounded-lg border border-input bg-background">
            <GlobeIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">In-app browser</p>
            <p className="text-xs text-muted-foreground">Available in the desktop app.</p>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-8 text-center">
          <div className="max-w-sm space-y-2">
            <p className="text-sm font-medium">Embedded browsing needs the Electron runtime.</p>
            <p className="text-sm text-muted-foreground">
              The desktop app can host a Chromium-backed browser pane. In web mode, use external
              links instead.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-card text-foreground",
        mode === "sheet" ? "h-full" : undefined,
      )}
    >
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-card/96 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-input bg-background">
              <GlobeIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{pageTitle}</p>
              <p className="truncate text-xs text-muted-foreground">{currentUrl}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onClose ? (
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Close in-app browser"
                onClick={onClose}
              >
                <PanelRightCloseIcon className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon-xs"
              disabled={!isDomReady || !canGoBack}
              aria-label="Go back"
              onClick={() => {
                if (!isDomReady) return;
                webviewRef.current?.goBack();
              }}
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              disabled={!isDomReady || !canGoForward}
              aria-label="Go forward"
              onClick={() => {
                if (!isDomReady) return;
                webviewRef.current?.goForward();
              }}
            >
              <ArrowRightIcon className="size-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              disabled={!isDomReady}
              aria-label={isLoading ? "Stop loading" : "Reload page"}
              onClick={() => {
                if (!isDomReady) return;
                if (isLoading) {
                  webviewRef.current?.stop();
                  return;
                }
                webviewRef.current?.reload();
              }}
            >
              {isLoading ? (
                <SquareIcon className="size-3.5 fill-current" />
              ) : (
                <RotateCwIcon className="size-3.5" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="Open in external browser"
              onClick={() => {
                void ensureNativeApi().shell.openExternal(currentUrl);
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        <form
          className="relative flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            navigateTo(locationInput);
          }}
        >
          <div className="pointer-events-none absolute ms-3 flex h-8 items-center text-muted-foreground">
            {isLoading ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <SearchIcon className="size-3.5" />
            )}
          </div>
          <Input
            nativeInput
            aria-label="Browser address"
            className="flex-1 ps-9"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={locationInput}
            onChange={(event) => {
              setLocationInput(event.currentTarget.value);
            }}
          />
          <Button type="submit" size="xs">
            Go
          </Button>
        </form>
      </div>

      <div className="min-h-0 flex-1 bg-background">
        <webview
          ref={(value) => {
            webviewRef.current = value as ElectronWebviewElement | null;
          }}
          className="h-full w-full"
          partition="persist:t3code-browser"
          src={currentUrl}
        />
      </div>
    </div>
  );
}
