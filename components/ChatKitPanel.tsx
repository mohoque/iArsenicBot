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

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

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

type TextPart = { type: "text"; text: string };
type Role = "user" | "assistant" | "system" | "tool";
type Message = { role: Role; content: string | TextPart[] };
type Payload = { input?: string | Message[]; messages?: Message[] };

/* -------------------------------------------------------------------------- */

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

  // Buffer for a single user→assistant turn
  const turnRef = useRef<{
    id: string;
    userText?: string;
    userTs?: string;
  } | null>(null);

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

  /* ------------------------------------------------------------------------ */
  /* Helpers for interceptors and observer                                    */
  /* ------------------------------------------------------------------------ */

  const extractUserTextFromJSON = (raw: string): string => {
    try {
      const p = JSON.parse(raw) as Payload;
      if (typeof p?.input === "string") return p.input;

      if (Array.isArray(p?.input)) {
        const u = p.input.find((m) => m && m.role === "user");
        if (u) {
          if (typeof u.content === "string") return u.content;
          const t =
            Array.isArray(u.content) &&
            u.content.find((c) => c && (c as TextPart).type === "text");
          if (t && typeof (t as TextPart).text === "string") return (t as TextPart).text;
        }
      }

      if (Array.isArray(p?.messages)) {
        const u = p.messages.find((m) => m && m.role === "user");
        if (u) {
          if (typeof u.content === "string") return u.content;
          const t =
            Array.isArray(u.content) &&
            u.content.find((c) => c && (c as TextPart).type === "text");
          if (t && typeof (t as TextPart).text === "string") return (t as TextPart).text;
        }
      }
    } catch {
      // ignore
    }
    return "";
  };

  const bodyToText = async (body: unknown): Promise<string> => {
    try {
      if (typeof body === "string") return body;
      if (body instanceof Blob) return body.text();
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body.buffer as ArrayBuffer);
    } catch {
      // ignore
    }
    return "";
  };

  const shouldSkipUrl = (url: string): boolean => {
    return (
      url.includes("/api/create-session") ||
      url.includes("/api/log-event") ||
      url.includes("/track?") ||
      url.includes("/_next/")
    );
  };

  const sendTurnIfReady = (assistantText: string, meta: Record<string, string>) => {
    if (!assistantText || assistantText.trim().length === 0) return;
    const current = turnRef.current;
    const assistantTs = new Date().toISOString();

    const payload =
      current
        ? {
            type: "turn",
            id: current.id,
            user_text: current.userText ?? "",
            user_ts: current.userTs ?? "",
            assistant_text: assistantText,
            assistant_ts: assistantTs,
            meta: { ...meta, path: location.pathname },
          }
        : {
            type: "turn",
            id: String(Date.now()),
            user_text: "",
            user_ts: "",
            assistant_text: assistantText,
            assistant_ts: assistantTs,
            meta: { ...meta, path: location.pathname },
          };

    void fetch("/api/log-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Clear buffer for next turn
    turnRef.current = null;
  };

  /* ------------------------------------------------------------------------ */
  /* Interceptor: fetch (reads user BEFORE send; logs assistant AFTER)        */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!isBrowser) return;

    const originalFetch = window.fetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const toUrl = (v: RequestInfo | URL): string =>
        typeof v === "string"
          ? v
          : v instanceof URL
          ? v.toString()
          : v instanceof Request
          ? v.url
          : String(v);

      const url = toUrl(input);
      const method =
        (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

      // Read request body before sending
      let requestBody = "";
      if (!shouldSkipUrl(url) && method === "POST") {
        try {
          if (input instanceof Request) {
            const clone = input.clone();
            requestBody = await clone.text();
          } else if (init?.body !== undefined) {
            requestBody = await bodyToText(init.body);
          }
        } catch {
          // ignore
        }

        const userText = requestBody ? extractUserTextFromJSON(requestBody) : "";
        if (userText.trim().length > 0) {
          turnRef.current = {
            id: String(Date.now()),
            userText,
            userTs: new Date().toISOString(),
          };
        }
      }

      // Send the real request
      const resp = await originalFetch(input as RequestInfo, init as RequestInit);

      // Parse assistant afterwards
      try {
        if (!shouldSkipUrl(url) && method === "POST") {
          const ct = resp.headers.get("content-type") ?? "";
          const looksStream = ct.includes("text/event-stream");

          if (looksStream) {
            const cloned = resp.clone();
            const reader = cloned.body?.getReader();
            if (reader) {
              const decoder = new TextDecoder();
              let buffer = "";
              let full = "";

              const pullFromLine = (line: string): string => {
                const i = line.indexOf("{");
                if (i < 0) return "";
                try {
                  const obj = JSON.parse(line.slice(i)) as Record<string, unknown>;
                  const ot = obj["output_text"];
                  if (typeof ot === "string") return ot;
                  if (Array.isArray(ot) && ot.every((v) => typeof v === "string")) {
                    return (ot as string[]).join("");
                  }
                  const delta = (obj as { delta?: unknown }).delta;
                  if (
                    delta &&
                    typeof delta === "object" &&
                    typeof (delta as { text?: unknown }).text === "string"
                  ) {
                    return String((delta as { text: string }).text);
                  }
                  if (typeof (obj as { text?: unknown }).text === "string") {
                    return String((obj as { text: string }).text);
                  }
                } catch {
                  // ignore
                }
                return "";
              };

              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                buffer += decoder.decode(r.value, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  const t = line.trim();
                  if (!t.startsWith("data:")) continue;
                  const piece = pullFromLine(t);
                  if (piece) full += piece;
                }
              }
              if (buffer.startsWith("data:")) {
                const tail = pullFromLine(buffer);
                if (tail) full += tail;
              }

              sendTurnIfReady(full, {
                endpoint: url.replace(/^https?:\/\//, ""),
                method: "STREAM:SSE",
              });
            }
          } else {
            const clone = resp.clone();
            const raw = await clone.text();
            let assistant = "";
            try {
              const obj = JSON.parse(raw) as Record<string, unknown>;
              const ot = obj["output_text"];
              if (typeof ot === "string") assistant = ot;
              else if (Array.isArray(ot) && ot.every((v) => typeof v === "string")) {
                assistant = (ot as string[]).join("");
              }
            } catch {
              if (typeof raw === "string") assistant = raw;
            }

            sendTurnIfReady(assistant, {
              endpoint: url.replace(/^https?:\/\//, ""),
              method: "POST:nonstream",
            });
          }
        }
      } catch {
        // ignore
      }

      return resp;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []); // once

  /* ------------------------------------------------------------------------ */
  /* DOM Observer: event-driven + robust scanning (typed)                     */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!isBrowser) return;

    type WithShadow = HTMLElement & { shadowRoot?: ShadowRoot };

    // Register and remember cleanups
    const cleanupFns: Array<() => void> = [];
    const addCleanup = (fn: () => void) => cleanupFns.push(fn);

      function attach(hostEl: HTMLElement) {
        type WithShadow = HTMLElement & { shadowRoot?: ShadowRoot };
        const root: ShadowRoot | null = (hostEl as WithShadow).shadowRoot ?? null;
        if (!root) {
          console.warn("[observer] shadowRoot not found on <openai-chatkit>");
          return;
        }

        console.log("[observer] attached to shadowRoot");

        // De-dupe keys we have already sent
        const seen = new Set<string>();

        // ----- helpers MUST come after 'root' is declared -----
        const qs = <T extends Element>(sel: string, scope?: ParentNode): T | null =>
          (((scope ?? root).querySelector(sel)) as T | null);

        const getText = (
          el: HTMLElement | HTMLTextAreaElement | HTMLInputElement | null
        ): string => {
          if (!el) return "";
          if (el instanceof HTMLTextAreaElement) return el.value ?? "";
          if (el instanceof HTMLInputElement) return el.value ?? "";
          return el.innerText ?? "";
        };

        const extractVisible = (node: Element): string => {
          const txt = (node as HTMLElement).innerText || node.textContent || "";
          return txt.trim();
        };

        function inferRole(el: Element | null): "user" | "assistant" | "" {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const dr = n.getAttribute?.("data-role") || n.getAttribute?.("data-message-role") || "";
            if (dr === "user" || dr === "assistant") return dr as "user" | "assistant";

            const cls = (n as HTMLElement).className || "";
            if (/\bassistant\b/i.test(cls)) return "assistant";
            if (/\buser\b/i.test(cls)) return "user";

            const aria = n.getAttribute?.("aria-label") || n.getAttribute?.("role") || "";
            if (/assistant/i.test(aria)) return "assistant";
            if (/user|you/i.test(aria)) return "user";
          }
          return "";
        }

        // Locate transcript region
        const transcript: ParentNode =
          (qs<HTMLElement>('[role="log"]') as ParentNode) ??
          (qs<HTMLElement>('[aria-live]') as ParentNode) ??
          root;

        // composer refs
        let composerInput: HTMLTextAreaElement | HTMLInputElement | HTMLElement | null = null;
        let composerSend: HTMLElement | null = null;

        function hookComposer() {
          const prevInput = composerInput;
          const prevSend = composerSend;

          composerInput =
            qs<HTMLTextAreaElement>("textarea") ||
            qs<HTMLElement>('[contenteditable="true"]') ||
            qs<HTMLInputElement>('input[type="text"]');

          if (!root) {
            composerSend = null;
            return;
          }

          composerSend =
            Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"))
              .find((b) => {
                const label =
                  b.getAttribute("aria-label") ||
                  b.getAttribute("title") ||
                  (b as HTMLButtonElement).innerText ||
                  "";
                return /send|submit/i.test(label);
              }) || null;

          if (prevInput === composerInput && prevSend === composerSend) return;

          // Key handler: type as Event, cast inside
          if (composerInput) {
            const onKey = (ev: Event) => {
              const e = ev as KeyboardEvent;
              if (e.key === "Enter" && !e.shiftKey) {
                const user = getText(composerInput).trim();
                if (user) {
                  console.log("[observer] user (enter):", user.slice(0, 120));
                  turnRef.current = {
                    id: String(Date.now()),
                    userText: user,
                    userTs: new Date().toISOString(),
                  };
                }
              }
            };
            composerInput.addEventListener("keydown", onKey);
            cleanupFns.push(() => composerInput?.removeEventListener("keydown", onKey));
          }

          if (composerSend) {
            const onClick = () => {
              const user = getText(composerInput).trim();
              if (user) {
                console.log("[observer] user (click):", user.slice(0, 120));
                turnRef.current = {
                  id: String(Date.now()),
                  userText: user,
                  userTs: new Date().toISOString(),
                };
              }
            };
            composerSend.addEventListener("click", onClick);
            cleanupFns.push(() => composerSend?.removeEventListener("click", onClick));
          }
        }

      if (!root) {
        return;
      }

      // ---- transcript scanning ---------------------------------------------
      const transcriptEl =
        root.querySelector<HTMLElement>('[role="log"]') ||
        root.querySelector<HTMLElement>('[aria-live]') ||
        ((root as unknown) as HTMLElement);

      let lastAssistant = "";

      function scan(container: ParentNode) {
        const selector = [
          "[data-role]", "[data-message-role]",
          '[role="listitem"]', "article", "li",
          '[class*="message"]', '[class*="bubble"]', '[class*="content"]',
          "p"
        ].join(",");

        const nodes = Array.from((container as Element).querySelectorAll<HTMLElement>(selector));
        for (const el of nodes) {
          const text = extractVisible(el);
          if (!text) continue;

          const role = inferRole(el);
          if (!role) continue;

          const key = `${role}:${text.slice(0, 240)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (role === "user") {
            console.log("[observer] user:", text.slice(0, 120));
            turnRef.current = {
              id: String(Date.now()),
              userText: text,
              userTs: new Date().toISOString(),
            };
          } else {
            if (text === lastAssistant) continue;
            lastAssistant = text;
            console.log("[observer] assistant:", text.slice(0, 120));

            const assistantTs = new Date().toISOString();
            const payload = {
              type: "turn",
              id: turnRef.current?.id ?? String(Date.now()),
              user_text: turnRef.current?.userText ?? "",
              user_ts: turnRef.current?.userTs ?? "",
              assistant_text: text,
              assistant_ts: assistantTs,
              meta: { path: location.pathname, source: "dom" },
            };

            void fetch("/api/log-event", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });

            turnRef.current = null;
          }
        }
      }

      // Initial hooks and sweep
      hookComposer();
      scan(transcriptEl);

      // Observe transcript and composer for changes
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === "childList") {
            if (m.addedNodes && m.addedNodes.length > 0) {
              m.addedNodes.forEach((n) => {
                if (n instanceof HTMLElement || n instanceof DocumentFragment) {
                  scan(n);
                }
              });
            }
            if (m.target instanceof HTMLElement) {
              scan(m.target);
            }
          }
          if (m.type === "attributes" && m.target instanceof HTMLElement) {
            scan(m.target);
          }
        }
      });
      mo.observe(transcriptEl, { childList: true, subtree: true, attributes: true });
      addCleanup(() => mo.disconnect());

      // As the UI can re-render, periodically try to re-hook composer if missing
      const pollId = window.setInterval(() => {
        if (!composerInput || !composerSend) hookComposer();
      }, 1500);
      addCleanup(() => window.clearInterval(pollId));
    }

    // Find the custom element and attach; retry if needed
    const host = document.querySelector("openai-chatkit") as HTMLElement | null;
    if (host) {
      attach(host);
    } else {
      console.log("[observer] host not ready, retrying…");
      const id = window.setTimeout(() => {
        const retry = document.querySelector("openai-chatkit") as HTMLElement | null;
        if (retry) attach(retry);
        else console.warn("[observer] openai-chatkit not found");
      }, 700);
      cleanupFns.push(() => window.clearTimeout(id));
    }

    return () => {
      cleanupFns.forEach((fn) => fn());
    };
  }, []); // once

  /* ------------------------------------------------------------------------ */

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
          blockingError || !isInitializingSession ? null : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Error detail helper                                                        */
/* -------------------------------------------------------------------------- */

function extractErrorDetail(
  payload: Record<string, unknown> | undefined,
  fallback: string
): string {
  if (!payload) return fallback;

  const error = payload.error;
  if (typeof error === "string") return error;

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  const details = payload.details;
  if (typeof details === "string") return details;

  if (details && typeof details === "object" && "error" in details) {
    const nestedError = (details as { error?: unknown }).error;
    if (typeof nestedError === "string") return nestedError;
    if (
      nestedError &&
      typeof nestedError === "object" &&
      "message" in nestedError &&
      typeof (nestedError as { message?: unknown }).message === "string"
    ) {
      return (nestedError as { message: string }).message;
    }
  }

  if (typeof payload.message === "string") return payload.message;

  return fallback;
}