# Inkflow

Inkflow is a production-oriented, self-hosted Goodnotes-style notes app built for the workflows that matter most in classes and study sessions:

- Create notebooks with blank, ruled, grid, or dot paper
- Import textbook and workbook PDFs
- Annotate uploaded PDFs with pen, highlighter, eraser, and text tools
- Insert blank pages before or after any page, including in imported PDFs
- Search imported PDF text and typed annotations
- Export a merged annotated PDF
- Use browser-based palm rejection controls with stylus-only mode for tablet writing

## Stack

- React + Vite frontend
- Express + TypeScript backend
- SQLite persistence via `better-sqlite3`
- Local file storage for uploaded PDFs
- Docker-ready production image
- GitHub Actions workflow for GHCR publishing

## Product scope

This repo ships the essential notebook and PDF annotation workflows that make a Goodnotes-style app usable in production for personal/self-hosted note taking.

Not included yet:

- handwriting OCR and handwriting search
- audio recording with note sync
- real-time collaboration
- cloud sync across devices
- flashcards / spaced repetition
- AI Q&A over notes

Those are intentionally left as future extensions instead of being claimed without working implementation.

## Local development

1. Use Node 20 or newer.
2. Copy `.env.example` to `.env`.
3. Install dependencies:

```bash
npm --prefix server install
npm --prefix client install
```

4. In one terminal, run the API:

```bash
npm run dev:server
```

5. In another terminal, run the web app:

```bash
npm run dev:client
```

The Vite client proxies `/api` requests to `http://localhost:3000`.

## Docker

Build and run locally:

```bash
cp .env.example .env
docker compose up --build
```

The app stores its SQLite database and uploaded PDFs inside `./data`, which is mounted to `/app/data` in the container.

## Environment variables

- `PORT`: HTTP port for the server
- `DATA_DIR`: data directory for SQLite and uploads
- `SESSION_SECRET`: cookie signing secret
- `APP_PASSWORD`: optional shared password for the deployment. Leave blank to disable the login screen.

## Deployment notes

- The included GitHub Action builds and publishes a Docker image to GHCR.
- Replace `ghcr.io/your-org/inkflow-clone:latest` in `docker-compose.yml` with your own published image path.
- If you deploy publicly, set a strong `SESSION_SECRET` and `APP_PASSWORD`.
- Back up the mounted `data` volume regularly because it contains both the notes database and uploaded source PDFs.

## Goodnotes-inspired behavior

This implementation was scoped around the core behaviors Goodnotes publicly highlights for annotating PDFs, flexible page editing, and searching notes:

- [Goodnotes features overview](https://www.goodnotes.com/features/)

## Suggested next steps

- add handwriting OCR and indexed handwritten search
- add image annotations and movable lasso selection
- move storage to S3-compatible object storage and Postgres for multi-user hosting
- add background jobs for large PDF import/export workloads
