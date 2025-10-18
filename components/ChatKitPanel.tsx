"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
  getThemeConfig,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = {
  type: "save";
  factId: string;
  factText: string;
};

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const processedFacts = useRef(new Set<string>());
  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const isMountedRef = useRef(true);
  const [scriptStatus, setScriptStatus] = useState<
    "pending" | "ready" | "error"
  >(() =>
    isBrowser && window.customElements?.get("openai-chatkit")
      ? "ready"
      : "pending"
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isBrowser) {
      return;
    }

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) {
        return;
      }
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js for some reason", event);
      if (!isMountedRef.current) {
        return;
      }
      setScriptStatus("error");
      const detail = (event as CustomEvent<unknown>)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener(
      "chatkit-script-error",
      handleError as EventListener
    );

    if (window.customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!window.customElements?.get("openai-chatkit")) {
          handleError(
            new CustomEvent("chatkit-script-error", {
              detail:
                "ChatKit web component is unavailable. Verify that the script URL is reachable.",
            })
          );
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener(
        "chatkit-script-error",
        handleError as EventListener
      );
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [scriptStatus, setErrorState]);

  const isWorkflowConfigured = Boolean(
    WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace")
  );

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    if (isBrowser) {
      setScriptStatus(
        window.customElements?.get("openai-chatkit") ? "ready" : "pending"
      );
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret invoked", {
          currentSecretPresent: Boolean(currentSecret),
          workflowId: WORKFLOW_ID,
          endpoint: CREATE_SESSION_ENDPOINT,
        });
      }

      if (!isWorkflowConfigured) {
        const detail =
          "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) {
          setIsInitializingSession(true);
        }
        setErrorState({ session: null, integration: null, retryable: false });
      }

      try {
        const response = await fetch(CREATE_SESSION_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflow: { id: WORKFLOW_ID },
            chatkit_configuration: {
              file_upload: { enabled: true },
            },
          }),
        });

        const raw = await response.text();

        if (isDev) {
          console.info("[ChatKitPanel] createSession response", {
            status: response.status,
            ok: response.ok,
            bodyPreview: raw.slice(0, 1600),
          });
        }

        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch (parseError) {
            console.error("Failed to parse create-session response", parseError);
          }
        }

        if (!response.ok) {
          const detail = extractErrorDetail(data, response.statusText);
          console.error("Create session request failed", {
            status: response.status,
            body: data,
          });
          throw new Error(detail);
        }

        const clientSecret = data?.client_secret as string | undefined;
        if (!clientSecret) {
          throw new Error("Missing client secret in response");
        }

        if (isMountedRef.current) {
          setErrorState({ session: null, integration: null });
        }

        return clientSecret;
      } catch (error) {
        console.error("Failed to create ChatKit session", error);
        const detail =
          error instanceof Error
            ? error.message
            : "Unable to start ChatKit session.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
        }
        throw error instanceof Error ? error : new Error(detail);
      } finally {
        if (isMountedRef.current && !currentSecret) {
          setIsInitializingSession(false);
        }
      }
    },
    [isWorkflowConfigured, setErrorState]
  );

  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: {
      colorScheme: theme,
      ...getThemeConfig(theme),
    },
    startScreen: {
      greeting: GREETING,
      prompts: STARTER_PROMPTS,
    },
    composer: {
      placeholder: PLACEHOLDER_INPUT,
      attachments: { enabled: true },
    },
    threadItemActions: { feedback: false },
    onClientTool: async (invocation: {
      name: string;
      params: Record<string, unknown>;
    }) => {
      if (invocation.name === "switch_theme") {
        const requested = invocation.params.theme;
        if (requested === "light" || requested === "dark") {
          if (isDev) console.debug("[ChatKitPanel] switch_theme", requested);
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = String(invocation.params.fact_id ?? "");
        const text = String(invocation.params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) {
          return { success: true };
        }
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }

      return { success: false };
    },
    onResponseEnd: () => {
      onResponseEnd();
    },
    onResponseStart: () => {
      setErrorState({ integration: null, retryable: false });
    },
    onThreadChange: () => {
      processedFacts.current.clear();
    },
    onError: ({ error }: { error: unknown }) => {
      console.error("ChatKit error", error);
    },
  });

    // ---------- ADDED: universal logging interceptor (fetch + beacon + XHR + WS, typed) ----------
  useEffect(() => {
    if (typeof window === "undefined") return;

    const originalFetch = window.fetch;
    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    const originalXhrSend = XMLHttpRequest.prototype.send;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const OriginalWS = window.WebSocket;

    type TextPart = { type: "text"; text: string };
    type Role = "user" | "assistant" | "system" | "tool";
    type Message = { role: Role; content: string | TextPart[] };
    type Payload = { input?: string | Message[]; messages?: Message[] };

    function isRecord(v: unknown): v is Record<string, unknown> {
      return typeof v === "object" && v !== null;
    }
    function isTextPartArray(v: unknown): v is TextPart[] {
      return Array.isArray(v) &&
        v.every(p => isRecord(p) && p["type"] === "text" && typeof p["text"] === "string");
    }
    function isMessage(v: unknown): v is Message {
      return isRecord(v) &&
        typeof v["role"] === "string" &&
        (typeof v["content"] === "string" || isTextPartArray(v["content"]));
    }
    function firstUserText(messages?: Message[]): string {
      if (!messages) return "";
      const u = messages.find(m => m.role === "user");
      if (!u) return "";
      if (typeof u.content === "string") return u.content;
      const t = u.content.find(p => p.type === "text");
      return t ? t.text : "";
    }
    function extractUserText(raw: unknown): string {
      const p = raw as Payload | null;
      if (!p) return "";
      if (typeof p.input === "string") return p.input;
      if (Array.isArray(p.input) && p.input.every(isMessage)) return firstUserText(p.input);
      if (Array.isArray(p.messages) && p.messages.every(isMessage)) return firstUserText(p.messages);
      return "";
    }

    async function bodyToText(body: unknown): Promise<string> {
      try {
        if (typeof body === "string") return body;
        if (body instanceof Blob) return body.text();
        if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
        if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer as ArrayBuffer);
      } catch {}
      return "";
    }

    console.log("[intercept] mounted");

    // ---- fetch ----
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.toString()
            : input instanceof Request
            ? input.url
            : String(input);

        const method =
          (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

        if (!url.includes("/api/log-event") && method === "POST") {
          let text = "";
          if (input instanceof Request) {
            const clone = input.clone();
            text = await clone.text();
          } else if (init?.body !== undefined) {
            text = await bodyToText(init.body);
          }

          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          const userText = extractUserText(parsed);

          void fetch("/api/log-event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              role: "user",
              text: userText || "",
              meta: {
                path: location.pathname,
                endpoint: url.replace(/^https?:\/\//, ""),
                method,
                bodySample: text.slice(0, 300)
              }
            })
          });

          console.log("[intercept] POST(fetch) ->", url, "| userText:", (userText || "").slice(0, 120));
        }
      } catch {}
      return originalFetch(input as RequestInfo, init as RequestInit);
    };

    // ---- sendBeacon ----
    if (originalBeacon) {
      navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
        try {
          const href = typeof url === "string" ? url : url.toString();
          if (!href.includes("/api/log-event")) {
            (async () => {
              const text = await bodyToText(data ?? "");
              let parsed: unknown = null;
              try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
              const userText = extractUserText(parsed);

              void fetch("/api/log-event", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  role: "user",
                  text: userText || "",
                  meta: {
                    path: location.pathname,
                    endpoint: href.replace(/^https?:\/\//, ""),
                    method: "BEACON",
                    bodySample: text.slice(0, 300)
                  }
                })
              });

              console.log("[intercept] POST(beacon) ->", href, "| userText:", (userText || "").slice(0, 120));
            })();
          }
        } catch {}
        return originalBeacon(url, data);
      };
    }

    // ---- XHR ----
    XMLHttpRequest.prototype.open = function open(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ): void {
      const self = this as XMLHttpRequest & { __url?: string; __method?: string };
      self.__url = typeof url === "string" ? url : url.toString();
      self.__method = (method || "GET").toUpperCase();
      return originalXhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    XMLHttpRequest.prototype.send = function send(
      body?: Document | XMLHttpRequestBodyInit | null
    ): void {
      try {
        const self = this as XMLHttpRequest & { __url?: string; __method?: string };
        const url = self.__url ?? this.responseURL;
        const method = self.__method ?? "POST";
        if (method === "POST" && url && !url.includes("/api/log-event")) {
          (async () => {
            const text = await bodyToText(body ?? "");
            let parsed: unknown = null;
            try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
            const userText = extractUserText(parsed);

            void fetch("/api/log-event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                role: "user",
                text: userText || "",
                meta: {
                  path: location.pathname,
                  endpoint: url.replace(/^https?:\/\//, ""),
                  method: "XHR",
                  bodySample: text.slice(0, 300)
                }
              })
            });

            console.log("[intercept] POST(xhr) ->", url, "| userText:", (userText || "").slice(0, 120));
          })();
        }
      } catch {}
      return originalXhrSend.call(this, body as Document | XMLHttpRequestBodyInit | null);
    };

    // ---- WebSocket ----
    class LoggedWS extends OriginalWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const u = typeof url === "string" ? url : url.toString();
        console.log("[intercept] WebSocket open ->", u);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        try {
          const sample =
            typeof data === "string"
              ? data.slice(0, 300)
              : data instanceof Blob
              ? "(blob)"
              : ArrayBuffer.isView(data)
              ? "(arraybuffer view)"
              : "(arraybuffer)";
          void fetch("/api/log-event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              role: "user",
              text: "",
              meta: {
                path: location.pathname,
                endpoint: "WebSocket",
                method: "WS",
                bodySample: sample
              }
            })
          });
          console.log("[intercept] POST(ws) -> sample:", sample);
        } catch {}
        return super.send(data);
      }
    }
    window.WebSocket = LoggedWS as unknown as typeof WebSocket;

    return () => {
      window.fetch = originalFetch;
      if (originalBeacon) navigator.sendBeacon = originalBeacon;
      XMLHttpRequest.prototype.send = originalXhrSend;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      window.WebSocket = OriginalWS as unknown as typeof WebSocket;
    };
  }, []);
  // ---------- END ADDED ----------



  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render state", {
      isInitializingSession,
      hasControl: Boolean(chatkit.control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
    });
  }

  return (
    <div className="relative pb-8 flex h-[90vh] w-full rounded-2xl flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        control={chatkit.control}
        className={
          blockingError || isInitializingSession
            ? "pointer-events-none opacity-0"
            : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={
          blockingError || !isInitializingSession
            ? null
            : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}

function extractErrorDetail(
  payload: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!payload) return fallback;

  const error = payload.error;
  if (typeof error === "string") return error;

  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  const details = payload.details;
  if (typeof details === "string") return details;

  if (details && typeof details === "object" && "error" in details) {
    const nestedError = (details as { error?: unknown }).error;
    if (typeof nestedError === "string") return nestedError;
    if (nestedError && typeof nestedError === "object" && "message" in nestedError && typeof (nestedError as { message?: unknown }).message === "string") {
      return (nestedError as { message: string }).message;
    }
  }

  if (typeof payload.message === "string") return payload.message;

  return fallback;
}
