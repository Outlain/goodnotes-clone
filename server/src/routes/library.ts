import { unlink } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  createFolder,
  createImportedPdfDocument,
  createNoteDocument,
  deletePage,
  getDocumentBundle,
  getLibraryPayload,
  getPageDocumentId,
  getStoredFile,
  insertBlankPage,
  insertPdfPages,
  renameDocument,
  toPublicDocumentBundle,
  appendPageAnnotations,
  updatePageAnnotations
} from "../lib/db.js";
import { HttpError } from "../lib/http.js";
import { asyncRoute } from "../lib/http.js";
import { buildExportPdf, inspectPdf } from "../lib/pdf.js";
import { getUploadPath, persistUploadedPdf, tempUploadsDir } from "../lib/storage.js";
import { broadcastAnnotationUpdate, broadcastDocumentChanged } from "../lib/sync.js";

const folderSchema = z.object({
  title: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/)
});

const createNoteSchema = z.object({
  title: z.string().trim().min(1).max(120),
  folderId: z.string().trim().min(1).nullable().optional(),
  template: z.enum(["blank", "ruled", "grid", "dot"]),
  pageCount: z.number().int().min(1).max(200).optional(),
  coverColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/)
});

const renameSchema = z.object({
  title: z.string().trim().min(1).max(120)
});

const insertPageSchema = z.object({
  anchorPageId: z.string().trim().min(1).optional(),
  placement: z.enum(["before", "after"]).default("after"),
  template: z.enum(["blank", "ruled", "grid", "dot"])
});

const saveAnnotationsSchema = z.object({
  annotations: z.array(z.any()).max(5000),
  annotationText: z.string().max(200000)
});

const appendAnnotationsSchema = z.object({
  annotations: z.array(z.any()).max(5000),
  annotationText: z.string().max(200000)
});

const upload = multer({
  dest: tempUploadsDir,
  limits: {
    fileSize: 1024 * 1024 * 100
  }
});

/** Parse a human-friendly page range like "2-4" or "1,3,5-7" into 0-based indices. */
function parsePageRange(raw: string, totalPages: number): number[] {
  const indices = new Set<number>();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, Number(rangeMatch[1]));
      const end = Math.min(totalPages, Number(rangeMatch[2]));
      for (let i = start; i <= end; i++) {
        indices.add(i - 1); // 0-based
      }
    } else {
      const num = Number(part);
      if (Number.isInteger(num) && num >= 1 && num <= totalPages) {
        indices.add(num - 1);
      }
    }
  }

  return [...indices].sort((a, b) => a - b);
}

function safeDocumentTitle(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return "Untitled notebook";
  }
  return trimmed.replace(/\.pdf$/i, "");
}

export const libraryRouter = Router();

libraryRouter.get("/library", (_request, response) => {
  response.json(getLibraryPayload());
});

libraryRouter.post("/folders", (request, response) => {
  const parsed = folderSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Folder title and color are required." });
    return;
  }

  response.status(201).json(createFolder(parsed.data.title, parsed.data.color));
});

libraryRouter.post("/documents/note", (request, response) => {
  const parsed = createNoteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid notebook payload." });
    return;
  }

  response.status(201).json(
    toPublicDocumentBundle(
      createNoteDocument({
        title: parsed.data.title,
        folderId: parsed.data.folderId ?? null,
        template: parsed.data.template,
        pageCount: parsed.data.pageCount,
        coverColor: parsed.data.coverColor
      })
    )
  );
});

libraryRouter.post(
  "/documents/import",
  upload.single("file"),
  asyncRoute(async (request, response) => {
    if (!request.file) {
      response.status(400).json({ message: "Upload a PDF file to import." });
      return;
    }

    const coverColor = typeof request.body.coverColor === "string" && /^#[0-9A-Fa-f]{6}$/.test(request.body.coverColor)
      ? request.body.coverColor
      : "#8AA6A3";
    const folderId = typeof request.body.folderId === "string" && request.body.folderId.trim() ? request.body.folderId.trim() : null;
    const title = safeDocumentTitle(typeof request.body.title === "string" ? request.body.title : path.parse(request.file.originalname).name);

    const persisted = await persistUploadedPdf(request.file.path);

    try {
      const inspected = await inspectPdf(persisted.absolutePath);
      const document = createImportedPdfDocument({
        title,
        folderId,
        coverColor,
        originalName: request.file.originalname,
        mimeType: request.file.mimetype || "application/pdf",
        size: request.file.size,
        storageKey: persisted.storageKey,
        pages: inspected.pages
      });

      response.status(201).json(toPublicDocumentBundle(document));
    } catch (error) {
      await unlink(persisted.absolutePath).catch(() => undefined);
      throw error;
    }
  })
);

libraryRouter.get(
  "/documents/:documentId",
  asyncRoute(async (request, response) => {
    const documentId = String(request.params.documentId);
    response.json(toPublicDocumentBundle(getDocumentBundle(documentId)));
  })
);

