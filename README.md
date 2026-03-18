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

For pull-based deploys from GitHub Container Registry, the image path for this repo is:

```text
ghcr.io/outlain/goodnotes-clone:latest
```

The app stores its SQLite database and uploaded PDFs inside `/app/data` in the container. In the default Compose file, that container path is backed by the host folder `./data`.

### What the volume does

This line:

```yaml
volumes:
  - ./data:/app/data
```

means:

- `./data` is a folder on your host machine, next to `docker-compose.yml`
- `/app/data` is the folder the app uses inside the container
- anything the app writes to `/app/data` survives container rebuilds and restarts

You only need one persistent volume for this app right now: `/app/data`.

That single mounted folder holds:

- `inkflow.db` - the SQLite database
- `uploads/` - original uploaded PDF files
- `temp/` - temporary upload staging files

### Does the app create the data files itself?

Yes. If `./data` is empty, the app creates what it needs on startup:

- the `./data` folder if Docker creates it as an empty bind mount
- the SQLite database file
- the `uploads/` directory
- the `temp/` directory

You do not need to pre-create any files inside `./data`.

### Does `.env` go inside `./data`?

No. `.env` should stay next to `docker-compose.yml`, not inside `./data`.

With this Compose section:

```yaml
env_file:
  - .env
```

Docker reads environment variables from a host file called `.env` in the project directory and passes them into the container.

So the two host-side paths have different jobs:

- `.env` - configuration values for the container
- `./data` - persistent app data created and used by the app

The app will not create `.env` for you. Create it once by copying `.env.example`.

### Typical first-time setup

1. Create the env file:

```bash
cp .env.example .env
```

2. Edit `.env` and set at least:

- `SESSION_SECRET` to a long random string
- `APP_PASSWORD` if you want a login gate

3. Start the container:

```bash
docker compose up -d
```

4. On first boot, the app populates the mounted `./data` folder automatically.

### Example production layout

```text
goodnotes-clone/
  docker-compose.yml
  .env
  data/
```

After first startup, `data/` will look roughly like:

```text
data/
  inkflow.db
  uploads/
  temp/
```

### If you want a different host path

You can mount any folder you want, as long as it maps to `/app/data` inside the container.

Example:

```yaml
volumes:
  - /srv/inkflow/data:/app/data
```

or with a named volume:

```yaml
volumes:
  - inkflow_data:/app/data
```

If you use a named volume, declare it at the bottom of the Compose file:

```yaml
volumes:
  inkflow_data:
```

## Environment variables

- `PORT`: HTTP port for the server
- `DATA_DIR`: data directory for SQLite and uploads. In Docker, keep this as `/app/data`.
- `SESSION_SECRET`: cookie signing secret
- `APP_PASSWORD`: optional shared password for the deployment. Leave blank to disable the login screen.

## Deployment notes

- The included GitHub Action builds and publishes a Docker image to GHCR.
- This repo's GHCR image path is `ghcr.io/outlain/goodnotes-clone:latest`.
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
