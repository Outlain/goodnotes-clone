import type { Annotation, PageRecord } from "../types";

function distanceToSegment(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number
): number {
  const dx = endX - startX;
  const dy = endY - startY;

  if (dx === 0 && dy === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }

  const t = Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / (dx * dx + dy * dy)));
  const projectedX = startX + t * dx;
  const projectedY = startY + t * dy;
  return Math.hypot(pointX - projectedX, pointY - projectedY);
}

export function buildStrokePath(annotation: Extract<Annotation, { type: "stroke" }>): string {
  if (annotation.points.length === 0) {
    return "";
  }

  const [firstPoint, ...rest] = annotation.points;
  if (rest.length === 0) {
    return `M ${firstPoint.x} ${firstPoint.y} L ${firstPoint.x + 0.01} ${firstPoint.y + 0.01}`;
  }

  return `M ${firstPoint.x} ${firstPoint.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
}

export function hitTestAnnotation(annotation: Annotation, x: number, y: number): boolean {
  if (annotation.type === "text") {
    return x >= annotation.x && x <= annotation.x + annotation.width && y >= annotation.y && y <= annotation.y + annotation.height;
  }

  if (annotation.points.length === 1) {
    const point = annotation.points[0];
    return Math.hypot(x - point.x, y - point.y) <= annotation.width + 8;
  }

  for (let index = 1; index < annotation.points.length; index += 1) {
    const previous = annotation.points[index - 1];
    const current = annotation.points[index];
    if (distanceToSegment(x, y, previous.x, previous.y, current.x, current.y) <= annotation.width + 8) {
      return true;
    }
  }

  return false;
}

export function collectAnnotationText(annotations: Annotation[]): string {
  return annotations
    .filter((annotation): annotation is Extract<Annotation, { type: "text" }> => annotation.type === "text")
    .map((annotation) => annotation.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function getPageSearchText(page: PageRecord): string {
  return `${page.baseText} ${page.annotationText}`.trim();
}

export function excerptForSearch(page: PageRecord, query: string): string {
  const searchText = getPageSearchText(page);
  if (!query.trim()) {
    return searchText.slice(0, 140);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matchIndex = searchText.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return searchText.slice(0, 140);
  }

  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(searchText.length, matchIndex + normalizedQuery.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < searchText.length ? "..." : "";
  return `${prefix}${searchText.slice(start, end)}${suffix}`;
}
