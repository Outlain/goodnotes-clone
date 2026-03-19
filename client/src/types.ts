export type PageTemplate = "blank" | "ruled" | "grid" | "dot";
export type DocumentKind = "note" | "pdf";
export type EditorTool = "pen" | "highlighter" | "eraser" | "text" | "hand";

export interface FolderRecord {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  folderId: string | null;
  title: string;
  kind: DocumentKind;
  coverColor: string;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  createdAt: string;
  url: string;
}

export interface AnnotationPoint {
  x: number;
  y: number;
  pressure: number;
}

export type LineStyle = "solid" | "dashed" | "dotted";

export interface StrokeAnnotation {
  id: string;
  type: "stroke";
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  lineStyle?: LineStyle;
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

export interface PageRecord {
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
  document: DocumentSummary;
  files: FileRecord[];
  pages: PageRecord[];
}

export interface LibraryPayload {
  folders: FolderRecord[];
  documents: DocumentSummary[];
}

export interface SessionStatus {
  required: boolean;
  authenticated: boolean;
}

export interface PalmSettings {
  stylusOnly: boolean;
  maxTouchArea: number;
}

