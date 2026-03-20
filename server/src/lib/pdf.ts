import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Annotation, DocumentBundle, LineStyle, PageTemplate, ShapeAnnotation, TextAnnotation } from "./db.js";

interface ExtractedPdfPage {
  width: number;
  height: number;
  text: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hexToRgb(hexColor: string): { red: number; green: number; blue: number } {
  const normalized = hexColor.replace("#", "");
  const padded = normalized.length === 3 ? normalized.split("").map((part) => `${part}${part}`).join("") : normalized;
  const intValue = Number.parseInt(padded, 16);
  return {
    red: ((intValue >> 16) & 255) / 255,
    green: ((intValue >> 8) & 255) / 255,
    blue: (intValue & 255) / 255
  };
}

function dashPattern(style: LineStyle | undefined, width: number): number[] | undefined {
  if (!style || style === "solid") {
    return undefined;
  }

  if (style === "dashed") {
    return [Math.max(2, width * 3), Math.max(2, width * 2)];
  }

  return [Math.max(1, width * 0.2), Math.max(2, width * 2.5)];
}

function strokeAndFillOptions(annotation: ShapeAnnotation) {
  const color = hexToRgb(annotation.color);
  return {
    strokeColor: rgb(color.red, color.green, color.blue),
    fillColor: rgb(color.red, color.green, color.blue),
    dashArray: dashPattern(annotation.lineStyle, annotation.strokeWidth)
  };
}

function drawPolygonShape(
  pdfPage: import("pdf-lib").PDFPage,
  annotation: ShapeAnnotation,
  pageHeight: number
): void {
  const { x, y, width, height } = annotation;
  const bottomY = pageHeight - y - height;
  const topY = bottomY + height;
  const centerX = x + width / 2;
  const centerY = bottomY + height / 2;
  const path =
    annotation.shape === "triangle"
      ? `M ${centerX} ${topY} L ${x + width} ${bottomY} L ${x} ${bottomY} Z`
      : `M ${centerX} ${topY} L ${x + width} ${centerY} L ${centerX} ${bottomY} L ${x} ${centerY} Z`;
  const { strokeColor, fillColor, dashArray } = strokeAndFillOptions(annotation);

  pdfPage.drawSvgPath(path, {
    color: annotation.fill ? fillColor : undefined,
    opacity: annotation.fill ? 0.16 : undefined,
    borderColor: strokeColor,
    borderOpacity: 1,
    borderWidth: clamp(annotation.strokeWidth, 1, 24),
    borderDashArray: dashArray
  });
}

function drawShapeAnnotation(
  pdfPage: import("pdf-lib").PDFPage,
  annotation: ShapeAnnotation,
  pageHeight: number
): void {
  const { strokeColor, fillColor, dashArray } = strokeAndFillOptions(annotation);
  const y = pageHeight - annotation.y - annotation.height;

  if (annotation.shape === "rectangle") {
    pdfPage.drawRectangle({
      x: annotation.x,
      y,
      width: annotation.width,
      height: annotation.height,
      color: annotation.fill ? fillColor : undefined,
      opacity: annotation.fill ? 0.16 : undefined,
      borderColor: strokeColor,
      borderOpacity: 1,
      borderWidth: clamp(annotation.strokeWidth, 1, 24),
      borderDashArray: dashArray
    });
    return;
  }

  if (annotation.shape === "ellipse") {
    pdfPage.drawEllipse({
      x: annotation.x + annotation.width / 2,
      y: y + annotation.height / 2,
      xScale: annotation.width / 2,
      yScale: annotation.height / 2,
      color: annotation.fill ? fillColor : undefined,
      opacity: annotation.fill ? 0.16 : undefined,
      borderColor: strokeColor,
      borderOpacity: 1,
      borderWidth: clamp(annotation.strokeWidth, 1, 24),
      borderDashArray: dashArray
    });
    return;
  }

  drawPolygonShape(pdfPage, annotation, pageHeight);
}

function drawTextAnnotation(
  pdfPage: import("pdf-lib").PDFPage,
  annotation: TextAnnotation,
  height: number,
  helvetica: import("pdf-lib").PDFFont
): void {
  const color = hexToRgb(annotation.color);
  pdfPage.drawText(annotation.text.split("\n").join("\n"), {
    x: annotation.x,
    y: height - annotation.y - annotation.fontSize,
    font: helvetica,
    size: annotation.fontSize,
    maxWidth: annotation.width,
    lineHeight: annotation.fontSize * 1.25,
    color: rgb(color.red, color.green, color.blue)
  });
}

function drawTemplate(page: import("pdf-lib").PDFPage, template: PageTemplate | null, width: number, height: number): void {
  page.drawRectangle({
    x: 0,
    y: 0,
    width,
    height,
    color: rgb(0.99, 0.985, 0.965)
  });

  const paperLine = rgb(0.82, 0.86, 0.92);

  if (template === "ruled") {
    for (let y = height - 42; y > 24; y -= 28) {
      page.drawLine({
        start: { x: 28, y },
        end: { x: width - 28, y },
        color: paperLine,
        thickness: 0.75,
        opacity: 0.6
      });
    }
    return;
  }

  if (template === "grid") {
    for (let y = height - 36; y > 20; y -= 28) {
      page.drawLine({
        start: { x: 20, y },
        end: { x: width - 20, y },
        color: paperLine,
        thickness: 0.6,
        opacity: 0.45
      });
    }
    for (let x = 20; x < width - 20; x += 28) {
      page.drawLine({
        start: { x, y: 20 },
        end: { x, y: height - 20 },
        color: paperLine,
        thickness: 0.6,
        opacity: 0.45
      });
    }
    return;
  }

  if (template === "dot") {
    for (let y = height - 28; y > 16; y -= 24) {
      for (let x = 24; x < width - 16; x += 24) {
        page.drawCircle({
          x,
          y,
          size: 0.7,
          color: paperLine,
          opacity: 0.75
        });
      }
    }
  }
}

function drawAnnotations(
  pdfPage: import("pdf-lib").PDFPage,
  annotations: Annotation[],
  width: number,
  height: number,
  helvetica: import("pdf-lib").PDFFont
): void {
  annotations.forEach((annotation) => {
    if (annotation.type === "stroke") {
      const color = hexToRgb(annotation.color);
      const opacity = annotation.tool === "highlighter" ? 0.22 : 1;
      const points = annotation.points;

      if (points.length === 1) {
        const point = points[0];
        pdfPage.drawCircle({
          x: point.x,
          y: height - point.y,
          size: annotation.width / 2,
          color: rgb(color.red, color.green, color.blue),
          opacity
        });
        return;
      }

      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        pdfPage.drawLine({
          start: { x: previous.x, y: height - previous.y },
          end: { x: current.x, y: height - current.y },
          color: rgb(color.red, color.green, color.blue),
          thickness: clamp(annotation.width, 1, 40),
          opacity
        });
      }
      return;
    }

    if (annotation.type === "text") {
      drawTextAnnotation(pdfPage, annotation, height, helvetica);
      return;
    }

    if (annotation.type === "shape") {
      drawShapeAnnotation(pdfPage, annotation, height);
    }
  });
}