libraryRouter.patch("/documents/:documentId", (request, response) => {
  const parsed = renameSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "A title is required." });
    return;
  }

  const documentId = String(request.params.documentId);
  response.json(toPublicDocumentBundle(renameDocument(documentId, parsed.data.title)));
});

libraryRouter.post("/documents/:documentId/pages/insert", (request, response) => {
  const parsed = insertPageSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid insert-page payload." });
    return;
  }

  const documentId = String(request.params.documentId);
  const senderId = String(request.headers["x-sync-client-id"] ?? "");
  const result = toPublicDocumentBundle(
    insertBlankPage({
      documentId,
      anchorPageId: parsed.data.anchorPageId,
      placement: parsed.data.placement,
      template: parsed.data.template
    })
  );
  broadcastDocumentChanged(documentId, senderId);
  response.status(201).json(result);
});

libraryRouter.post(
  "/documents/:documentId/pages/insert-pdf",
  upload.single("file"),
  asyncRoute(async (request, response) => {
    if (!request.file) {
      response.status(400).json({ message: "Upload a PDF file to insert pages from." });
      return;
    }

    const documentId = String(request.params.documentId);
    const senderId = String(request.headers["x-sync-client-id"] ?? "");
    const anchorPageId = typeof request.body.anchorPageId === "string" && request.body.anchorPageId.trim()
      ? request.body.anchorPageId.trim()
      : undefined;
    const placement = request.body.placement === "before" ? "before" : "after";

    // Parse page range — e.g. "2-4" → [1,2,3] (0-indexed), or "3" → [2]
    const pageRangeRaw = typeof request.body.pageRange === "string" ? request.body.pageRange.trim() : "";

    const persisted = await persistUploadedPdf(request.file.path);

    try {
      const inspected = await inspectPdf(persisted.absolutePath);

      // Determine which page indices to insert
      let pageIndices: number[];
      if (!pageRangeRaw) {
        // No range specified — insert all pages
        pageIndices = inspected.pages.map((_, index) => index);
      } else {
        pageIndices = parsePageRange(pageRangeRaw, inspected.pageCount);
      }

      if (pageIndices.length === 0) {
        response.status(400).json({ message: "No valid pages in the specified range." });
        return;
      }

      const result = toPublicDocumentBundle(
        insertPdfPages({
          documentId,
          anchorPageId,
          placement,
          fileStorageKey: persisted.storageKey,
          originalName: request.file.originalname,
          mimeType: request.file.mimetype || "application/pdf",
          fileSize: request.file.size,
          pages: inspected.pages,
          pageIndices
        })
      );
      broadcastDocumentChanged(documentId, senderId);
      response.status(201).json(result);
    } catch (error) {
      await unlink(persisted.absolutePath).catch(() => undefined);
      throw error;
    }
  })
);

libraryRouter.delete("/pages/:pageId", (request, response) => {
  const pageId = String(request.params.pageId);
  const documentId = getPageDocumentId(pageId) ?? "";
  const senderId = String(request.headers["x-sync-client-id"] ?? "");
  const result = toPublicDocumentBundle(deletePage(pageId));
  broadcastDocumentChanged(documentId, senderId);
  response.json(result);
});

libraryRouter.put("/pages/:pageId/annotations", (request, response) => {
  const parsed = saveAnnotationsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid annotation payload." });
    return;
  }

  const pageId = String(request.params.pageId);
  const senderId = String(request.headers["x-sync-client-id"] ?? "");
  const result = updatePageAnnotations(pageId, parsed.data.annotations, parsed.data.annotationText);
  const documentId = getPageDocumentId(pageId) ?? "";
  broadcastAnnotationUpdate(documentId, pageId, result.annotations, result.annotationText, senderId);
  response.json(result);
});

libraryRouter.post("/pages/:pageId/annotations/append", (request, response) => {
  const parsed = appendAnnotationsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid append-annotation payload." });
    return;
  }

  const pageId = String(request.params.pageId);
  const senderId = String(request.headers["x-sync-client-id"] ?? "");
  const result = appendPageAnnotations(pageId, parsed.data.annotations, parsed.data.annotationText);
  const documentId = getPageDocumentId(pageId) ?? "";
  broadcastAnnotationUpdate(documentId, pageId, result.annotations, result.annotationText, senderId);
  response.json(result);
});

libraryRouter.get(
  "/documents/:documentId/export",
  asyncRoute(async (request, response) => {
    const document = getDocumentBundle(String(request.params.documentId));
    const exportedBytes = await buildExportPdf(document, getUploadPath);
    const safeName = document.document.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "inkflow-export";

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    response.send(Buffer.from(exportedBytes));
  })
);

libraryRouter.get(
  "/files/:fileId/content",
  asyncRoute(async (request, response) => {
    const file = getStoredFile(String(request.params.fileId));
    if (!file) {
      throw new HttpError(404, "File not found.");
    }

    response.type(file.mimeType);
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.setHeader("Accept-Ranges", "bytes");
    response.sendFile(getUploadPath(file.storageKey));
  })
);
