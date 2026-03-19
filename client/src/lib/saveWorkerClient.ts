import type { Annotation } from "../types";

interface PendingSave {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SaveResultMessage {
  type: "result";
  id: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

let workerInstance: Worker | null = null;
let requestCounter = 0;
const pendingSaves = new Map<string, PendingSave>();
const debugEnabled =
  typeof window !== "undefined" &&
  (window.location.search.includes("inkflowDebug=1") || window.localStorage.getItem("inkflow-debug") === "1");

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") {
    return null;
  }

  if (!workerInstance) {
    workerInstance = new Worker(new URL("../workers/saveWorker.ts", import.meta.url), { type: "module" });
    workerInstance.addEventListener("message", (event: MessageEvent<SaveResultMessage>) => {
      if (event.data?.type !== "result") {
        return;
      }

      const pendingSave = pendingSaves.get(event.data.id);
      if (!pendingSave) {
        return;
      }

      pendingSaves.delete(event.data.id);
      if (event.data.ok) {
        pendingSave.resolve();
        return;
      }

      pendingSave.reject(new Error(event.data.error ?? "Could not save annotations."));
    });

    workerInstance.addEventListener("error", (event) => {
      pendingSaves.forEach((pendingSave) => {
        pendingSave.reject(event.error instanceof Error ? event.error : new Error("Save worker failed."));
      });
      pendingSaves.clear();
      workerInstance = null;
    });
  }

  return workerInstance;
}

export async function saveAnnotationsInWorker(
  pageId: string,
  annotations: Annotation[],
  annotationText: string,
  mode: "replace" | "append" = "replace"
): Promise<void> {
  const worker = getWorker();
  if (!worker) {
    const response = await fetch(`/api/pages/${pageId}/annotations${mode === "append" ? "/append" : ""}`, {
      method: mode === "append" ? "POST" : "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
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
    return;
  }

  const requestId = `save-${requestCounter.toString(36)}`;
  requestCounter += 1;

  return new Promise<void>((resolve, reject) => {
    pendingSaves.set(requestId, { resolve, reject });
    worker.postMessage({
      type: "save",
      id: requestId,
      mode,
      pageId,
      annotations,
      annotationText,
      debug: debugEnabled
    });
  });
}
