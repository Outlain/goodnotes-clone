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
  getStoredFile,
  insertBlankPage,
  renameDocument,
  toPublicDocumentBundle,
  appendPageAnnotations,
  updatePageAnnotations
} from "../lib/db.js";
import { HttpError } from "../lib/http.js";
import { asyncRoute } from "../lib/http.js";
import { buildExportPdf, inspectPdf } from "../lib/pdf.js";
import { getUploadPath, persistUploadedPdf, tempUploadsDir } from "../lib/storage.js";

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

  response.status(201).json(
    toPublicDocumentBundle(
      insertBlankPage({
        documentId: String(request.params.documentId),
        anchorPageId: parsed.data.anchorPageId,
        placement: parsed.data.placement,
        template: parsed.data.template
      })
    )
  );
});

libraryRouter.delete("/pages/:pageId", (request, response) => {
  response.json(toPublicDocumentBundle(deletePage(String(request.params.pageId))));
});

libraryRouter.put("/pages/:pageId/annotations", (request, response) => {
  const parsed = saveAnnotationsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid annotation payload." });
    return;
  }

  response.json(updatePageAnnotations(String(request.params.pageId), parsed.data.annotations, parsed.data.annotationText));
});

libraryRouter.post("/pages/:pageId/annotations/append", (request, response) => {
  const parsed = appendAnnotationsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ message: "Invalid append-annotation payload." });
    return;
  }

  response.json(appendPageAnnotations(String(request.params.pageId), parsed.data.annotations, parsed.data.annotationText));
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
