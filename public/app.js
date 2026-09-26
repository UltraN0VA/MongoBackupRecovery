const $ = (id) => document.getElementById(id);

// tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    ['backup', 'restore', 'library'].forEach((n) => {
      $('tab-' + n).classList.toggle('hidden', n !== t.dataset.tab);
    });
    if (t.dataset.tab === 'library') loadLibrary();
    if (t.dataset.tab === 'restore') loadServerFiles();
  });
});

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ---- busy / progress helper: keeps UI alive during long mongodump/restore ----
function startJob({ btn, busyText, progressId, elapsedId, statusId, logId, steps }) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${busyText}`;
  document.body.classList.add('is-busy');
  const prog = $(progressId);
  const elapsedEl = $(elapsedId);
  const statusEl = $(statusId);
  const logEl = logId ? $(logId) : null;
  if (prog) prog.classList.remove('hidden');
  if (logEl) logEl.classList.add('busy');
  const t0 = Date.now();
  let stepIdx = 0;
  if (statusEl && steps && steps.length) statusEl.textContent = steps[0];
  const tick = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    if (elapsedEl) elapsedEl.textContent = s.toFixed(1) + 's';
    if (statusEl && steps && steps.length) {
      stepIdx = Math.floor(s / 2.5) % steps.length;
      statusEl.textContent = steps[stepIdx] + ` (${s.toFixed(0)}s elapsed)`;
    }
    if (logEl && logEl.classList.contains('busy')) {
      const dots = '.'.repeat(1 + Math.floor(s * 2) % 3);
      if (logEl.dataset.anim === '1') logEl.textContent = logEl.dataset.base + dots;
    }
  }, 200);
  if (logEl) { logEl.dataset.anim = '1'; logEl.dataset.base = logEl.textContent; }
  return {
    stop() {
      clearInterval(tick);
      btn.disabled = false;
      btn.innerHTML = orig;
      document.body.classList.remove('is-busy');
      if (prog) prog.classList.add('hidden');
      if (logEl) { logEl.classList.remove('busy'); logEl.dataset.anim = ''; }
    }
  };
}

function setBtnLoading(btn, loading, text) {
  if (loading) {
    btn.dataset.orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${text || 'Loading…'}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig;
  }
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// health
(async () => {
  try {
    const h = await api('/api/health');
    const ok = h.mongodump !== 'not found' && h.mongorestore !== 'not found';
    $('health').innerHTML = `<span class="dot ${ok ? 'ok' : 'bad'}"></span> mongodump: ${h.mongodump} &nbsp;|&nbsp; mongorestore: ${h.mongorestore}`;
  } catch {
    $('health').innerHTML = `<span class="dot bad"></span> backend unreachable`;
  }
})();

// inline URI validation for List databases (no alert popups)
function isValidMongoUri(uri) {
  return /^(mongodb:\/\/|mongodb\+srv:\/\/)/.test(uri);
}
function setUriError(inputId, errorId, msg) {
  const input = $(inputId);
  const err = $(errorId);
  if (!input || !err) return;
  if (!msg) {
    input.classList.remove('input-error');
    err.textContent = '';
    err.classList.add('hidden');
  } else {
    input.classList.add('input-error');
    err.textContent = msg;
    err.classList.remove('hidden');
    input.focus();
  }
}
['backup-uri', 'restore-uri'].forEach((id) => {
  $(id).addEventListener('input', () => {
    $(id).classList.remove('input-error');
    const errId = id + '-error';
    if ($(errId)) { $(errId).textContent = ''; $(errId).classList.add('hidden'); }
  });
});

// inline DB-list status: red outline + text only when none found, silent on success
function setDbError(selectId, inputId, errorId, msg) {
  const sel = $(selectId);
  const input = $(inputId);
  const err = $(errorId);
  if (!msg) {
    if (sel) sel.classList.remove('input-error');
    if (input) input.classList.remove('input-error');
    if (err) { err.textContent = ''; err.classList.add('hidden'); }
  } else {
    if (sel) sel.classList.add('input-error');
    if (input) input.classList.add('input-error');
    if (err) { err.textContent = msg; err.classList.remove('hidden'); }
  }
}
['backup-db', 'backup-db-select', 'restore-db', 'restore-db-select'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => el.classList.remove('input-error'));
  el.addEventListener('change', () => {
    el.classList.remove('input-error');
    const errId = id.startsWith('restore') ? 'restore-db-error' : 'backup-db-error';
    const otherId = id.startsWith('restore')
      ? (id === 'restore-db' ? 'restore-db-select' : 'restore-db')
      : (id === 'backup-db' ? 'backup-db-select' : 'backup-db');
    if ($(otherId)) $(otherId).classList.remove('input-error');
    if ($(errId) && !$(errId).classList.contains('hidden') && !el.classList.contains('input-error') && !($(otherId) && $(otherId).classList.contains('input-error'))) {
      // keep text until next successful list; do not auto-hide here if other field still errored
    }
  });
});

// list DBs
$('btn-list-dbs').addEventListener('click', async () => {
  const uri = $('backup-uri').value.trim();
  if (!uri) {
    setUriError('backup-uri', 'backup-uri-error', 'MongoDB URI is required. Please enter your connection string.');
    return;
  }
  if (!isValidMongoUri(uri)) {
    setUriError('backup-uri', 'backup-uri-error', 'Invalid MongoDB URI. It must start with mongodb:// or mongodb+srv://');
    return;
  }
  setUriError('backup-uri', 'backup-uri-error', null);
  setDbError('backup-db-select', 'backup-db', 'backup-db-error', null);
  setBtnLoading($('btn-list-dbs'), true, 'Loading…');
  try {
    const j = await api('/api/databases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });
    const list = j.databases || [];
    const sel = $('backup-db-select');
    if (!list.length) {
      sel.style.display = 'none';
      setDbError('backup-db-select', 'backup-db', 'backup-db-error', 'No databases found on this server.');
      return;
    }
    setDbError('backup-db-select', 'backup-db', 'backup-db-error', null);
    sel.style.display = 'block';
    sel.innerHTML = '<option value="">-- pick a database --</option>' +
      list.map((d) => `<option value="${d.name}">${d.name}</option>`).join('');
    sel.onchange = () => { $('backup-db').value = sel.value; };
  } catch (e) {
    setUriError('backup-uri', 'backup-uri-error', 'Failed: ' + e.message);
  } finally {
    setBtnLoading($('btn-list-dbs'), false);
  }
});

// list DBs (restore target)
$('btn-list-restore-dbs').addEventListener('click', async () => {
  const uri = $('restore-uri').value.trim();
  if (!uri) {
    setUriError('restore-uri', 'restore-uri-error', 'MongoDB URI is required. Please enter your connection string.');
    return;
  }
  if (!isValidMongoUri(uri)) {
    setUriError('restore-uri', 'restore-uri-error', 'Invalid MongoDB URI. It must start with mongodb:// or mongodb+srv://');
    return;
  }
  setUriError('restore-uri', 'restore-uri-error', null);
  setDbError('restore-db-select', 'restore-db', 'restore-db-error', null);
  setBtnLoading($('btn-list-restore-dbs'), true, 'Loading…');
  try {
    const j = await api('/api/databases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri })
    });
    const list = j.databases || [];
    const sel = $('restore-db-select');
    if (!list.length) {
      sel.style.display = 'none';
      setDbError('restore-db-select', 'restore-db', 'restore-db-error', 'No databases found on this server.');
      return;
    }
    setDbError('restore-db-select', 'restore-db', 'restore-db-error', null);
    sel.style.display = 'block';
    sel.innerHTML = '<option value="">-- pick a database --</option>' +
      list.map((d) => `<option value="${d.name}">${d.name}</option>`).join('');
    sel.onchange = () => { $('restore-db').value = sel.value; };
  } catch (e) {
    setUriError('restore-uri', 'restore-uri-error', 'Failed: ' + e.message);
  } finally {
    setBtnLoading($('btn-list-restore-dbs'), false);
  }
});

// backup
$('btn-backup').addEventListener('click', async () => {
  const btn = $('btn-backup');
  const job = startJob({
    btn, busyText: 'Running mongodump…',
    progressId: 'backup-progress', elapsedId: 'backup-elapsed',
    statusId: 'backup-status', logId: 'backup-log',
    steps: ['Connecting to MongoDB…', 'Running mongodump --archive…', 'Compressing & writing backup…', 'Still working — large DBs take a while…']
  });
  $('backup-result').textContent = '';
  $('backup-log').textContent = 'Running mongodump…';
  try {
    const j = await api('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri: $('backup-uri').value.trim(),
        dbName: $('backup-db').value.trim(),
        gzip: $('backup-gzip').checked,
        archiveName: $('backup-name').value.trim()
      })
    });
    $('backup-result').className = 'result ok';
    $('backup-result').textContent = `✅ Backup OK: ${j.filename} (${fmtSize(j.size)}) — see Library tab to download.`;
    $('backup-log').textContent = `$ ${j.command}\n\n${j.logs || '(no output)'}`;
    loadLibrary();
    if ($('backup-autodownload') && $('backup-autodownload').checked && j.downloadUrl) {
      const a = document.createElement('a');
      a.href = j.downloadUrl;
      a.download = j.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (e) {
    // api() throws on !ok, but backup endpoint returns JSON with logs even on 500 — try to surface logs
    $('backup-result').className = 'result err';
    $('backup-result').textContent = '❌ ' + e.message;
    $('backup-log').textContent = e.message;
  } finally {
    job.stop();
  }
});

// restore option warnings — show only when toggled
function syncRestoreWarnings() {
  $('warn-drop').classList.toggle('hidden', !$('restore-drop').checked);
  $('warn-noindex').classList.toggle('hidden', !$('restore-noindex').checked);
}
$('restore-drop').addEventListener('change', syncRestoreWarnings);
$('restore-noindex').addEventListener('change', syncRestoreWarnings);

// restore from upload
$('btn-restore-upload').addEventListener('click', async () => {
  const f = $('restore-file').files[0];
  if (!f) return alert('Choose a backup file first');
  const targetUri = $('restore-uri').value.trim();
  if (!targetUri) return alert('Enter a target URI');
  const btn = $('btn-restore-upload');
  const job = startJob({
    btn, busyText: 'Running mongorestore…',
    progressId: 'restore-progress', elapsedId: 'restore-elapsed',
    statusId: 'restore-status', logId: 'restore-log',
    steps: [`Uploading ${f.name}…`, 'Running mongorestore --archive…', 'Rebuilding collections & indexes…', 'Still working — large restores take a while…']
  });
  $('restore-log').textContent = `Uploading ${f.name} (${fmtSize(f.size)}) and restoring…`;
  try {
    const fd = new FormData();
    fd.append('backupFile', f);
    fd.append('targetUri', targetUri);
    fd.append('dbName', $('restore-db').value.trim());
    fd.append('drop', $('restore-drop').checked);
    fd.append('noIndexRestore', $('restore-noindex').checked);
    fd.append('gzip', 'auto');
    const r = await fetch('/api/restore', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j.error || 'Restore failed') + '\n\n' + (j.logs || ''));
    $('restore-result').className = 'result ok';
    $('restore-result').textContent = '✅ Restore completed';
    $('restore-log').textContent = `$ ${j.command}\n\n${j.logs || '(no output)'}`;
  } catch (e) {
    $('restore-result').className = 'result err';
    $('restore-result').textContent = '❌ Restore failed';
    $('restore-log').textContent = String(e.message).slice(0, 8000);
  } finally {
    job.stop();
  }
});

// restore from server
async function loadServerFiles() {
  try {
    const j = await api('/api/backups');
    $('restore-server-file').innerHTML = j.backups.length
      ? j.backups.map((b) => `<option value="${b.filename}">${b.filename} (${fmtSize(b.size)})</option>`).join('')
      : '<option value="">(no backups on server)</option>';
  } catch {
    $('restore-server-file').innerHTML = '<option value="">(failed to load)</option>';
  }
}

$('btn-restore-server').addEventListener('click', async () => {
  const filename = $('restore-server-file').value;
  if (!filename) return alert('No server backup selected');
  const btn = $('btn-restore-server');
  const job = startJob({
    btn, busyText: 'Restoring…',
    progressId: 'restore-progress', elapsedId: 'restore-elapsed',
    statusId: 'restore-status', logId: 'restore-log',
    steps: [`Restoring ${filename}…`, 'Running mongorestore --archive…', 'Rebuilding collections & indexes…', 'Still working…']
  });
  $('restore-log').textContent = `Restoring ${filename}…`;
  try {
    const j = await api('/api/restore-server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        targetUri: $('restore-uri').value.trim(),
        dbName: $('restore-db').value.trim(),
        drop: $('restore-drop').checked,
        noIndexRestore: $('restore-noindex').checked
      })
    });
    $('restore-result').className = 'result ok';
    $('restore-result').textContent = '✅ Restore completed from ' + filename;
    $('restore-log').textContent = `$ ${j.command}\n\n${j.logs || '(no output)'}`;
  } catch (e) {
    $('restore-result').className = 'result err';
    $('restore-result').textContent = '❌ ' + e.message;
    $('restore-log').textContent = String(e.message).slice(0, 8000);
  } finally {
    job.stop();
  }
});

// library
function getSelectedFiles() {
  return [...document.querySelectorAll('.lib-check:checked')].map((c) => c.value);
}
function syncBulkBar() {
  const n = getSelectedFiles().length;
  $('btn-bulk-download').disabled = n === 0;
  $('btn-bulk-delete').disabled = n === 0;
  $('lib-selected-count').textContent = n ? `${n} selected` : '';
  const all = $('lib-select-all');
  const boxes = [...document.querySelectorAll('.lib-check')];
  if (all && boxes.length) {
    all.checked = boxes.every((c) => c.checked);
    all.indeterminate = boxes.some((c) => c.checked) && !all.checked;
  }
}
async function loadLibrary() {
  const body = $('library-body');
  try {
    const j = await api('/api/backups');
    if (!j.backups.length) {
      body.innerHTML = '<tr><td colspan="6">No backups yet. Create one from the Backup tab.</td></tr>';
      syncBulkBar();
      return;
    }
    body.innerHTML = j.backups.map((b) => `<tr>
      <td><input type="checkbox" class="lib-check" value="${b.filename}" /></td>
      <td><code>${b.filename}</code></td>
      <td>${b.database || '—'}</td>
      <td>${fmtSize(b.size)}</td>
      <td>${new Date(b.modified).toLocaleString()}</td>
      <td>
        <a class="btn secondary" href="/api/backups/${encodeURIComponent(b.filename)}">Download</a>
        <button class="btn secondary" data-del="${b.filename}">Delete</button>
      </td></tr>`).join('');
    body.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete ' + btn.dataset.del + '?')) return;
        await fetch('/api/backups/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
        loadLibrary();
        loadServerFiles();
      });
    });
    body.querySelectorAll('.lib-check').forEach((c) => c.addEventListener('change', syncBulkBar));
    syncBulkBar();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6">Failed to load: ${e.message}</td></tr>`;
  }
}
$('lib-select-all').addEventListener('change', () => {
  const checked = $('lib-select-all').checked;
  document.querySelectorAll('.lib-check').forEach((c) => { c.checked = checked; });
  syncBulkBar();
});
$('btn-bulk-delete').addEventListener('click', async () => {
  const files = getSelectedFiles();
  if (!files.length) return;
  if (!confirm(`Delete ${files.length} backup(s)?\n${files.join('\n')}`)) return;
  const btn = $('btn-bulk-delete');
  setBtnLoading(btn, true, 'Deleting…');
  try {
    for (const f of files) {
      await fetch('/api/backups/' + encodeURIComponent(f), { method: 'DELETE' });
    }
    loadLibrary();
    loadServerFiles();
  } finally {
    setBtnLoading(btn, false);
    $('btn-bulk-delete').textContent = '🗑 Delete selected';
  }
});
$('btn-bulk-download').addEventListener('click', () => {
  const files = getSelectedFiles();
  if (!files.length) return;
  // Trigger one download per file (browser will save each)
  files.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = '/api/backups/' + encodeURIComponent(f);
      a.download = f;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 600);
  });
});
$('btn-refresh').addEventListener('click', loadLibrary);
loadLibrary();
loadServerFiles();
