const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

const BACKUP_DIR = path.join(__dirname, 'backups');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

for (const d of [BACKUP_DIR, UPLOAD_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// ---------- helpers ----------

function maskUri(uri) {
  if (!uri) return '';
  // mongodb://user:password@host -> mongodb://user:****@host
  return uri.replace(/\/\/([^:/@]+):([^@]+)@/g, '//\$1:****@');
}

function isValidMongoUri(uri) {
  return typeof uri === 'string' && /^(mongodb:\/\/|mongodb\+srv:\/\/)/.test(uri.trim());
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseDatabaseFromFilename(filename) {
  // Standard names: backup_<db>_<timestamp>.archive[.gz]
  // e.g. backup_myapp_2026-09-26T09-17-49.archive.gz, backup_all_....archive.gz
  const m = String(filename || '').match(/^backup_(.*)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.archive(\.gz)?$/);
  if (m) return m[1] === 'all' ? '(all databases)' : m[1];
  return '—';
}

function runTool(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const masked = [cmd, ...args.map((a) =>
      /^mongodb(\+srv)?:\/\//.test(a) ? '--uri=****' :
      a.startsWith('--uri=') ? '--uri=****' : a
    )].join(' ');

    const child = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, command: masked });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, command: masked });
    });
  });
}

function getToolVersion(cmd) {
  return runTool(cmd, ['--version']).then((r) => (r.code === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : 'not found'));
}

// multer for restore uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `upload-${ts}-${safeFilename(file.originalname)}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ---------- routes ----------

app.get('/api/health', async (req, res) => {
  const [dumpV, restoreV] = await Promise.all([
    getToolVersion('mongodump'),
    getToolVersion('mongorestore')
  ]);
  res.json({
    ok: true,
    mongodump: dumpV,
    mongorestore: restoreV,
    backupDir: BACKUP_DIR,
    time: new Date().toISOString()
  });
});

// List databases for a given URI (helps user pick dbName)
app.post('/api/databases', async (req, res) => {
  const { uri } = req.body || {};
  if (!isValidMongoUri(uri)) return res.status(400).json({ ok: false, error: 'Invalid MongoDB URI. Must start with mongodb:// or mongodb+srv://' });
  let client;
  try {
    client = new MongoClient(uri.trim(), { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const admin = client.db().admin();
    const { databases } = await admin.listDatabases();
    res.json({ ok: true, databases: databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

// Create a backup with mongodump
app.post('/api/backup', async (req, res) => {
  const { uri, dbName = '', gzip = true, archiveName = '' } = req.body || {};
  if (!isValidMongoUri(uri)) return res.status(400).json({ ok: false, error: 'Invalid source MongoDB URI.' });

  const cleanDb = String(dbName || '').trim();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const useGzip = gzip !== false && gzip !== 'false';
  const base = archiveName
    ? safeFilename(archiveName)
    : `backup_${cleanDb || 'all'}_${ts}.archive${useGzip ? '.gz' : ''}`;
  const filename = base.endsWith('.archive') || base.endsWith('.gz') ? base : base + '.archive.gz';
  const outPath = path.join(BACKUP_DIR, filename);

  const args = [`--uri=${uri.trim()}`, `--archive=${outPath}`];
  if (cleanDb) args.push(`--db=${cleanDb}`);
  if (useGzip) args.push('--gzip');

  console.log(`[backup] ${maskUri(uri)} db=${cleanDb || '(all)'} -> ${filename}`);
  const result = await runTool('mongodump', args);
  const success = result.code === 0 && fs.existsSync(outPath);
  const stat = success ? fs.statSync(outPath) : null;
  const databaseLabel = cleanDb || '(all databases)';
  if (success) {
    try {
      fs.writeFileSync(outPath + '.meta.json', JSON.stringify({
        filename, database: databaseLabel, size: stat.size, created: new Date().toISOString()
      }));
    } catch {}
  }

  res.status(success ? 200 : 500).json({
    ok: success,
    filename,
    database: databaseLabel,
    size: stat ? stat.size : 0,
    downloadUrl: success ? `/api/backups/${encodeURIComponent(filename)}` : null,
    command: result.command,
    logs: (result.stderr || result.stdout || '').slice(-8000),
    error: success ? null : 'mongodump failed. See logs.'
  });
});

// List stored backups
app.get('/api/backups', (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => !f.startsWith('.') && f !== '.gitkeep' && !f.endsWith('.meta.json'))
    .map((f) => {
      const p = path.join(BACKUP_DIR, f);
      const s = fs.statSync(p);
      let database = parseDatabaseFromFilename(f);
      try {
        const metaPath = p + '.meta.json';
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.database) database = meta.database;
        }
      } catch {}
      return { filename: f, database, size: s.size, created: s.birthtime, modified: s.mtime };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ ok: true, backups: files });
});

// Download a backup
app.get('/api/backups/:filename', (req, res) => {
  const f = safeFilename(req.params.filename);
  if (f.endsWith('.meta.json')) return res.status(404).json({ ok: false, error: 'File not found' });
  const p = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'File not found' });
  res.download(p, f);
});

// Delete a backup
app.delete('/api/backups/:filename', (req, res) => {
  const f = safeFilename(req.params.filename);
  const p = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'File not found' });
  fs.unlinkSync(p);
  try { fs.unlinkSync(p + '.meta.json'); } catch {}
  res.json({ ok: true, deleted: f });
});

