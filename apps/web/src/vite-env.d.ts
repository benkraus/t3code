/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@t3tools/contracts";
import type * as React from "react";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface ElectronWebviewElement extends HTMLElement {
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    getTitle: () => string;
    getURL: () => string;
    goBack: () => void;
    goForward: () => void;
    loadURL: (url: string) => void;
    reload: () => void;
    stop: () => void;
    src: string;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<ElectronWebviewElement>,
        ElectronWebviewElement
      > & {
        allowpopups?: string;
        partition?: string;
        src?: string;
      };
    }
  }

  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
