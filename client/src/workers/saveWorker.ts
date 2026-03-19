import type { Annotation } from "../types";

interface SaveRequestMessage {
  type: "save";
  id: string;
  mode: "replace" | "append";
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  syncClientId: string;
  debug: boolean;
}

interface SaveSuccessMessage {
  type: "result";
  id: string;
  ok: true;
  durationMs: number;
}

interface SaveFailureMessage {
  type: "result";
  id: string;
  ok: false;
  error: string;
  durationMs: number;
}

type SaveWorkerMessage = SaveSuccessMessage | SaveFailureMessage;

function postResult(message: SaveWorkerMessage): void {
  self.postMessage(message);
}

self.addEventListener("message", async (event: MessageEvent<SaveRequestMessage>) => {
  if (event.data?.type !== "save") {
    return;
  }

  const startedAt = performance.now();
  const { id, mode, pageId, annotations, annotationText, syncClientId, debug } = event.data;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (syncClientId) {
      headers["X-Sync-Client-Id"] = syncClientId;
    }
    const response = await fetch(`/api/pages/${pageId}/annotations${mode === "append" ? "/append" : ""}`, {
      method: mode === "append" ? "POST" : "PUT",
      credentials: "include",
      headers,
      body: JSON.stringify({
        annotations,
        annotationText
      })
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json") ? await response.json() : await response.text();
      throw new Error(
        typeof payload === "object" && payload && "message" in payload ? String(payload.message) : "Request failed."
      );
    }

    const durationMs = performance.now() - startedAt;
    if (debug) {
      console.info("[Inkflow] Worker save complete", { pageId, mode, durationMs, annotationCount: annotations.length });
    }
    postResult({
      type: "result",
      id,
      ok: true,
      durationMs
    });
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    if (debug) {
      console.error("[Inkflow] Worker save failed", {
        pageId,
        mode,
        durationMs,
        error
      });
    }
    postResult({
      type: "result",
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Could not save annotations.",
      durationMs
    });
  }
});
