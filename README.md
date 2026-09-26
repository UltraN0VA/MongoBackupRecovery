# MongoDB Backup & Restore Website

Simple web UI that runs `mongodump` (backup) and `mongorestore` (restore) on the server.

## Requirements

- Node.js 18+
- MongoDB Database Tools installed (`mongodump`, `mongorestore` in PATH)
  - Check: `mongodump --version` / `mongorestore --version`
- A reachable MongoDB (`mongodb://...` or `mongodb+srv://...`)

## Setup

```powershell
npm install
npm start
```

Open http://localhost:3000

Set a custom port:

```powershell
$env:PORT=4000; npm start
```

## How it works

| Action | Tool command run on server |
|---|---|
| Backup | `mongodump --uri=<source> [--db=<db>] --archive=backups/<file> [--gzip]` |
| Restore (upload) | `mongorestore --uri=<target> [--db=<db>] [--drop] [--gzip] --archive=uploads/<file>` |
| Restore (server file) | `mongorestore --uri=<target> --archive=backups/<file> ...` |

- Backups are stored in `./backups/` and can be downloaded from the Library tab.
- Uploads go to `./uploads/`.
- Passwords in URIs are masked (`****`) in logs and console output.
- Use `--drop` carefully: it deletes the target database/collection before restoring.

## API

- `GET /api/health` — tool versions
- `POST /api/databases { uri }` — list databases
- `POST /api/backup { uri, dbName?, gzip?, archiveName? }` — create backup
- `GET /api/backups` — list backups
- `GET /api/backups/:filename` — download
- `DELETE /api/backups/:filename` — delete
- `POST /api/restore` (multipart: `backupFile` + `targetUri, dbName?, drop?, noIndexRestore?`) — restore upload
- `POST /api/restore-server { filename, targetUri, dbName?, drop?, noIndexRestore? }` — restore server file