// Restore from uploaded file with mongorestore
app.post('/api/restore', upload.single('backupFile'), async (req, res) => {
  const { targetUri, dbName = '', drop = 'false', noIndexRestore = 'false', gzip = 'auto' } = req.body || {};
  if (!req.file) return res.status(400).json({ ok: false, error: 'No backup file uploaded (field name: backupFile).' });
  if (!isValidMongoUri(targetUri)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, error: 'Invalid target MongoDB URI.' });
  }

  const cleanDb = String(dbName || '').trim();
  const args = [`--uri=${String(targetUri).trim()}`, `--archive=${req.file.path}`];
  if (cleanDb) args.push(`--db=${cleanDb}`);
  if (String(drop) === 'true') args.push('--drop');
  if (String(noIndexRestore) === 'true') args.push('--noIndexRestore');

  const fname = req.file.originalname.toLowerCase();
  const wantGzip = gzip === 'true' || (gzip === 'auto' && (fname.endsWith('.gz') || fname.endsWith('.archive.gz')));
  if (wantGzip) args.push('--gzip');

  console.log(`[restore-upload] ${maskUri(targetUri)} db=${cleanDb || '(from archive)'} file=${req.file.originalname}`);
  const result = await runTool('mongorestore', args);
  const success = result.code === 0;

  // keep upload on failure for inspection, delete on success to save space? Keep both, user can clean uploads.
  res.status(success ? 200 : 500).json({
    ok: success,
    command: result.command,
    logs: (result.stderr || result.stdout || '').slice(-8000),
    error: success ? null : 'mongorestore failed. See logs.'
  });
});

// Restore from a server-stored backup file
app.post('/api/restore-server', async (req, res) => {
  const { filename, targetUri, dbName = '', drop = false, noIndexRestore = false } = req.body || {};
  if (!filename) return res.status(400).json({ ok: false, error: 'filename is required.' });
  if (!isValidMongoUri(targetUri)) return res.status(400).json({ ok: false, error: 'Invalid target MongoDB URI.' });

  const f = safeFilename(filename);
  const p = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'Backup file not found on server.' });

  const cleanDb = String(dbName || '').trim();
  const args = [`--uri=${String(targetUri).trim()}`, `--archive=${p}`];
  if (cleanDb) args.push(`--db=${cleanDb}`);
  if (drop === true || drop === 'true') args.push('--drop');
  if (noIndexRestore === true || noIndexRestore === 'true') args.push('--noIndexRestore');
  if (f.endsWith('.gz')) args.push('--gzip');

  console.log(`[restore-server] ${maskUri(targetUri)} file=${f}`);
  const result = await runTool('mongorestore', args);
  const success = result.code === 0;
  res.status(success ? 200 : 500).json({
    ok: success,
    command: result.command,
    logs: (result.stderr || result.stdout || '').slice(-8000),
    error: success ? null : 'mongorestore failed. See logs.'
  });
});

// fallback to index
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mongo Backup & Restore UI: http://localhost:${PORT}`);
  console.log(`Backups dir: ${BACKUP_DIR}`);
});