export async function inspectPdf(filePath: string): Promise<{ pageCount: number; pages: ExtractedPdfPage[] }> {
  const bytes = await readFile(filePath);
  const pdfJsTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true
  });
  const pdfJsDocument = await pdfJsTask.promise;

  const pages: ExtractedPdfPage[] = [];
  for (let index = 0; index < pdfJsDocument.numPages; index += 1) {
    const textPage = await pdfJsDocument.getPage(index + 1);
    const viewport = textPage.getViewport({ scale: 1 });
    const textContent = await textPage.getTextContent();
    const text = normalizeText(
      textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
    );
    textPage.cleanup();

    pages.push({
      width: viewport.width,
      height: viewport.height,
      text
    });
  }

  await pdfJsTask.destroy();

  return {
    pageCount: pages.length,
    pages
  };
}

export async function buildExportPdf(documentBundle: DocumentBundle, resolveStoragePath: (storageKey: string) => string): Promise<Uint8Array> {
  const exportDocument = await PDFDocument.create();
  const helvetica = await exportDocument.embedFont(StandardFonts.Helvetica);
  const fileCache = new Map<string, PDFDocument>();

  for (const page of documentBundle.pages) {
    if (page.kind === "pdf" && page.sourceFileId) {
      const sourceFile = documentBundle.files.find((candidate) => candidate.id === page.sourceFileId);
      if (!sourceFile) {
        continue;
      }

      let sourcePdf = fileCache.get(sourceFile.id);
      if (!sourcePdf) {
        const bytes = await readFile(resolveStoragePath(sourceFile.storageKey));
        sourcePdf = await PDFDocument.load(bytes);
        fileCache.set(sourceFile.id, sourcePdf);
      }

      const [copiedPage] = await exportDocument.copyPages(sourcePdf, [page.sourcePageIndex ?? 0]);
      exportDocument.addPage(copiedPage);
      drawAnnotations(copiedPage, page.annotations, page.width, page.height, helvetica);
      continue;
    }

    const blankPage = exportDocument.addPage([page.width, page.height]);
    drawTemplate(blankPage, page.template, page.width, page.height);
    drawAnnotations(blankPage, page.annotations, page.width, page.height, helvetica);
  }

  return exportDocument.save();
}
