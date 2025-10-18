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

    // ---------- ADDED: robust logging interceptor (typed) ----------
  useEffect(() => {
    if (typeof window === "undefined") return;

    const originalFetch = window.fetch;

    // Minimal shapes we care about
    type TextPart = { type: "text"; text: string };
    type Role = "user" | "assistant" | "system" | "tool";
    type Message = { role: Role; content: string | TextPart[] };
    type ResponsesShape = { input?: string | Message[]; messages?: Message[] };

    function isTextPartArray(v: unknown): v is TextPart[] {
      return Array.isArray(v) &&
        v.every(p => typeof p === "object" && p !== null &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string");
    }

    function isMessage(obj: unknown): obj is Message {
      if (typeof obj !== "object" || obj === null) return false;
      const o = obj as { role?: unknown; content?: unknown };
      const roleOk = typeof o.role === "string";
      const contentOk = typeof o.content === "string" || isTextPartArray(o.content as unknown);
      return roleOk && contentOk;
    }

    function findUserTextFromMessages(messages?: Message[]): string {
      if (!messages) return "";
      const u = messages.find(m => m.role === "user");
      if (!u) return "";
      if (typeof u.content === "string") return u.content;
      const t = u.content.find(part => part.type === "text");
      return t ? t.text : "";
    }

    function extractUserText(payload: unknown): string {
      const p = payload as ResponsesShape | undefined;
      if (!p) return "";

      if (typeof p.input === "string") return p.input;
      if (Array.isArray(p.input) && p.input.every(isMessage)) {
        return findUserTextFromMessages(p.input);
      }
      if (Array.isArray(p.messages) && p.messages.every(isMessage)) {
        return findUserTextFromMessages(p.messages);
      }
      return "";
    }

    async function readBodySafely(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
      // If a Request was passed, clone and read its body
      if (input instanceof Request) {
        try {
          const clone = input.clone();
          const text = await clone.text();
          return text ? JSON.parse(text) : null;
        } catch { return null; }
      }
      // Otherwise check init.body
      if (init?.body) {
        try {
          if (typeof init.body === "string") return JSON.parse(init.body);
          if (init.body instanceof Blob) {
            const t = await (init.body as Blob).text();
            return JSON.parse(t);
          }
          // If ReadableStream, skip to avoid consuming it
        } catch { return null; }
      }
      return null;
    }

    // Helpful marker that the interceptor mounted
    // eslint-disable-next-line no-console
    console.log("[intercept] mounted");

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.toString()
            : input instanceof Request
            ? input.url
            : String(input);

        const method =
          (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

        // Skip our own endpoints
        if (urlStr.includes("/api/log-event") || urlStr.includes("/api/create-session")) {
          return originalFetch(input as RequestInfo, init as RequestInit);
        }

        // Only inspect POSTs with JSON content-type
        const ctype =
          (init?.headers && typeof init.headers === "object"
            ? (init.headers as Record<string, string>)["content-type"]
            : undefined) ||
          (input instanceof Request ? input.headers.get("content-type") ?? undefined : undefined);

        const looksJson = ctype ? /application\/json/i.test(ctype) : true;

        if (method === "POST" && looksJson) {
          const json = await readBodySafely(input, init);
          const userText = extractUserText(json);

          if (userText) {
            // eslint-disable-next-line no-console
            console.log("[intercept] POST →", urlStr, "| userText:", userText.slice(0, 120));

            // Fire-and-forget log to your API
            void fetch("/api/log-event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                role: "user",
                text: userText,
                meta: {
                  path: location.pathname,
                  endpoint: urlStr.replace(/^https?:\/\//, ""),
                },
              }),
            });
          }
        }
      } catch {
        // Never block the original request
      }

      return originalFetch(input as RequestInfo, init as RequestInit);
    };

    return () => {
      window.fetch = originalFetch;
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
