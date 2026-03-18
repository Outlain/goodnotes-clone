import type { Annotation, DocumentBundle, LibraryPayload, PageTemplate, SessionStatus } from "../types";

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers
    }
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new ApiError(
      typeof payload === "object" && payload && "message" in payload ? String(payload.message) : "Request failed.",
      response.status
    );
  }

  return payload as T;
}

export const api = {
  sessionStatus: () => request<SessionStatus>("/api/session/status"),
  login: (password: string) => request<{ success: boolean }>("/api/session/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ success: boolean }>("/api/session/logout", { method: "POST" }),
  getLibrary: () => request<LibraryPayload>("/api/library"),
  createFolder: (title: string, color: string) =>
    request("/api/folders", {
      method: "POST",
      body: JSON.stringify({ title, color })
    }),
  createNote: (payload: { title: string; folderId: string | null; template: PageTemplate; pageCount: number; coverColor: string }) =>
    request<DocumentBundle>("/api/documents/note", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  importPdf: (file: File, payload: { title: string; folderId: string | null; coverColor: string }) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", payload.title);
    formData.append("coverColor", payload.coverColor);
    if (payload.folderId) {
      formData.append("folderId", payload.folderId);
    }

    return request<DocumentBundle>("/api/documents/import", {
      method: "POST",
      body: formData
    });
  },
  getDocument: (documentId: string) => request<DocumentBundle>(`/api/documents/${documentId}`),
  renameDocument: (documentId: string, title: string) =>
    request<DocumentBundle>(`/api/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ title })
    }),
  insertBlankPage: (documentId: string, payload: { anchorPageId?: string; placement: "before" | "after"; template: PageTemplate }) =>
    request<DocumentBundle>(`/api/documents/${documentId}/pages/insert`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deletePage: (pageId: string) =>
    request<DocumentBundle>(`/api/pages/${pageId}`, {
      method: "DELETE"
    }),
  saveAnnotations: (pageId: string, annotations: Annotation[], annotationText: string) =>
    request(`/api/pages/${pageId}/annotations`, {
      method: "PUT",
      body: JSON.stringify({ annotations, annotationText })
    })
};

export { ApiError };

