// Authenticated Personal HQ task sync. No sign-up flow is provided.
(() => {
  const cfg = window.PERSONAL_HQ_SYNC_CONFIG || {};
  const sdkPath = 'vendor/supabase-js-2.119.1.js';
  const baseKey = 'personal-hq-private-sync-v1';
  const activeUserKey = `${baseKey}:active-user`;
  const accountTasksKey = userId => `${baseKey}:tasks:${userId}`;
  const forgetTokenKey = userId => `${baseKey}:forget-token:${userId}`;
  const table = 'personal_hq_tasks';
  const selectFields = 'task_id,title,area,due,status,next_action,notes,owner_label,source,created_at,updated_at,revision,deleted_at';
  let client = null;
  let user = null;
  let applyingRemote = false;
  let busy = false;
  let debounceTimer = null;
  let pollTimer = null;
  let shadow = {};
  let pendingImports = new Set();
  let conflicts = new Map();
  let pendingConflictIds = new Set();
  let metaKey = '';
  let forgettingUserId = null;
  let forgetTokenAtSignIn = '';

  const removalRequested = userId => !!userId && (localStorage.getItem(forgetTokenKey(userId)) || '') !== forgetTokenAtSignIn;

  const configReady = () => /^https:\/\//.test(cfg.url || '') && typeof cfg.publishableKey === 'string' && cfg.publishableKey.length > 10;
  const byId = id => document.getElementById(id);
  const statusText = (message, isError = false) => {
    for (const el of [byId('privateSyncState'), byId('privateSyncPanelState')]) {
      if (!el) continue;
      el.textContent = message;
      el.dataset.state = isError ? 'error' : 'normal';
    }
    const dialog = byId('privateSyncDialog');
    const isRoutine = /^syncing tasks(?:…|\.\.\.)?$/i.test(message.trim()) || /checking tasks\.$/i.test(message.trim());
    if (!dialog?.open && !isRoutine) window.announcePersonalHQSyncStatus?.('Private cloud sync', message);
  };
  const getTasks = () => Array.isArray(window.getPersonalHQTasks?.()) ? window.getPersonalHQTasks() : [];
  const localFields = task => ({
    title: String(task.title || ''),
    area: String(task.area || ''),
    due: task.due || null,
    status: String(task.status || 'Not started'),
    next_action: String(task.nextAction || ''),
    notes: String(task.notes || ''),
    owner_label: String(task.owner || ''),
    source: String(task.source || '')
  });
  const remoteFields = row => ({
    title: String(row.title || ''),
    area: String(row.area || ''),
    due: row.due || null,
    status: String(row.status || 'Not started'),
    next_action: String(row.next_action || ''),
    notes: String(row.notes || ''),
    owner_label: String(row.owner_label || ''),
    source: String(row.source || '')
  });
  const sameFields = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fromRemote = (row, old = {}) => ({
    ...old,
    id: row.task_id,
    title: row.title,
    area: row.area,
    due: row.due || '',
    status: row.status,
    nextAction: row.next_action || '',
    notes: row.notes || '',
    owner: row.owner_label || 'Varun',
    source: row.source || 'Personal HQ cloud',
    revision: String(row.revision),
    preservePrivateNotes: false
  });
  const shadowOf = row => ({ revision: String(row.revision), deletedAt: row.deleted_at || null, fields: remoteFields(row) });
  const readJson = key => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  };
  const saveMeta = () => {
    if (!metaKey) return;
    localStorage.setItem(metaKey, JSON.stringify({ shadow, pendingImports: [...pendingImports], conflictIds: [...new Set([...pendingConflictIds, ...conflicts.keys()])] }));
  };
  const applyTasks = tasks => {
    applyingRemote = true;
    try { window.replacePersonalHQTasks?.(tasks); }
    finally {
      applyingRemote = false;
      if (user) localStorage.setItem(accountTasksKey(user.id), JSON.stringify(getTasks()));
    }
  };
  const seedTasks = () => window.getPersonalHQSeedTasks?.() || [];
  const cacheAccountTasks = userId => {
    if (userId) localStorage.setItem(accountTasksKey(userId), JSON.stringify(getTasks()));
  };
  const activateAccountTasks = userId => {
    const previousUserId = localStorage.getItem(activeUserKey);
    if (previousUserId === userId) return;
    if (previousUserId && previousUserId !== userId) cacheAccountTasks(previousUserId);
    const savedTasks = readJson(accountTasksKey(userId));
    if (Array.isArray(savedTasks)) applyTasks(savedTasks);
    else if (previousUserId && previousUserId !== userId) applyTasks(seedTasks());
    localStorage.setItem(activeUserKey, userId);
  };
  const renderConflicts = () => {
    const list = byId('privateSyncConflicts');
    const importButton = byId('privateSyncImportButton');
    const migration = byId('privateSyncMigration');
    const backupButton = byId('privateSyncBackup');
    if (!list || !importButton || !migration) return;
    list.replaceChildren();
    importButton.hidden = pendingImports.size === 0;
    importButton.textContent = `Upload ${pendingImports.size} browser-only task${pendingImports.size === 1 ? '' : 's'}`;
    migration.hidden = pendingImports.size === 0;
    if (pendingImports.size) {
      const tasks = getTasks().filter(task => pendingImports.has(task.id));
      const summary = document.createElement('p');
      summary.textContent = `${tasks.length} browser-only task${tasks.length === 1 ? '' : 's'} are ready to upload. The upload includes task notes. Review the titles below and make an encrypted backup first if you want a recovery copy.`;
      const preview = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = `Preview ${tasks.length} task titles`;
      const titles = document.createElement('ul');
      for (const task of tasks.slice(0, 8)) {
        const item = document.createElement('li');
        item.textContent = task.title || task.id;
        titles.append(item);
      }
      if (tasks.length > 8) {
        const item = document.createElement('li');
        item.textContent = `And ${tasks.length - 8} more task titles`;
        titles.append(item);
      }
      preview.append(heading, titles);
      migration.replaceChildren(summary, preview);
    } else migration.replaceChildren();
    if (backupButton) backupButton.hidden = false;
    for (const [id, item] of conflicts) {
      const card = document.createElement('article');
      card.className = 'sync-conflict';
      const title = document.createElement('strong');
      title.textContent = item.local?.title || item.row?.title || id;
      const detail = document.createElement('p');
      detail.textContent = `Cloud revision ${item.row ? item.row.revision : 'missing'}; this browser has a different copy. Choose which version to keep.`;
      const compare = document.createElement('details');
      compare.className = 'sync-conflict-compare';
      const compareHeading = document.createElement('summary');
      compareHeading.textContent = 'Compare browser and cloud copies';
      const values = document.createElement('dl');
      const fields = [
        ['Title', item.local?.title, item.row?.title],
        ['Area', item.local?.area, item.row?.area],
        ['Due date', item.local?.due, item.row?.due],
        ['Status', item.local?.status, item.row?.status],
        ['Next action', item.local?.nextAction, item.row?.next_action],
        ['Private notes', item.local?.notes, item.row?.notes]
      ];
      for (const [label, localValue, cloudValue] of fields) {
        const term = document.createElement('dt');
        term.textContent = label;
        const local = document.createElement('dd');
        local.textContent = `This browser: ${localValue || '(empty)'}`;
        const cloud = document.createElement('dd');
        cloud.textContent = item.row?.deleted_at ? 'Cloud: deleted' : `Cloud: ${cloudValue || (item.row ? '(empty)' : 'task missing')}`;
        values.append(term, local, cloud);
      }
      compare.append(compareHeading, values);
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      if (item.row) {
        const useCloud = document.createElement('button');
        useCloud.type = 'button';
        useCloud.className = 'secondary';
        useCloud.textContent = item.row.deleted_at ? 'Accept cloud deletion' : 'Use cloud version';
        useCloud.addEventListener('click', () => resolveConflict(id, 'cloud'));
        actions.append(useCloud);
      }
      const useLocal = document.createElement('button');
      useLocal.type = 'button';
      useLocal.className = 'primary';
      useLocal.textContent = 'Keep this browser version';
      useLocal.addEventListener('click', () => resolveConflict(id, 'local'));
      actions.append(useLocal);
      card.append(title, detail, compare, actions);
      list.append(card);
    }
  };
  const renderSession = () => {
    const login = byId('privateSyncForm');
    const signedIn = byId('privateSyncSignedIn');
    const configNotice = byId('privateSyncConfigNotice');
    const connect = byId('privateSyncButton');
    if (configNotice) configNotice.hidden = configReady();
    if (login) login.hidden = !configReady() || !!user;
    if (signedIn) signedIn.hidden = !user;
    if (connect) connect.textContent = user ? 'Cloud sync' : 'Private sync';
    if (user) statusText(`Connected as ${user.email || 'owner'} · checking tasks. Routines stay local.`);
    else if (configReady()) statusText('Local only · not signed in. Changes stay in this browser.');
    else statusText('Local only · not connected. Changes stay in this browser.');
    renderConflicts();
  };

  async function loadSdk() {
    if (window.supabase?.createClient) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = sdkPath;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the local Supabase client.'));
      document.head.append(script);
    });
    if (!window.supabase?.createClient) throw new Error('The Supabase client did not initialize.');
  }

  async function ensureClient() {
    if (!configReady()) throw new Error('Private sync is not configured yet. Add the Supabase project URL and publishable key to supabase-config.js after owner setup.');
    if (client) return client;
    await loadSdk();
    client = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    const sessionUser = data.session?.user || null;
    if (sessionUser) activateAccountTasks(sessionUser.id);
    user = sessionUser;
    forgetTokenAtSignIn = user ? (localStorage.getItem(forgetTokenKey(user.id)) || '') : '';
    if (user) {
      metaKey = `${baseKey}:${user.id}`;
      const meta = readJson(metaKey) || {};
      shadow = meta.shadow || {};
      pendingImports = new Set(Array.isArray(meta.pendingImports) ? meta.pendingImports : []);
      pendingConflictIds = new Set(Array.isArray(meta.conflictIds) ? meta.conflictIds : []);
    }
    client.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user || null;
      if (!nextUser) {
        const previousUserId = user?.id || localStorage.getItem(activeUserKey);
        const forgetLocalData = previousUserId && (forgettingUserId === previousUserId || removalRequested(previousUserId));
        if (user?.id && !forgetLocalData) cacheAccountTasks(user.id);
        user = null;
        forgetTokenAtSignIn = '';
        shadow = {};
        pendingImports = new Set();
        conflicts.clear();
        pendingConflictIds = new Set();
        metaKey = '';
        if (previousUserId) {
          localStorage.removeItem(activeUserKey);
          if (forgetLocalData) {
            localStorage.removeItem(accountTasksKey(previousUserId));
            localStorage.removeItem(`${baseKey}:${previousUserId}`);
            localStorage.removeItem(`${baseKey}:initialized:${previousUserId}`);
            localStorage.removeItem('varun-hq-v1');
            forgettingUserId = null;
          }
          applyTasks(seedTasks());
        }
      } else {
        if (user?.id && user.id !== nextUser.id) {
          shadow = {};
          pendingImports = new Set();
          conflicts.clear();
          pendingConflictIds = new Set();
        }
        user = nextUser;
        activateAccountTasks(user.id);
        forgetTokenAtSignIn = localStorage.getItem(forgetTokenKey(user.id)) || '';
        metaKey = `${baseKey}:${user.id}`;
        const meta = readJson(metaKey) || {};
        shadow = meta.shadow || {};
        pendingImports = new Set(Array.isArray(meta.pendingImports) ? meta.pendingImports : []);
        pendingConflictIds = new Set(Array.isArray(meta.conflictIds) ? meta.conflictIds : []);
      }
      renderSession();
      if (user) setTimeout(() => synchronize().catch(showError), 0);
    });
    return client;
  }

  const readCloud = async () => {
    const { data, error } = await client.from(table).select(selectFields).order('task_id');
    if (error) throw error;
    return data || [];
  };
  const writeCloud = async (task, expectedRevision, action = 'save') => {
    const f = localFields(task);
    const args = { p_task_id: task.id, p_expected_revision: String(expectedRevision) };
    let fn = 'save_personal_hq_task';
    if (action === 'save') Object.assign(args, {
      p_title: f.title, p_area: f.area, p_due: f.due,
      p_status: f.status, p_next_action: f.next_action, p_notes: f.notes,
      p_owner_label: f.owner_label, p_source: f.source
    });
    else if (action === 'restore') fn = 'restore_personal_hq_task';
    const { data, error } = await client.rpc(fn, args);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  };
  const hasConflict = id => conflicts.has(id);
  const setConflict = (id, local, row) => conflicts.set(id, { local: local ? { ...local } : null, row: row ? { ...row } : null });

  async function syncInitial(remote, local) {
    const next = [...local];
    const byTask = new Map(next.map(task => [task.id, task]));
    const remoteIds = new Set(remote.map(row => row.task_id));
    if (!remote.length) {
      pendingImports = new Set(local.map(task => task.id));
      saveMeta();
      renderConflicts();
      statusText(`Cloud has no tasks yet. Import ${pendingImports.size} tasks from this browser to start private sync.`);
      return;
    }
    for (const row of remote) {
      const existing = byTask.get(row.task_id);
      shadow[row.task_id] = shadowOf(row);
      if (!existing) {
        if (!row.deleted_at) {
          const task = fromRemote(row);
          next.push(task);
          byTask.set(task.id, task);
        }
      } else if (row.deleted_at || !sameFields(localFields(existing), remoteFields(row))) {
        const conflictLocal = { ...existing, revision: String(row.revision) };
        next[next.findIndex(item => item.id === row.task_id)] = conflictLocal;
        setConflict(row.task_id, conflictLocal, row);
      } else {
        const task = fromRemote(row, existing);
        next[next.findIndex(item => item.id === row.task_id)] = task;
        byTask.set(row.task_id, task);
      }
    }
    pendingImports = new Set(local.filter(task => !remoteIds.has(task.id)).map(task => task.id));
    saveMeta();
    if (next.length !== local.length || next.some((task, index) => task !== local[index])) applyTasks(next);
    renderConflicts();
    statusText(`Compared ${remote.length} cloud tasks. ${conflicts.size} conflict${conflicts.size === 1 ? '' : 's'} need a choice; browser-only tasks await your import.`);
  }

  async function synchronize() {
    if (!user || busy || removalRequested(user.id)) return;
    busy = true;
    statusText('Syncing tasks…');
    try {
      const [remote, local] = await Promise.all([readCloud(), Promise.resolve(getTasks())]);
      const remoteById = new Map(remote.map(row => [row.task_id, row]));
      const localById = new Map(local.map(task => [task.id, task]));
      for (const id of pendingConflictIds) {
        const localTask = localById.get(id) || null;
        const row = remoteById.get(id) || null;
        if (localTask || row) setConflict(id, localTask, row);
        else pendingConflictIds.delete(id);
      }
      const baselineReady = conflicts.size > 0 || Object.keys(shadow).length > 0 || localStorage.getItem(`${baseKey}:initialized:${user.id}`) === 'true';
      if (!baselineReady) {
        await syncInitial(remote, local);
        if (remote.length) localStorage.setItem(`${baseKey}:initialized:${user.id}`, 'true');
        return;
      }

      const seen = new Set();
      const next = [...local];
      const indexById = new Map(next.map((task, index) => [task.id, index]));
      const writes = [];
      let revisionChanged = false;
      for (const row of remote) {
        const id = row.task_id;
        seen.add(id);
        const localTask = localById.get(id);
        const base = shadow[id];
        if (!base) {
          if (localTask && pendingImports.has(id) && !row.deleted_at && sameFields(localFields(localTask), remoteFields(row))) {
            shadow[id] = shadowOf(row);
            pendingImports.delete(id);
            localTask.revision = String(row.revision);
            revisionChanged = true;
          } else if (localTask) {
            localTask.revision = String(row.revision);
            revisionChanged = true;
            setConflict(id, localTask, row);
          }
          else if (!row.deleted_at) {
            const remoteTask = fromRemote(row);
            indexById.set(id, next.length);
            next.push(remoteTask);
            localById.set(id, remoteTask);
            shadow[id] = shadowOf(row);
          } else shadow[id] = shadowOf(row);
          continue;
        }
        if (localTask && String(localTask.revision || '') !== String(row.revision)) {
          localTask.revision = String(row.revision);
          revisionChanged = true;
        }
        if (hasConflict(id)) continue;
        if (!localTask) {
          if (row.deleted_at && base.deletedAt) {
            shadow[id] = shadowOf(row);
            continue;
          }
          setConflict(id, null, row);
          continue;
        }
        const localChanged = !sameFields(localFields(localTask), base.fields);
        const cloudChanged = String(row.revision) !== String(base.revision);
        if (row.deleted_at) {
          if (localChanged || !base.deletedAt) setConflict(id, localTask, row);
          else shadow[id] = shadowOf(row);
        } else if (cloudChanged && localChanged && !sameFields(localFields(localTask), remoteFields(row))) {
          setConflict(id, localTask, row);
        } else if (cloudChanged) {
          const updated = fromRemote(row, localTask);
          next[indexById.get(id)] = updated;
          localById.set(id, updated);
          shadow[id] = shadowOf(row);
        } else if (localChanged) {
          writes.push({ task: localTask, revision: base.revision });
        }
      }
      for (const task of local) {
        if (seen.has(task.id) || pendingImports.has(task.id) || hasConflict(task.id)) continue;
        if (shadow[task.id]) setConflict(task.id, task, null);
        else writes.push({ task, revision: '0' });
      }
      if (next.length !== local.length || next.some((task, index) => task !== local[index]) || revisionChanged) applyTasks(next);
      if (conflicts.size) {
        saveMeta();
        renderConflicts();
        statusText(`${conflicts.size} task conflict${conflicts.size === 1 ? '' : 's'} found. No cloud writes were made; choose a version in Cloud sync.`);
        return;
      }
      revisionChanged = false;
      for (const write of writes) {
        const saved = await writeCloud(write.task, write.revision);
        if (!saved) {
          const latest = (await readCloud()).find(row => row.task_id === write.task.id) || null;
          setConflict(write.task.id, write.task, latest);
          continue;
        }
        if (String(write.task.revision || '') !== String(saved.revision)) {
          write.task.revision = String(saved.revision);
          revisionChanged = true;
        }
        shadow[write.task.id] = { revision: String(saved.revision), deletedAt: null, fields: localFields(write.task) };
      }
      if (revisionChanged) applyTasks(getTasks());
      saveMeta();
      renderConflicts();
      if (conflicts.size) statusText(`${conflicts.size} task conflict${conflicts.size === 1 ? '' : 's'} need a choice.`);
      else if (pendingImports.size) statusText(`${pendingImports.size} browser-only task${pendingImports.size === 1 ? '' : 's'} still await import. Routines remain local.`);
      else {
        const currentTasks = getTasks();
        const currentIds = new Set(currentTasks.map(task => task.id));
        const hasPendingChanges = currentTasks.some(task => !pendingImports.has(task.id) && (!shadow[task.id] || !sameFields(localFields(task), shadow[task.id].fields))) || Object.keys(shadow).some(id => !currentIds.has(id) && !shadow[id].deletedAt);
        statusText(hasPendingChanges
          ? 'Pending changes · saved here; waiting to sync.'
          : `Synced at ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' }).format(new Date())} IST. Routines remain local.`);
      }
    } finally {
      busy = false;
    }
  }

  async function importLocalTasks() {
    if (!user || busy) return;
    const current = getTasks();
    const candidates = current.filter(task => pendingImports.has(task.id));
    if (!candidates.length) return;
    if (!window.confirm(`Upload ${candidates.length} task records, including their private notes, from this browser to your authenticated private database? Review the task-title preview first. Create an encrypted backup beforehand if you want a recovery copy. Continue?`)) return;
    busy = true;
    try {
      for (const task of candidates) {
        const saved = await writeCloud(task, '0');
        if (!saved) {
          const latest = (await readCloud()).find(row => row.task_id === task.id) || null;
          if (latest) setConflict(task.id, task, latest);
          else throw new Error(`Could not import task ${task.id}.`);
        } else {
          task.revision = String(saved.revision);
          shadow[task.id] = { revision: String(saved.revision), deletedAt: null, fields: localFields(task) };
          pendingImports.delete(task.id);
          cacheAccountTasks(user.id);
          window.persistPersonalHQTasks?.();
          saveMeta();
          statusText(`Imported ${candidates.length - pendingImports.size} of ${candidates.length} tasks. Keep this browser open until the import finishes.`);
        }
      }
      applyTasks(getTasks());
      saveMeta();
      renderConflicts();
      statusText(conflicts.size ? 'Import paused where a task ID already exists in cloud; review the conflict.' : `Imported ${candidates.length} tasks. Private sync is active for task edits.`);
    } finally { busy = false; }
  }

  async function resolveConflict(id, choice) {
    if (busy) return;
    const conflict = conflicts.get(id);
    if (!conflict) return;
    busy = true;
    try {
      const tasks = [...getTasks()];
      const at = tasks.findIndex(task => task.id === id);
      if (choice === 'cloud') {
        if (conflict.row && !conflict.row.deleted_at) {
          const copy = fromRemote(conflict.row, at >= 0 ? tasks[at] : {});
          if (at >= 0) tasks[at] = copy; else tasks.push(copy);
        } else if (at >= 0) tasks.splice(at, 1);
        if (conflict.row) shadow[id] = shadowOf(conflict.row);
        pendingImports.delete(id);
      } else {
        const local = at >= 0 ? tasks[at] : conflict.local;
        if (!local) throw new Error('The browser copy is no longer available.');
        const action = conflict.row?.deleted_at ? 'restore' : 'save';
        let saved = await writeCloud(local, conflict.row?.revision || '0', action);
        if (action === 'restore' && saved) saved = await writeCloud(local, saved.revision, 'save');
        if (!saved) throw new Error('The cloud task changed again. Sync and review the new conflict.');
        const verified = (await readCloud()).find(row => row.task_id === id);
        if (!verified || verified.deleted_at || !sameFields(localFields(local), remoteFields(verified))) {
          throw new Error('The cloud did not confirm this browser version. Sync again and review the conflict.');
        }
        const syncedLocal = { ...local, revision: String(verified.revision), preservePrivateNotes: false };
        if (at >= 0) tasks[at] = syncedLocal;
        else tasks.push(syncedLocal);
        shadow[id] = shadowOf(verified);
        pendingImports.delete(id);
      }
      conflicts.delete(id);
      pendingConflictIds.delete(id);
      saveMeta();
      applyTasks(tasks);
      renderConflicts();
      statusText('Conflict resolved. Other tasks are syncing.');
      busy = false;
      await synchronize();
    } catch (error) { showError(error); }
    finally { busy = false; }
  }

  async function forgetLocalAccountData() {
    if (!user || !client) return;
    if (busy) {
      statusText('Wait for the current sync or import to finish before removing local account data.');
      return;
    }
    const userId = user.id;
    const localTasks = getTasks();
    const localTaskCount = localTasks.length;
    const localIds = new Set(localTasks.map(task => task.id));
    const pendingTaskIds = new Set([...pendingImports, ...conflicts.keys()]);
    for (const task of localTasks) {
      if (!shadow[task.id] || !sameFields(localFields(task), shadow[task.id].fields)) pendingTaskIds.add(task.id);
    }
    for (const id of Object.keys(shadow)) {
      if (!localIds.has(id) && !shadow[id].deletedAt) pendingTaskIds.add(id);
    }
    const pendingCount = pendingTaskIds.size;
    const confirmed = window.confirm(
      `Remove this account's data from this device? This deletes ${localTaskCount} locally stored task records (${pendingCount} pending or conflicting), sync metadata, and any pending edits, then signs out. It does not delete cloud tasks or encrypted backup files. If you need pending edits, cancel and create an encrypted backup first. Continue?`
    );
    if (!confirmed) return;
    busy = true;
    forgettingUserId = userId;
    const previousForgetToken = localStorage.getItem(forgetTokenKey(userId)) || '';
    localStorage.setItem(forgetTokenKey(userId), `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      if (user?.id === userId) {
        user = null;
        forgetTokenAtSignIn = '';
        shadow = {};
        pendingImports = new Set();
        conflicts.clear();
        pendingConflictIds = new Set();
        metaKey = '';
        localStorage.removeItem(activeUserKey);
        localStorage.removeItem(accountTasksKey(userId));
        localStorage.removeItem(`${baseKey}:${userId}`);
        localStorage.removeItem(`${baseKey}:initialized:${userId}`);
        localStorage.removeItem('varun-hq-v1');
        applyTasks(seedTasks());
        forgettingUserId = null;
        renderSession();
      }
      statusText(`Removed ${localTaskCount} local task records for this account, including ${pendingCount} pending or conflicting task${pendingCount === 1 ? '' : 's'}. Cloud tasks were not deleted.`);
    } catch (error) {
      forgettingUserId = null;
      if (user?.id === userId) {
        localStorage.setItem(forgetTokenKey(userId), previousForgetToken);
        forgetTokenAtSignIn = previousForgetToken;
      }
      showError(error);
    } finally { busy = false; }
  }

  function showError(error) { statusText(error?.message || 'Private sync could not complete.', true); }
  function openDialog() {
    const dialog = byId('privateSyncDialog');
    if (!dialog?.open) dialog?.showModal();
    renderSession();
  }
  async function signIn(event) {
    event.preventDefault();
    try {
      const supabase = await ensureClient();
      const email = byId('privateSyncEmail').value.trim();
      const password = byId('privateSyncPassword').value;
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      byId('privateSyncPassword').value = '';
      statusText('Signed in. Comparing cloud tasks with this browser before any upload.');
      await synchronize();
    } catch (error) { showError(error); }
  }
  function init() {
    byId('privateSyncButton')?.addEventListener('click', openDialog);
    byId('privateSyncClose')?.addEventListener('click', () => byId('privateSyncDialog')?.close());
    byId('privateSyncForm')?.addEventListener('submit', signIn);
    byId('privateSyncNow')?.addEventListener('click', () => synchronize().catch(showError));
    byId('privateSyncImportButton')?.addEventListener('click', () => importLocalTasks().catch(showError));
    byId('privateSyncBackup')?.addEventListener('click', () => window.backupEncrypted?.());
    byId('privateSyncForget')?.addEventListener('click', forgetLocalAccountData);
    byId('privateSyncSignOut')?.addEventListener('click', async () => {
      try { if (client) { const { error } = await client.auth.signOut(); if (error) throw error; } }
      catch (error) { showError(error); }
    });
    renderSession();
    if (!configReady()) return;
    ensureClient().then(() => {
      renderSession();
      if (user) synchronize().catch(showError);
    }).catch(showError);
    pollTimer = setInterval(() => { if (user) synchronize().catch(showError); }, 30000);
  }

  window.PersonalHQPrivateSync = {
    init,
    onLocalChange() {
      if (!user || applyingRemote || removalRequested(user.id)) return;
      cacheAccountTasks(user.id);
      if (!Object.keys(shadow).length || pendingImports.size || conflicts.size) return;
      const tasks = getTasks();
      const localById = new Set(tasks.map(task => task.id));
      const dirty = tasks.some(task => !pendingImports.has(task.id) && (!shadow[task.id] || !sameFields(localFields(task), shadow[task.id].fields))) || Object.keys(shadow).some(id => !localById.has(id) && !shadow[id].deletedAt);
      if (!dirty) return;
      statusText('Pending changes · saved here; waiting to sync.');
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => synchronize().catch(showError), 650);
    },
    open: openDialog,
    isAuthenticated: () => !!user
  };
})();
