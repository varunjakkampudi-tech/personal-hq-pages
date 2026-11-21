// Authenticated Personal HQ task sync. No sign-up flow is provided.
(() => {
  const cfg = window.PERSONAL_HQ_SYNC_CONFIG || {};
  const sdkPath = 'vendor/supabase-js-2.119.1.js';
  const baseKey = 'personal-hq-private-sync-v1';
  const activeUserKey = `${baseKey}:active-user`;
  const signedOutLifestyleKey = `${baseKey}:signed-out-lifestyle`;
  const accountTasksKey = userId => `${baseKey}:tasks:${userId}`;
  const accountActivityKey = userId => `${baseKey}:activity:${userId}`;
  const accountLifestyleKey = userId => `${baseKey}:lifestyle:${userId}`;
  const forgetTokenKey = userId => `${baseKey}:forget-token:${userId}`;
  const table = 'personal_hq_tasks';
  const lifestyleTable = 'personal_hq_lifestyle_state';
  const lifestyleSelectFields = 'schema_version,state,updated_at,revision';
  const selectFields = 'task_id,title,area,due,status,next_action,notes,owner_label,source,created_at,updated_at,revision,deleted_at';
  const activityFields = 'event_id,task_id,task_title,area,occurred_at,action,changed_fields,previous_status,status,task_revision';
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
  let lifestyleShadow = null;
  let pendingLifestyleImport = false;
  let lifestyleNeedsChoice = false;
  let lifestyleConflict = null;
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
  const lifestyleStatusText = (message, isError = false) => {
    const el = byId('privateSyncLifestyleState');
    if (el) {
      el.textContent = message;
      el.dataset.state = isError ? 'error' : 'normal';
    }
  };
  const getTasks = () => Array.isArray(window.getPersonalHQTasks?.()) ? window.getPersonalHQTasks() : [];
  const getLifestyle = () => window.getPersonalHQLifestyleState?.() || { schemaVersion: 1, habits: [], habitLog: {}, moments: [] };
  const normalizeLifestyle = value => {
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1 ||
        !Array.isArray(value.habits) || !value.habitLog || typeof value.habitLog !== 'object' || Array.isArray(value.habitLog) ||
        !Array.isArray(value.moments)) throw new Error('Routine and life-log data has an unsupported shape. Keep the local copy and export an encrypted backup before changing anything.');
    const state = {
      schemaVersion: 1,
      habits: value.habits.map(habit => {
        if (!habit || typeof habit.name !== 'string' || habit.name.length > 240) throw new Error('A routine name is invalid or too long.');
        return { name: habit.name };
      }),
      habitLog: {},
      moments: value.moments.map(moment => {
        if (!moment || typeof moment.id !== 'string' || moment.id.length > 120 ||
            typeof moment.title !== 'string' || moment.title.length > 140 ||
            typeof moment.kind !== 'string' || moment.kind.length > 40 ||
            typeof moment.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(moment.date) ||
            typeof (moment.note || '') !== 'string' || (moment.note || '').length > 1000 ||
            typeof (moment.createdAt || '') !== 'string' || (moment.createdAt || '').length > 40) {
          throw new Error('A life-log entry is invalid. Keep the local copy and export an encrypted backup before changing anything.');
        }
        return { id: moment.id, title: moment.title, kind: moment.kind, date: moment.date, note: moment.note || '', createdAt: moment.createdAt || '' };
      })
    };
    for (const [date, checks] of Object.entries(value.habitLog)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('A routine check-in is invalid.');
      const clean = {};
      for (const [index, complete] of Object.entries(checks)) {
        if (!/^\d{1,3}$/.test(index) || typeof complete !== 'boolean') throw new Error('A routine check-in is invalid.');
        clean[index] = complete;
      }
      state.habitLog[date] = clean;
    }
    if (new TextEncoder().encode(JSON.stringify({ habits: state.habits, habitLog: state.habitLog, moments: state.moments })).length > 1048576) {
      throw new Error('Routine and life-log data exceeds the 1 MB private sync limit. Export an encrypted backup and keep this local copy.');
    }
    return state;
  };
  const lifestylePayload = value => {
    const state = normalizeLifestyle(value);
    return { habits: state.habits, habitLog: state.habitLog, moments: state.moments };
  };
  const sameLifestyle = (a, b) => JSON.stringify(lifestylePayload(a)) === JSON.stringify(lifestylePayload(b));
  const lifestyleHasEntries = value => Object.keys(value?.habitLog || {}).length > 0 || (value?.moments || []).length > 0 || JSON.stringify(value?.habits || []) !== JSON.stringify(seedLifestyle().habits);
  const seedLifestyle = () => normalizeLifestyle(window.getPersonalHQSeedLifestyleState?.() || { schemaVersion: 1, habits: [], habitLog: {}, moments: [] });
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
    localStorage.setItem(metaKey, JSON.stringify({
      shadow,
      pendingImports: [...pendingImports],
      conflictIds: [...new Set([...pendingConflictIds, ...conflicts.keys()])],
      lifestyleShadow,
      pendingLifestyleImport,
      lifestyleNeedsChoice
    }));
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
  const applyLifestyle = value => {
    const safe = normalizeLifestyle(value);
    applyingRemote = true;
    try { window.replacePersonalHQLifestyleState?.(safe); }
    finally {
      applyingRemote = false;
      if (user) localStorage.setItem(accountLifestyleKey(user.id), JSON.stringify(getLifestyle()));
    }
  };
  const cacheAccountTasks = userId => {
    if (userId) localStorage.setItem(accountTasksKey(userId), JSON.stringify(getTasks()));
  };
  const cacheAccountLifestyle = userId => {
    if (userId) localStorage.setItem(accountLifestyleKey(userId), JSON.stringify(normalizeLifestyle(getLifestyle())));
  };
  const activateAccountTasks = userId => {
    const previousUserId = localStorage.getItem(activeUserKey);
    if (previousUserId === userId) return;
    if (previousUserId && previousUserId !== userId) {
      cacheAccountTasks(previousUserId);
      localStorage.setItem(accountActivityKey(previousUserId), JSON.stringify(window.getPersonalHQTaskActivity?.() || []));
      cacheAccountLifestyle(previousUserId);
    } else if (!readJson(signedOutLifestyleKey)) {
      localStorage.setItem(signedOutLifestyleKey, JSON.stringify(normalizeLifestyle(getLifestyle())));
    }
    const savedTasks = readJson(accountTasksKey(userId));
    if (Array.isArray(savedTasks)) applyTasks(savedTasks);
    else if (previousUserId && previousUserId !== userId) applyTasks(seedTasks());
    const savedLifestyle = readJson(accountLifestyleKey(userId));
    if (savedLifestyle) applyLifestyle(savedLifestyle);
    else if (previousUserId && previousUserId !== userId) applyLifestyle(seedLifestyle());
    const savedActivity = readJson(accountActivityKey(userId));
    window.setPersonalHQActivityScope?.(Array.isArray(savedActivity) ? savedActivity : []);
    window.setPersonalHQActivityStatus?.('Account activity is private to this signed-in account; cloud refresh is pending.');
    localStorage.setItem(activeUserKey, userId);
  };
  const renderConflicts = () => {
    const list = byId('privateSyncConflicts');
    const importButton = byId('privateSyncImportButton');
    const migration = byId('privateSyncMigration');
    const lifestyleImportButton = byId('privateSyncLifestyleImportButton');
    const lifestyleMigration = byId('privateSyncLifestyleMigration');
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
    if (lifestyleImportButton) lifestyleImportButton.hidden = !pendingLifestyleImport;
    if (lifestyleMigration) {
      lifestyleMigration.hidden = !pendingLifestyleImport;
      if (pendingLifestyleImport) {
        const state = normalizeLifestyle(getLifestyle());
        const summary = document.createElement('p');
        summary.textContent = `This browser has ${state.habits.length} routine name(s), ${Object.keys(state.habitLog).length} check-in day(s), and ${state.moments.length} life-log entr${state.moments.length === 1 ? 'y' : 'ies'} ready for private sync. The upload includes life-log text. Make an encrypted backup first if you need a recovery copy.`;
        lifestyleMigration.replaceChildren(summary);
      } else lifestyleMigration.replaceChildren();
    }
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
    if (lifestyleConflict) {
      const card = document.createElement('article');
      card.className = 'sync-conflict';
      const title = document.createElement('strong');
      title.textContent = 'Routine and life-log data';
      const detail = document.createElement('p');
      detail.textContent = `This browser and cloud have different private snapshots (cloud revision ${lifestyleConflict.row?.revision || 'missing'}). No routine or life-log data was overwritten. Choose which copy to keep.`;
      const compare = document.createElement('details');
      compare.className = 'sync-conflict-compare';
      const heading = document.createElement('summary');
      heading.textContent = 'Compare snapshot counts';
      const values = document.createElement('dl');
      const local = normalizeLifestyle(getLifestyle());
      const cloud = lifestyleConflict.row ? normalizeLifestyle({ ...lifestyleConflict.row.state, schemaVersion: lifestyleConflict.row.schema_version }) : null;
      for (const [label, value] of [
        ['Routine names', `${local.habits.length} in this browser · ${cloud?.habits.length ?? 'missing'} in cloud`],
        ['Check-in days', `${Object.keys(local.habitLog).length} in this browser · ${cloud ? Object.keys(cloud.habitLog).length : 'missing'} in cloud`],
        ['Life-log entries', `${local.moments.length} in this browser · ${cloud?.moments.length ?? 'missing'} in cloud`]
      ]) {
        const term = document.createElement('dt'); term.textContent = label;
        const desc = document.createElement('dd'); desc.textContent = value;
        values.append(term, desc);
      }
      compare.append(heading, values);
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      if (cloud) {
        const useCloud = document.createElement('button');
        useCloud.type = 'button'; useCloud.className = 'secondary'; useCloud.textContent = 'Use cloud snapshot';
        useCloud.addEventListener('click', () => resolveLifestyleConflict('cloud').catch(showError));
        actions.append(useCloud);
      }
      const useLocal = document.createElement('button');
      useLocal.type = 'button'; useLocal.className = 'primary'; useLocal.textContent = 'Keep this browser snapshot';
      useLocal.addEventListener('click', () => resolveLifestyleConflict('local').catch(showError));
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
    if (connect) connect.textContent = user ? 'Cloud sync' : (configReady() ? 'Sign in to sync' : 'Sync setup');
    const panelState = byId('privateSyncPanelState');
    if (user) {
      statusText(`Connected as ${user.email || 'owner'} · checking private data.`);
      lifestyleStatusText('Routine and life-log sync is checking this account.');
    }
    else if (configReady()) {
      statusText('Local only · sign in to use configured cloud sync.');
      lifestyleStatusText('Routine check-ins and life-log entries are saved in this browser until you sign in.');
      if (panelState) panelState.textContent = 'Configured · sign in to sync.';
    } else {
      statusText('Local only · owner setup required; no cloud sync is connected.');
      lifestyleStatusText('Routine check-ins and life-log entries are saved in this browser; private cloud setup is pending.');
      if (panelState) panelState.textContent = 'Owner setup required · local only.';
    }
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
      lifestyleShadow = meta.lifestyleShadow || null;
      pendingLifestyleImport = Boolean(meta.pendingLifestyleImport);
      lifestyleNeedsChoice = Boolean(meta.lifestyleNeedsChoice);
    }
    client.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user || null;
      if (!nextUser) {
        const previousUserId = user?.id || localStorage.getItem(activeUserKey);
        const forgetLocalData = previousUserId && (forgettingUserId === previousUserId || removalRequested(previousUserId));
        if (user?.id && !forgetLocalData) {
          cacheAccountTasks(user.id);
          localStorage.setItem(accountActivityKey(user.id), JSON.stringify(window.getPersonalHQTaskActivity?.() || []));
          cacheAccountLifestyle(user.id);
        }
        user = null;
        forgetTokenAtSignIn = '';
        shadow = {};
        pendingImports = new Set();
        conflicts.clear();
        pendingConflictIds = new Set();
        lifestyleShadow = null;
        pendingLifestyleImport = false;
        lifestyleNeedsChoice = false;
        lifestyleConflict = null;
        metaKey = '';
        if (previousUserId) {
          localStorage.removeItem(activeUserKey);
          if (forgetLocalData) {
            localStorage.removeItem(accountTasksKey(previousUserId));
            localStorage.removeItem(accountActivityKey(previousUserId));
            localStorage.removeItem(accountLifestyleKey(previousUserId));
            localStorage.removeItem(`${baseKey}:${previousUserId}`);
            localStorage.removeItem(`${baseKey}:initialized:${previousUserId}`);
            localStorage.removeItem('varun-hq-v1');
            forgettingUserId = null;
          }
          applyTasks(seedTasks());
          applyLifestyle(readJson(signedOutLifestyleKey) || seedLifestyle());
          window.setPersonalHQActivityScope?.(null);
          window.setPersonalHQActivityStatus?.('Browser-only activity.');
        }
      } else {
        if (user?.id && user.id !== nextUser.id) {
          shadow = {};
          pendingImports = new Set();
          conflicts.clear();
          pendingConflictIds = new Set();
          lifestyleShadow = null;
          pendingLifestyleImport = false;
          lifestyleNeedsChoice = false;
          lifestyleConflict = null;
        }
        user = nextUser;
        activateAccountTasks(user.id);
        forgetTokenAtSignIn = localStorage.getItem(forgetTokenKey(user.id)) || '';
        metaKey = `${baseKey}:${user.id}`;
        const meta = readJson(metaKey) || {};
        shadow = meta.shadow || {};
        pendingImports = new Set(Array.isArray(meta.pendingImports) ? meta.pendingImports : []);
        pendingConflictIds = new Set(Array.isArray(meta.conflictIds) ? meta.conflictIds : []);
        lifestyleShadow = meta.lifestyleShadow || null;
        pendingLifestyleImport = Boolean(meta.pendingLifestyleImport);
        lifestyleNeedsChoice = Boolean(meta.lifestyleNeedsChoice);
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
  const readLifestyleCloud = async () => {
    const { data, error } = await client.from(lifestyleTable).select(lifestyleSelectFields).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.schema_version !== 1) throw new Error(`Cloud routine/life-log schema ${data.schema_version} is not supported here. Local data was kept unchanged.`);
    return { ...data, state: normalizeLifestyle({ ...data.state, schemaVersion: data.schema_version }) };
  };
  const writeLifestyleCloud = async (state, expectedRevision) => {
    const safe = normalizeLifestyle(state);
    const { data, error } = await client.rpc('save_personal_hq_lifestyle_state', {
      p_expected_revision: String(expectedRevision),
      p_schema_version: safe.schemaVersion,
      p_state: lifestylePayload(safe)
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    if (row.schema_version !== 1) throw new Error(`Cloud routine/life-log schema ${row.schema_version} is not supported here. Local data was kept unchanged.`);
    return { ...row, state: normalizeLifestyle({ ...row.state, schemaVersion: row.schema_version }) };
  };
  const lifestyleShadowOf = row => row ? ({ revision: String(row.revision), state: normalizeLifestyle(row.state) }) : null;
  const setLifestyleConflict = row => {
    lifestyleConflict = { row: row || null };
    lifestyleNeedsChoice = true;
    pendingLifestyleImport = false;
    saveMeta();
    renderConflicts();
  };
  const syncLifestyle = async () => {
    if (!user || removalRequested(user.id)) return;
    const local = normalizeLifestyle(getLifestyle());
    const remote = await readLifestyleCloud();
    if (lifestyleNeedsChoice) {
      lifestyleConflict = { row: remote };
      renderConflicts();
      lifestyleStatusText('Routine/life-log copies differ. No cloud write was made; choose a version below.');
      return;
    }
    if (pendingLifestyleImport) {
      if (remote) {
        setLifestyleConflict(remote);
        lifestyleStatusText('A cloud snapshot appeared before import. Both copies were kept for review.');
        return;
      }
      lifestyleStatusText('Browser-only routine/life-log data is waiting for your explicit import choice.');
      return;
    }
    if (!lifestyleShadow) {
      if (!remote) {
        pendingLifestyleImport = lifestyleHasEntries(local);
        lifestyleShadow = { revision: '0', state: seedLifestyle() };
        saveMeta();
        renderConflicts();
        lifestyleStatusText(pendingLifestyleImport
          ? 'Browser-only routine and life-log data is ready for review and explicit upload.'
          : 'No private routine/life-log records in cloud yet. This browser remains local until you add a check-in or life-log entry.');
        return;
      }
      if (sameLifestyle(local, remote.state)) {
        lifestyleShadow = lifestyleShadowOf(remote);
        pendingLifestyleImport = false;
        saveMeta();
      } else if (!lifestyleHasEntries(local)) {
        applyLifestyle({ schemaVersion: remote.schema_version, ...remote.state });
        lifestyleShadow = lifestyleShadowOf(remote);
        pendingLifestyleImport = false;
        saveMeta();
      } else {
        setLifestyleConflict(remote);
        lifestyleStatusText('Both this browser and cloud contain routine/life-log records. Choose a version; neither was overwritten.');
        return;
      }
    }
    const currentLocal = normalizeLifestyle(getLifestyle());
    const localChanged = !sameLifestyle(currentLocal, lifestyleShadow.state);
    const remoteChanged = remote ? String(remote.revision) !== String(lifestyleShadow.revision) : String(lifestyleShadow.revision) !== '0';
    if (!remote && String(lifestyleShadow.revision) !== '0' && !localChanged) {
      setLifestyleConflict(null);
      lifestyleStatusText('The cloud snapshot is missing. The browser copy was kept; choose whether to create it again.');
      return;
    }
    if (remoteChanged && localChanged && (!remote || !sameLifestyle(currentLocal, remote.state))) {
      setLifestyleConflict(remote);
      lifestyleStatusText('Routine/life-log edits conflict with a newer cloud snapshot. Both copies were retained.');
      return;
    }
    if (remoteChanged && remote && !localChanged) {
      applyLifestyle({ schemaVersion: remote.schema_version, ...remote.state });
      lifestyleShadow = lifestyleShadowOf(remote);
      pendingLifestyleImport = false;
      saveMeta();
    } else if (localChanged) {
      const saved = await writeLifestyleCloud(currentLocal, lifestyleShadow.revision);
      if (!saved) {
        setLifestyleConflict(await readLifestyleCloud());
        lifestyleStatusText('The cloud changed during save. Both copies were retained; choose a version below.');
        return;
      }
      lifestyleShadow = lifestyleShadowOf(saved);
      pendingLifestyleImport = false;
      saveMeta();
    }
    renderConflicts();
    lifestyleStatusText(`Routine and life-log data synced at ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' }).format(new Date())} IST.`);
  };
  const syncCloudActivity = async () => {
    if (!user) return;
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client.from('personal_hq_task_events')
        .select(activityFields).order('occurred_at', { ascending: false }).order('event_id', { ascending: false })
        .range(offset, offset + 499);
      if (error) {
        window.setPersonalHQActivityStatus?.('Cloud activity could not be read. The saved activity for this account was kept on this device.');
        return;
      }
      const batch = data || [];
      rows.push(...batch);
      if (batch.length < 500) break;
    }
    const events = rows.map(row => ({
      id: `cloud:${row.event_id}`,
      at: row.occurred_at,
      taskId: row.task_id,
      taskTitle: row.task_title,
      area: row.area,
      action: row.action,
      changedFields: (row.changed_fields || []).map(field => ({ next_action: 'nextAction', private_context: 'notes' }[field] || field)),
      previousStatus: row.previous_status || '',
      status: row.status || '',
      revision: String(row.task_revision),
      source: 'cloud'
    }));
    window.mergePersonalHQTaskActivity?.(events);
    localStorage.setItem(accountActivityKey(user.id), JSON.stringify(window.getPersonalHQTaskActivity?.() || []));
    window.setPersonalHQActivityStatus?.('Private cloud activity refreshed for this account.');
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
      await syncCloudActivity();
      try { await syncLifestyle(); }
      catch (error) { lifestyleStatusText(error?.message || 'Routine and life-log sync could not complete. The browser copy was kept.', true); }
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
      else if (pendingImports.size) statusText(`${pendingImports.size} browser-only task${pendingImports.size === 1 ? '' : 's'} still await import.`);
      else {
        const currentTasks = getTasks();
        const currentIds = new Set(currentTasks.map(task => task.id));
        const hasPendingChanges = currentTasks.some(task => !pendingImports.has(task.id) && (!shadow[task.id] || !sameFields(localFields(task), shadow[task.id].fields))) || Object.keys(shadow).some(id => !currentIds.has(id) && !shadow[id].deletedAt);
        statusText(hasPendingChanges
          ? 'Pending changes · saved here; waiting to sync.'
          : `Synced at ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', timeStyle: 'short' }).format(new Date())} IST.`);
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

  async function importLocalLifestyle() {
    if (!user || busy || !pendingLifestyleImport) return;
    const state = normalizeLifestyle(getLifestyle());
    const checks = Object.keys(state.habitLog).length;
    const moments = state.moments.length;
    if (!window.confirm(`Upload this browser's private routine and life-log snapshot to your owner account? It contains ${checks} check-in day(s), ${moments} life-log entr${moments === 1 ? 'y' : 'ies'}, and any life-log text. Create an encrypted backup first if you need a recovery copy. Continue?`)) return;
    busy = true;
    try {
      const saved = await writeLifestyleCloud(state, '0');
      if (!saved) {
        setLifestyleConflict(await readLifestyleCloud());
        lifestyleStatusText('A cloud snapshot already exists. Both copies were kept for review.');
        return;
      }
      lifestyleShadow = lifestyleShadowOf(saved);
      pendingLifestyleImport = false;
      lifestyleNeedsChoice = false;
      lifestyleConflict = null;
      saveMeta();
      renderConflicts();
      lifestyleStatusText('Routine and life-log snapshot uploaded to the private owner account.');
    } catch (error) {
      lifestyleStatusText(error?.message || 'Routine/life-log import failed. The local copy was kept.', true);
    } finally { busy = false; }
  }

  async function resolveLifestyleConflict(choice) {
    if (!user || busy || !lifestyleConflict) return;
    busy = true;
    try {
      const local = normalizeLifestyle(getLifestyle());
      const remote = await readLifestyleCloud();
      if (choice === 'cloud') {
        if (!remote) throw new Error('The cloud snapshot is missing. Keep the browser copy or retry sync.');
        applyLifestyle({ ...remote.state, schemaVersion: remote.schema_version });
        lifestyleShadow = lifestyleShadowOf(remote);
      } else {
        const saved = await writeLifestyleCloud(local, remote?.revision || '0');
        if (!saved) {
          setLifestyleConflict(await readLifestyleCloud());
          lifestyleStatusText('The cloud changed again. Both copies were retained; review the new conflict.');
          return;
        }
        const verified = await readLifestyleCloud();
        if (!verified || !sameLifestyle(local, verified.state)) throw new Error('The cloud did not confirm this browser snapshot. Both copies were retained.');
        lifestyleShadow = lifestyleShadowOf(verified);
      }
      pendingLifestyleImport = false;
      lifestyleNeedsChoice = false;
      lifestyleConflict = null;
      saveMeta();
      renderConflicts();
      lifestyleStatusText('Routine/life-log conflict resolved.');
      busy = false;
      await synchronize();
    } catch (error) {
      lifestyleStatusText(error?.message || 'Could not resolve the routine/life-log conflict. Both copies were kept.', true);
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
    let localLifestyleDetail = 'the routine and life-log cache';
    try {
      const localLifestyle = normalizeLifestyle(getLifestyle());
      localLifestyleDetail = `${localLifestyle.habits.length} routine name(s), ${Object.keys(localLifestyle.habitLog).length} check-in day(s), and ${localLifestyle.moments.length} life-log entr${localLifestyle.moments.length === 1 ? 'y' : 'ies'}`;
    } catch { /* Keep local account removal available if browser data is malformed. */ }
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
      `Remove this account's data from this device? This deletes ${localTaskCount} locally stored task records (${pendingCount} pending or conflicting), ${localLifestyleDetail}, sync metadata, and any pending edits, then signs out. It does not delete cloud data or encrypted backup files. If you need pending edits, cancel and create an encrypted backup first. Continue?`
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
        localStorage.removeItem(accountActivityKey(userId));
        localStorage.removeItem(accountLifestyleKey(userId));
        localStorage.removeItem(`${baseKey}:${userId}`);
        localStorage.removeItem(`${baseKey}:initialized:${userId}`);
        localStorage.removeItem('varun-hq-v1');
        applyTasks(seedTasks());
        applyLifestyle(readJson(signedOutLifestyleKey) || seedLifestyle());
        forgettingUserId = null;
        renderSession();
      }
      statusText(`Removed this account's local tasks, routines, life-log cache, and sync metadata. Cloud data was not deleted.`);
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
    byId('privateSyncLifestyleImportButton')?.addEventListener('click', () => importLocalLifestyle().catch(showError));
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
    onActivityChange(events) {
      if (user && Array.isArray(events)) localStorage.setItem(accountActivityKey(user.id), JSON.stringify(events));
    },
    onLocalChange() {
      if (!user || applyingRemote || removalRequested(user.id)) return;
      cacheAccountTasks(user.id);
      const tasks = getTasks();
      const localById = new Set(tasks.map(task => task.id));
      const taskDirty = Object.keys(shadow).length > 0 && !pendingImports.size && !conflicts.size && (tasks.some(task => !pendingImports.has(task.id) && (!shadow[task.id] || !sameFields(localFields(task), shadow[task.id].fields))) || Object.keys(shadow).some(id => !localById.has(id) && !shadow[id].deletedAt));
      let lifestyleDirty = false;
      try {
        cacheAccountLifestyle(user.id);
        lifestyleDirty = !pendingLifestyleImport && !lifestyleNeedsChoice && !!lifestyleShadow && !sameLifestyle(getLifestyle(), lifestyleShadow.state);
      } catch (error) { lifestyleStatusText(error?.message || 'The routine/life-log change needs attention.', true); }
      if (!taskDirty && !lifestyleDirty) return;
      if (taskDirty) statusText('Pending changes · saved here; waiting to sync.');
      if (lifestyleDirty) lifestyleStatusText('Routine/life-log change saved here; waiting to sync.');
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => synchronize().catch(showError), 650);
    },
    open: openDialog,
    isAuthenticated: () => !!user
  };
})();
