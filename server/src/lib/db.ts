import Database from "better-sqlite3";
import path from "node:path";
import { nanoid } from "nanoid";
import { env } from "./env.js";
import { HttpError } from "./http.js";

export type PageTemplate = "blank" | "ruled" | "grid" | "dot";
export type DocumentKind = "note" | "pdf";

export interface AnnotationPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface StrokeAnnotation {
  id: string;
  type: "stroke";
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  points: AnnotationPoint[];
}

export interface TextAnnotation {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  fontSize: number;
}

export type Annotation = StrokeAnnotation | TextAnnotation;

interface FolderRow {
  id: string;
  title: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  folder_id: string | null;
  title: string;
  kind: DocumentKind;
  cover_color: string;
  page_count: number;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  id: string;
  document_id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size: number;
  page_count: number;
  created_at: string;
}

interface PageRow {
  id: string;
  document_id: string;
  position: number;
  kind: "pdf" | "blank";
  source_file_id: string | null;
  source_page_index: number | null;
  template: PageTemplate | null;
  width: number;
  height: number;
  annotations_json: string;
  base_text: string;
  annotation_text: string;
  created_at: string;
  updated_at: string;
}

export interface FolderPayload {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummaryPayload {
  id: string;
  folderId: string | null;
  title: string;
  kind: DocumentKind;
  coverColor: string;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FilePayload {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  createdAt: string;
  url: string;
}

export interface PagePayload {
  id: string;
  position: number;
  kind: "pdf" | "blank";
  sourceFileId: string | null;
  sourcePageIndex: number | null;
  template: PageTemplate | null;
  width: number;
  height: number;
  annotations: Annotation[];
  baseText: string;
  annotationText: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentBundle {
  document: DocumentSummaryPayload;
  files: Array<FilePayload & { storageKey: string }>;
  pages: PagePayload[];
}

export interface ImportedPdfPage {
  width: number;
  height: number;
  text: string;
}

const dbPath = path.join(env.dataDir, "inkflow.db");
export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    cover_color TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    page_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    source_file_id TEXT REFERENCES files (id) ON DELETE SET NULL,
    source_page_index INTEGER,
    template TEXT,
    width REAL NOT NULL,
    height REAL NOT NULL,
    annotations_json TEXT NOT NULL DEFAULT '[]',
    base_text TEXT NOT NULL DEFAULT '',
    annotation_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(document_id, position)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pages_document_position ON pages (document_id, position);
`);

function now(): string {
  return new Date().toISOString();
}

function parseAnnotations(raw: string): Annotation[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapFolder(row: FolderRow): FolderPayload {
  return {
    id: row.id,
    title: row.title,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocument(row: DocumentRow): DocumentSummaryPayload {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    kind: row.kind,
    coverColor: row.cover_color,
    pageCount: row.page_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFile(row: FileRow): FilePayload & { storageKey: string } {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    pageCount: row.page_count,
    createdAt: row.created_at,
    storageKey: row.storage_key,
    url: `/api/files/${row.id}/content`
  };
}

function mapPage(row: PageRow): PagePayload {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind,
    sourceFileId: row.source_file_id,
    sourcePageIndex: row.source_page_index,
    template: row.template,
    width: row.width,
    height: row.height,
    annotations: parseAnnotations(row.annotations_json),
    baseText: row.base_text,
    annotationText: row.annotation_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function updateDocumentMetadata(documentId: string): void {
  const updatedAt = now();
  db.prepare(
    `
      UPDATE documents
      SET page_count = (
        SELECT COUNT(*)
        FROM pages
        WHERE document_id = @documentId
      ),
      updated_at = @updatedAt
      WHERE id = @documentId
    `
  ).run({ documentId, updatedAt });
}

function getDocumentRow(documentId: string): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as DocumentRow | undefined;
}

export function getLibraryPayload(): { folders: FolderPayload[]; documents: DocumentSummaryPayload[] } {
  const folders = db.prepare("SELECT * FROM folders ORDER BY updated_at DESC").all() as FolderRow[];
  const documents = db.prepare("SELECT * FROM documents ORDER BY updated_at DESC").all() as DocumentRow[];
  return {
    folders: folders.map(mapFolder),
    documents: documents.map(mapDocument)
  };
}

export function createFolder(title: string, color: string): FolderPayload {
  const timestamp = now();
  const id = nanoid();

  db.prepare(
    `
      INSERT INTO folders (id, title, color, created_at, updated_at)
      VALUES (@id, @title, @color, @createdAt, @updatedAt)
    `
  ).run({
    id,
    title,
    color,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  const row = db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow;
  return mapFolder(row);
}

export function createNoteDocument(options: {
  title: string;
  folderId: string | null;
  template: PageTemplate;
  pageCount?: number;
  coverColor: string;
}): DocumentBundle {
  const timestamp = now();
  const documentId = nanoid();
  const pageCount = Math.max(1, options.pageCount ?? 1);

  const transaction = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO documents (id, folder_id, title, kind, cover_color, page_count, created_at, updated_at)
        VALUES (@id, @folderId, @title, 'note', @coverColor, 0, @createdAt, @updatedAt)
      `
    ).run({
      id: documentId,
      folderId: options.folderId,
      title: options.title,
      coverColor: options.coverColor,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const insertPage = db.prepare(
      `
        INSERT INTO pages (
          id, document_id, position, kind, source_file_id, source_page_index,
          template, width, height, annotations_json, base_text, annotation_text, created_at, updated_at
        )
        VALUES (
          @id, @documentId, @position, 'blank', NULL, NULL,
          @template, @width, @height, '[]', '', '', @createdAt, @updatedAt
        )
      `
    );

    for (let position = 1; position <= pageCount; position += 1) {
      insertPage.run({
        id: nanoid(),
        documentId,
        position,
        template: options.template,
        width: 612,
        height: 792,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    updateDocumentMetadata(documentId);
  });

  transaction();
  return getDocumentBundle(documentId);
}

export function createImportedPdfDocument(options: {
  title: string;
  folderId: string | null;
  coverColor: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  pages: ImportedPdfPage[];
}): DocumentBundle {
  const timestamp = now();
  const documentId = nanoid();
  const fileId = nanoid();

  const transaction = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO documents (id, folder_id, title, kind, cover_color, page_count, created_at, updated_at)
        VALUES (@id, @folderId, @title, 'pdf', @coverColor, 0, @createdAt, @updatedAt)
      `
    ).run({
      id: documentId,
      folderId: options.folderId,
      title: options.title,
      coverColor: options.coverColor,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    db.prepare(
      `
        INSERT INTO files (id, document_id, storage_key, original_name, mime_type, size, page_count, created_at)
        VALUES (@id, @documentId, @storageKey, @originalName, @mimeType, @size, @pageCount, @createdAt)
      `
    ).run({
      id: fileId,
      documentId,
      storageKey: options.storageKey,
      originalName: options.originalName,
      mimeType: options.mimeType,
      size: options.size,
      pageCount: options.pages.length,
      createdAt: timestamp
    });

    const insertPage = db.prepare(
      `
        INSERT INTO pages (
          id, document_id, position, kind, source_file_id, source_page_index,
          template, width, height, annotations_json, base_text, annotation_text, created_at, updated_at
        )
        VALUES (
          @id, @documentId, @position, 'pdf', @sourceFileId, @sourcePageIndex,
          NULL, @width, @height, '[]', @baseText, '', @createdAt, @updatedAt
        )
      `
    );

    options.pages.forEach((page, index) => {
      insertPage.run({
        id: nanoid(),
        documentId,
        position: index + 1,
        sourceFileId: fileId,
        sourcePageIndex: index,
        width: page.width,
        height: page.height,
        baseText: page.text,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    });

    updateDocumentMetadata(documentId);
  });

  transaction();
  return getDocumentBundle(documentId);
}

export function getDocumentBundle(documentId: string): DocumentBundle {
  const documentRow = getDocumentRow(documentId);
  if (!documentRow) {
    throw new HttpError(404, "Document not found.");
  }

  const fileRows = db.prepare("SELECT * FROM files WHERE document_id = ? ORDER BY created_at ASC").all(documentId) as FileRow[];
  const pageRows = db.prepare("SELECT * FROM pages WHERE document_id = ? ORDER BY position ASC").all(documentId) as PageRow[];

  return {
    document: mapDocument(documentRow),
    files: fileRows.map(mapFile),
    pages: pageRows.map(mapPage)
  };
}

export function renameDocument(documentId: string, title: string): DocumentBundle {
  const updatedAt = now();
  const result = db
    .prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, updatedAt, documentId);

  if (result.changes === 0) {
    throw new HttpError(404, "Document not found.");
  }

  return getDocumentBundle(documentId);
}

export function insertBlankPage(options: {
  documentId: string;
  anchorPageId?: string;
  placement: "before" | "after";
  template: PageTemplate;
}): DocumentBundle {
  const documentRow = getDocumentRow(options.documentId);
  if (!documentRow) {
    throw new HttpError(404, "Document not found.");
  }

  const transaction = db.transaction(() => {
    const anchorRow = options.anchorPageId
      ? (db
          .prepare("SELECT * FROM pages WHERE id = ? AND document_id = ?")
          .get(options.anchorPageId, options.documentId) as PageRow | undefined)
      : undefined;

    const lastPage = db
      .prepare("SELECT * FROM pages WHERE document_id = ? ORDER BY position DESC LIMIT 1")
      .get(options.documentId) as PageRow | undefined;

    const referencePage = anchorRow ?? lastPage;
    const nextPosition = anchorRow
      ? options.placement === "before"
        ? anchorRow.position
        : anchorRow.position + 1
      : (lastPage?.position ?? 0) + 1;

    db.prepare("UPDATE pages SET position = position + 1 WHERE document_id = ? AND position >= ?").run(options.documentId, nextPosition);

    const timestamp = now();
    db.prepare(
      `
        INSERT INTO pages (
          id, document_id, position, kind, source_file_id, source_page_index,
          template, width, height, annotations_json, base_text, annotation_text, created_at, updated_at
        )
        VALUES (
          @id, @documentId, @position, 'blank', NULL, NULL,
          @template, @width, @height, '[]', '', '', @createdAt, @updatedAt
        )
      `
    ).run({
      id: nanoid(),
      documentId: options.documentId,
      position: nextPosition,
      template: options.template,
      width: referencePage?.width ?? 612,
      height: referencePage?.height ?? 792,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    updateDocumentMetadata(options.documentId);
  });

  transaction();
  return getDocumentBundle(options.documentId);
}

export function deletePage(pageId: string): DocumentBundle {
  const pageRow = db.prepare("SELECT * FROM pages WHERE id = ?").get(pageId) as PageRow | undefined;
  if (!pageRow) {
    throw new HttpError(404, "Page not found.");
  }

  const pageCount = db.prepare("SELECT COUNT(*) as total FROM pages WHERE document_id = ?").get(pageRow.document_id) as { total: number };
  if (pageCount.total <= 1) {
    throw new HttpError(400, "A document must keep at least one page.");
  }

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM pages WHERE id = ?").run(pageId);
    db.prepare("UPDATE pages SET position = position - 1 WHERE document_id = ? AND position > ?").run(
      pageRow.document_id,
      pageRow.position
    );
    updateDocumentMetadata(pageRow.document_id);
  });

  transaction();
  return getDocumentBundle(pageRow.document_id);
}

export function updatePageAnnotations(pageId: string, annotations: Annotation[], annotationText: string): PagePayload {
  const pageRow = db.prepare("SELECT * FROM pages WHERE id = ?").get(pageId) as PageRow | undefined;
  if (!pageRow) {
    throw new HttpError(404, "Page not found.");
  }

  const updatedAt = now();
  db.prepare(
    `
      UPDATE pages
      SET annotations_json = @annotations, annotation_text = @annotationText, updated_at = @updatedAt
      WHERE id = @pageId
    `
  ).run({
    annotations: JSON.stringify(annotations),
    annotationText,
    updatedAt,
    pageId
  });

  db.prepare("UPDATE documents SET updated_at = ? WHERE id = ?").run(updatedAt, pageRow.document_id);

  const nextRow = db.prepare("SELECT * FROM pages WHERE id = ?").get(pageId) as PageRow;
  return mapPage(nextRow);
}

export function getStoredFile(fileId: string): (FilePayload & { storageKey: string; documentId: string }) | undefined {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as FileRow | undefined;
  if (!row) {
    return undefined;
  }

  return {
    ...mapFile(row),
    documentId: row.document_id
  };
}

export function toPublicDocumentBundle(bundle: DocumentBundle) {
  return {
    ...bundle,
    files: bundle.files.map(({ storageKey: _storageKey, ...file }) => file)
  };
}
