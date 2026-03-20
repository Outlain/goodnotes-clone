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
2. Install dependencies:

```bash
npm --prefix server install
npm --prefix client install
```

3. In one terminal, run the API with environment variables in the shell:

```bash
PORT=3000 DATA_DIR=./data PDF_UPLOAD_LIMIT_MB=512 PDF_LINEARIZE_UPLOADS=true SESSION_SECRET=development-session-secret APP_PASSWORD= npm run dev:server
```

4. In another terminal, run the web app:

```bash
npm run dev:client
```

The Vite client proxies `/api` requests to `http://localhost:3000`.

Note: the Node server does not automatically read a `.env` file during local development. If you want that workflow, use your shell, `direnv`, Portainer stack variables, or another environment manager.

## Docker

Build and run locally:

```bash
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

### Where do the settings go now?

The default Compose file now uses an inline `environment:` block instead of an external `.env` file:

```yaml
environment:
  PORT: "3000"
  DATA_DIR: /app/data
  PDF_UPLOAD_LIMIT_MB: "512"
  PDF_LINEARIZE_UPLOADS: "true"
  SESSION_SECRET: change-this-to-a-long-random-secret
  APP_PASSWORD: ""
```

That makes the stack easier to paste directly into Portainer and easier to read at a glance.

So now the host-side setup is simply:

- `docker-compose.yml` - container definition and settings
- `./data` - persistent app data created and used by the app

You do not need a `.env` file for the default Docker setup anymore.

### Typical first-time setup

1. Edit `docker-compose.yml` and set at least:

- `SESSION_SECRET` to a long random string
- `APP_PASSWORD` if you want a login gate
- `PDF_UPLOAD_LIMIT_MB` if you plan to import very large PDFs

2. Start the container:

```bash
docker compose up -d
```

3. On first boot, the app populates the mounted `./data` folder automatically.

### Example production layout

```text
goodnotes-clone/
  docker-compose.yml
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

### Portainer-friendly stack example

```yaml
services:
  inkflow:
    image: ghcr.io/outlain/goodnotes-clone:latest
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      DATA_DIR: /app/data
      PDF_UPLOAD_LIMIT_MB: "512"
      PDF_LINEARIZE_UPLOADS: "true"
      SESSION_SECRET: replace-this-with-a-long-random-secret
      APP_PASSWORD: ""
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

For most deployments you only need to change:

- `SESSION_SECRET`
- `APP_PASSWORD` if you want the login screen enabled
- the left side of the volume mount if you want the data stored somewhere else on the host

## Environment variables

- `PORT`: HTTP port for the server
- `DATA_DIR`: data directory for SQLite and uploads. In Docker, keep this as `/app/data`.
- `PDF_UPLOAD_LIMIT_MB`: maximum accepted PDF upload size in megabytes. Default is `512`.
- `PDF_LINEARIZE_UPLOADS`: when `true`, Inkflow tries to linearize larger uploaded PDFs with `qpdf` so first-page and random-page loading can work better over range requests.
- `SESSION_SECRET`: secret key used to sign the session cookie after login
- `APP_PASSWORD`: optional shared password for the deployment. Leave blank to disable the login screen.

### Large PDF Notes

Inkflow is designed for textbook-sized PDFs, but there are two separate limits to keep in mind:

- upload size: the server must accept the file in the first place
- rendering/indexing cost: very large or poorly optimized PDFs can still take longer to import and preview
- initial client payload: sending too much page text to the browser up front can also slow first-open on very large books

For self-hosting, the default upload limit is now `512 MB`, which is enough for most large textbooks and scanned workbooks. If you need more, raise `PDF_UPLOAD_LIMIT_MB` in your Docker/Portainer stack.

Practical guidance:

- `175 MB` should import after this change
- if you front Inkflow with Nginx, Traefik, Caddy, Cloudflare, or another proxy, make sure its request body/upload size limit is also high enough
- if a PDF is unusually image-heavy, give the container enough RAM because import still extracts page text and page sizes
- for large textbook and workbook collections, `2 GB` RAM is a reasonable starting point and `4 GB` gives more headroom for very large scanned PDFs
- storing `data/` on SSD/NVMe helps a lot for large PDF workflows
- Inkflow now keeps initial document loads leaner and uses server-side search so the browser does not need the full text of every page up front
- Inkflow now uses a more aggressive large-file PDF loading profile in the browser, plus background low-resolution page warming, so visible pages can appear faster while sharp renders catch up
- if `PDF_LINEARIZE_UPLOADS=true`, the server will try to optimize larger uploads with `qpdf`, which can improve first-page and random-page loading
- enabling PDF "Fast Web View" / linearization before upload can improve initial remote loading because the browser PDF renderer can use byte-range requests more effectively
- if a source PDF is still awkward to work with, splitting it into chapter PDFs and inserting them into one Inkflow document is a workable fallback because the app can keep them in one continuous note flow

### Authentication variables explained

#### `SESSION_SECRET`

`SESSION_SECRET` is the secret key the server uses to sign the login session cookie.

In this app, when someone logs in successfully, the server creates a cookie and signs it with HMAC-SHA256 using `SESSION_SECRET`. That signature lets the server verify that:

- the cookie was created by this server
- the cookie was not tampered with by the browser or a third party
- an attacker cannot just make up a fake "logged in" cookie

Think of it as the private signing key for browser login sessions.

Important details:

- it is not the same thing as `APP_PASSWORD`
- users never type it into the UI
- it should be a long random string
- if you change it later, existing login sessions become invalid and users will need to log in again
- do not commit a real `SESSION_SECRET` to GitHub

Example of a good value:

```text
3dc0f2d71e864c2c85d262bb8d2a3f4af7fce2d2b4b526efc1d8c935ad8df0ce
```

#### `APP_PASSWORD`

`APP_PASSWORD` is the actual shared password people type into the login screen.

If it is set:

- the app shows a login screen
- the user must enter that password
- after successful login, the server issues a signed session cookie using `SESSION_SECRET`

If it is blank:

- the login screen is disabled
- no password is required
- anyone who can reach the app can use it

So yes, `APP_PASSWORD` is completely optional, but "optional" only means authentication is disabled. That is safe only if:

- the app is on a private network you trust
- or you already protect it with something else such as a reverse proxy auth layer, VPN, or private tunnel

If the app is exposed to the public internet, you should set `APP_PASSWORD`.

## Deployment notes

- The included GitHub Action builds and publishes a Docker image to GHCR.
- This repo's GHCR image path is `ghcr.io/outlain/goodnotes-clone:latest`.
- If you deploy publicly, set a strong `SESSION_SECRET` and set `APP_PASSWORD` unless another auth layer protects the app.
- Back up the mounted `data` volume regularly because it contains both the notes database and uploaded source PDFs.

## Goodnotes-inspired behavior

This implementation was scoped around the core behaviors Goodnotes publicly highlights for annotating PDFs, flexible page editing, and searching notes:

- [Goodnotes features overview](https://www.goodnotes.com/features/)

## Suggested next steps

- add handwriting OCR and indexed handwritten search
- add image annotations and movable lasso selection
- move storage to S3-compatible object storage and Postgres for multi-user hosting
- add background jobs for large PDF import/export workloads
