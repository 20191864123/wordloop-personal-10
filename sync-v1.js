const DB_NAME = "wordloop-personal-v6";
const STORE_NAME = "wordloop";
const PROGRESS_KEY = "progress";
const PERSONAL_KEY = "personal-key";
const LIBRARY_KEY = "library";
const SYNC_META_KEY = "cloud-sync-v1";
const SYNC_API_URL = "https://wordloop-sync.wordloop-20191864123.workers.dev/v1/sync";
const MAX_BATCH = 500;
const FOREGROUND_SYNC_DELAY = 5000;
const BACKGROUND_SYNC_DELAY = 60000;
const LOCAL_WATCH_DELAY = 750;
const READING_POSITION_KEY = "wordloop-reading-position-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let busy = false;
let rerunRequested = false;
let timer = 0;
let failureCount = 0;
let status = "waiting";
let syncedDeletedCount = null;
let localWatchTimer = 0;
let localWatchBusy = false;
let lastLocalProgressSignature = "";

function normalizeWord(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function deriveCredentials(personalKey) {
  const [syncIdBytes, authBytes, encryptionBytes] = await Promise.all([
    digest(`wordloop-sync-id-v1:${personalKey}`),
    digest(`wordloop-sync-auth-v1:${personalKey}`),
    digest(`wordloop-sync-encryption-v1:${personalKey}`),
  ]);
  return {
    syncId: bytesToHex(syncIdBytes),
    authToken: bytesToHex(authBytes),
    encryptionKey: await crypto.subtle.importKey("raw", encryptionBytes, "AES-GCM", false, ["encrypt", "decrypt"]),
  };
}

async function encryptPayload(value, credentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(`wordloop-sync-v1:${credentials.syncId}`),
        tagLength: 128,
      },
      credentials.encryptionKey,
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

async function decryptPayload(payload, credentials) {
  const [version, ivText, ciphertextText, extra] = payload.split(".");
  if (version !== "v1" || !ivText || !ciphertextText || extra) throw new Error("invalid_sync_payload");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivText),
      additionalData: encoder.encode(`wordloop-sync-v1:${credentials.syncId}`),
      tagLength: 128,
    },
    credentials.encryptionKey,
    base64UrlToBytes(ciphertextText),
  );
  return JSON.parse(decoder.decode(plaintext));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLocal(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function writeLocalEntries(entries) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const [key, value] of entries) store.put(value, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

function keyFromFragment() {
  return location.hash ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
}

function validPendingOperation(value) {
  return Boolean(
    value &&
      typeof value.opId === "string" &&
      typeof value.word === "string" &&
      typeof value.deleted === "boolean",
  );
}

function createOperation(word, deleted) {
  return { opId: crypto.randomUUID(), word: normalizeWord(word), deleted };
}

async function createMigrationOperation(word) {
  return {
    opId: `migration_${bytesToHex(await digest(`wordloop-sync-migration-v1:${word}`))}`,
    word,
    deleted: true,
  };
}

function applyOperations(startingWords, operations) {
  const result = new Set(startingWords);
  for (const operation of operations) {
    if (operation.deleted) result.add(operation.word);
    else result.delete(operation.word);
  }
  return result;
}

function sameWords(first, second) {
  if (first.size !== second.size) return false;
  for (const word of first) if (!second.has(word)) return false;
  return true;
}

function deletedWordsFromRemaining(libraryWords, remainingWords) {
  const allWords = [
    ...new Set((Array.isArray(libraryWords) ? libraryWords : []).map((item) => normalizeWord(item?.word ?? item)).filter(Boolean)),
  ];
  const remaining = new Set(
    (Array.isArray(remainingWords) ? remainingWords : []).map((item) => normalizeWord(item?.word ?? item)).filter(Boolean),
  );
  return allWords.filter((word) => !remaining.has(word));
}

function statusText(value) {
  return {
    waiting: "未连接云端 · 点此连接",
    syncing: "云同步中…",
    synced:
      syncedDeletedCount === null
        ? "云端已同步 · 约5秒自动更新"
        : `云端已同步 · 已删${syncedDeletedCount.toLocaleString()}词`,
    offline: "离线保存 · 联网后同步",
  }[value];
}

function nextSyncDelay() {
  return document.visibilityState === "visible" ? FOREGROUND_SYNC_DELAY : BACKGROUND_SYNC_DELAY;
}

function progressSignature(progress) {
  const deletedWords = Array.isArray(progress?.deletedWords) ? progress.deletedWords : [];
  return `${deletedWords.length}|${Number(progress?.activeList) || 1}|${progress?.showMeaning !== false}`;
}

function personalKeyFromInput(value) {
  const text = String(value || "").trim();
  let key = text;
  try {
    const url = new URL(text);
    key = new URLSearchParams(url.hash.slice(1)).get("key") || "";
  } catch {
    if (text.includes("#")) key = new URLSearchParams(text.split("#").at(-1)).get("key") || "";
    else if (text.startsWith("key=")) key = text.slice(4);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || base64UrlToBytes(key).byteLength !== 32) {
    throw new Error("专属链接或密钥格式不正确");
  }
  return key;
}

async function connectCloudSync() {
  const value = window.prompt("请粘贴完整的WordLoop专属链接，或粘贴#key=后面的密钥：");
  if (value === null) return;
  try {
    const key = personalKeyFromInput(value);
    await writeLocalEntries([[PERSONAL_KEY, key]]);
    failureCount = 0;
    setStatus("syncing");
    schedule(50);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "无法连接云同步");
  }
}

async function currentPersonalKey() {
  return keyFromFragment() || (await readLocal(PERSONAL_KEY));
}

async function copySyncLink() {
  const personalKey = await currentPersonalKey();
  if (!personalKey) {
    await connectCloudSync();
    return;
  }
  const link = new URL(location.href);
  link.hash = `key=${personalKey}`;
  try {
    await navigator.clipboard.writeText(link.toString());
    window.alert("三端同步链接已复制。请在 iPhone、iPad 和 Mac 上分别打开这条链接一次。");
  } catch {
    window.prompt("请复制下面的三端同步链接：", link.toString());
  }
}

async function forceUploadLocalProgress() {
  const [progress, savedMeta, savedKey] = await Promise.all([
    readLocal(PROGRESS_KEY),
    readLocal(SYNC_META_KEY),
    readLocal(PERSONAL_KEY),
  ]);
  if (!savedKey && !keyFromFragment()) {
    await connectCloudSync();
    return;
  }
  const deletedWords = [
    ...new Set((Array.isArray(progress?.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean)),
  ];
  if (deletedWords.length === 0) {
    window.alert("这台设备当前没有删除记录。请务必在仍保留删除记录的旧iPhone WordLoop里执行。");
    return;
  }
  if (!window.confirm(`确定把这台设备的 ${deletedWords.length.toLocaleString()} 个删除记录重新上传到云端吗？`)) {
    return;
  }
  const meta = observeLocalChanges(progress, await initializeMeta(progress, savedMeta));
  meta.pending.push(...deletedWords.map((word) => createOperation(word, true)));
  meta.lastObservedDeleted = [...deletedWords].sort();
  await writeLocalEntries([[SYNC_META_KEY, meta]]);
  failureCount = 0;
  setStatus("syncing");
  schedule(50);
}

async function importOldProgress(file) {
  const exported = JSON.parse(await file.text());
  if (!Array.isArray(exported?.words) || exported.words.length === 0) {
    throw new Error("这不是WordLoop导出的剩余词库JSON");
  }
  const [library, progress, savedMeta] = await Promise.all([
    readLocal(LIBRARY_KEY),
    readLocal(PROGRESS_KEY),
    readLocal(SYNC_META_KEY),
  ]);
  if (!Array.isArray(library?.words) || library.words.length === 0) {
    throw new Error("请先用专属链接载入完整词库，再导入旧进度");
  }
  if (
    exported.datasetFingerprint &&
    library.datasetFingerprint &&
    exported.datasetFingerprint !== library.datasetFingerprint
  ) {
    throw new Error("旧进度与当前词库版本不一致，请把JSON发给Codex核对");
  }

  const allWords = library.words.map((item) => normalizeWord(item.word)).filter(Boolean);
  const allWordSet = new Set(allWords);
  const remaining = new Set(exported.words.map((item) => normalizeWord(item?.word)).filter(Boolean));
  const matched = [...remaining].filter((word) => allWordSet.has(word)).length;
  if (matched < Math.min(remaining.size, Math.floor(remaining.size * 0.98))) {
    throw new Error("旧文件中的单词与当前词库对不上，请不要强行导入");
  }

  const deletedWords = deletedWordsFromRemaining(library.words, exported.words);
  if (Number(exported.deletedCount) > 0 && deletedWords.length === 0) {
    throw new Error("检测到旧文件有删除记录，但没有成功转换，请把文件发给Codex");
  }
  const nextProgress = {
    ...(progress || {}),
    fingerprint: library.datasetFingerprint,
    deletedWords: [...new Set(deletedWords)].sort(),
    activeList: Math.min(10, Math.max(1, Number(progress?.activeList) || 1)),
    showMeaning: progress?.showMeaning !== false,
  };
  let meta = await initializeMeta(progress, savedMeta);
  meta.lastObservedDeleted = [
    ...new Set((Array.isArray(progress?.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean)),
  ].sort();
  meta = observeLocalChanges(nextProgress, meta);
  meta.pending.push(...deletedWords.map((word) => createOperation(word, true)));
  meta.lastObservedDeleted = [...nextProgress.deletedWords];
  meta.applyOnNextLoad = true;
  meta.appliedDeletedWords = [...nextProgress.deletedWords];
  meta.authoritativeImportAt = Date.now();
  await writeLocalEntries([
    [PROGRESS_KEY, nextProgress],
    [SYNC_META_KEY, meta],
  ]);
  return { deletedCount: deletedWords.length, queuedCount: meta.pending.length };
}

function renderProgressImporter() {
  const sheet = document.querySelector(".action-sheet");
  if (!sheet || sheet.querySelector(".import-old-progress")) return;
  const button = document.createElement("button");
  const input = document.createElement("input");
  button.type = "button";
  button.className = "import-old-progress";
  button.textContent = "导入iPhone备份并同步三端";
  input.type = "file";
  input.accept = "application/json,.json";
  input.hidden = true;
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    button.disabled = true;
    button.textContent = "正在导入并准备云同步…";
    try {
      const result = await importOldProgress(file);
      window.alert(
        `已从iPhone备份恢复 ${result.deletedCount.toLocaleString()} 个删除记录。接下来会自动上传云端；请保持本页打开，直到顶部重新显示“云端已同步”。`,
      );
      reloadPreservingReadingPosition();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "旧进度导入失败");
      button.disabled = false;
      button.textContent = "导入iPhone备份并同步三端";
    }
  });
  const firstSecondaryButton = sheet.querySelector("button:not(.sheet-primary)");
  if (firstSecondaryButton) firstSecondaryButton.before(button, input);
  else sheet.append(button, input);
}

function renderCloudConnector() {
  const sheet = document.querySelector(".action-sheet");
  if (!sheet) return;
  let button = sheet.querySelector(".connect-cloud-sync");
  if (status !== "waiting") {
    button?.remove();
    return;
  }
  if (button) return;
  button = document.createElement("button");
  button.type = "button";
  button.className = "connect-cloud-sync";
  button.textContent = "连接云同步";
  button.addEventListener("click", connectCloudSync);
  const firstSecondaryButton = sheet.querySelector("button:not(.sheet-primary)");
  if (firstSecondaryButton) firstSecondaryButton.before(button);
  else sheet.append(button);
}

function renderCloudActions() {
  const sheet = document.querySelector(".action-sheet");
  if (!sheet) return;
  let shareButton = sheet.querySelector(".copy-cloud-link");
  let syncButton = sheet.querySelector(".sync-cloud-now");
  if (status === "waiting") {
    shareButton?.remove();
    syncButton?.remove();
    return;
  }
  if (!shareButton) {
    shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.className = "copy-cloud-link";
    shareButton.textContent = "复制三端同步链接";
    shareButton.addEventListener("click", copySyncLink);
    const firstSecondaryButton = sheet.querySelector("button:not(.sheet-primary)");
    if (firstSecondaryButton) firstSecondaryButton.before(shareButton);
    else sheet.append(shareButton);
  }
  if (!syncButton) {
    syncButton = document.createElement("button");
    syncButton.type = "button";
    syncButton.className = "sync-cloud-now";
    syncButton.textContent = "立即同步三台设备";
    syncButton.addEventListener("click", manualSyncNow);
    shareButton.after(syncButton);
  }
}

function waitForNextSyncResult(timeout = 12000) {
  return new Promise((resolve) => {
    let timeoutId;
    const finish = (result) => {
      window.removeEventListener("wordloop-cloud-status", onStatus);
      window.clearTimeout(timeoutId);
      resolve(result);
    };
    const onStatus = (event) => {
      if (["synced", "offline", "waiting"].includes(event.detail)) finish(event.detail);
    };
    window.addEventListener("wordloop-cloud-status", onStatus);
    timeoutId = window.setTimeout(() => finish(status), timeout);
  });
}

async function manualSyncNow(event) {
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;

  button.disabled = true;
  button.textContent = "正在同步…";
  failureCount = 0;
  const nextResult = waitForNextSyncResult();
  const immediateResult = await runSync();
  const result = immediateResult === "queued" ? await nextResult : immediateResult;
  const liveButton = document.querySelector(".sync-cloud-now");
  if (!(liveButton instanceof HTMLButtonElement)) return;

  if (result === "synced") {
    liveButton.textContent = "同步完成 ✓";
    window.setTimeout(() => {
      const currentButton = document.querySelector(".sync-cloud-now");
      if (!(currentButton instanceof HTMLButtonElement)) return;
      currentButton.disabled = false;
      currentButton.textContent = "立即同步三台设备";
    }, 1200);
    return;
  }

  liveButton.disabled = false;
  liveButton.textContent = result === "waiting" ? "请先连接云同步" : "同步失败，点此重试";
}

function renderForceUploadButton() {
  const sheet = document.querySelector(".action-sheet");
  if (!sheet || sheet.querySelector(".force-upload-progress")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "force-upload-progress";
  button.textContent = "重新上传本机删除记录";
  button.addEventListener("click", forceUploadLocalProgress);
  const importer = sheet.querySelector(".import-old-progress");
  if (importer) importer.after(button);
  else sheet.append(button);
}

function renderStatus() {
  const copyUpdates = [
    [".action-sheet p", "你的删除进度只保存在这台设备。建议每过完一个List就导出一次备份。", "删除记录、当前List和释义开关会加密同步；断网时仍保存在本机，联网后自动补传。"],
    [".import-steps p", "删除永久保存在本机，刷新会检查更新", "删除先保存在本机，并自动加密同步到其他设备"],
    [".danger-link", "清除本机词库和进度", "清除本机缓存（云端不删除）"],
    [".confirm-card p", "本机保存的词库和全部删除记录都会清除。请先导出备份。", "只清除这台设备的缓存，云端进度不会删除；以后用专属链接打开即可恢复。"],
  ];
  for (const [selector, original, replacement] of copyUpdates) {
    for (const element of document.querySelectorAll(selector)) {
      if (element.textContent?.trim() === original) element.textContent = replacement;
    }
  }
  renderProgressImporter();
  renderCloudConnector();
  renderCloudActions();
  if (new URLSearchParams(location.search).get("recovery") === "1") {
    renderForceUploadButton();
  }

  let indicator = document.querySelector(".cloud-sync-indicator");
  const brandCopy = document.querySelector(".header-brand > div:last-child");
  if (!brandCopy) return;
  if (!indicator) {
    indicator = document.createElement("button");
    indicator.type = "button";
    indicator.className = "cloud-sync-indicator";
    indicator.addEventListener("click", () => {
      if (status === "waiting") connectCloudSync();
      else {
        failureCount = 0;
        void runSync();
      }
    });
    brandCopy.append(indicator);
  }
  indicator.dataset.state = status;
  const text = statusText(status);
  if (indicator.textContent !== text) indicator.textContent = text;
}

function setStatus(next) {
  status = next;
  renderStatus();
  window.dispatchEvent(new CustomEvent("wordloop-cloud-status", { detail: next }));
}

function schedule(delay) {
  window.clearTimeout(timer);
  timer = window.setTimeout(runSync, delay);
}

async function watchLocalProgress() {
  if (localWatchBusy) return;
  localWatchBusy = true;
  window.clearTimeout(localWatchTimer);
  try {
    if (document.visibilityState === "visible") {
      const progress = await readLocal(PROGRESS_KEY);
      const signature = progressSignature(progress);
      if (lastLocalProgressSignature && signature !== lastLocalProgressSignature) schedule(50);
      lastLocalProgressSignature = signature;
    }
  } catch (error) {
    console.info("WordLoop本机进度监听暂不可用。", error instanceof Error ? error.message : error);
  } finally {
    localWatchBusy = false;
    localWatchTimer = window.setTimeout(
      watchLocalProgress,
      document.visibilityState === "visible" ? LOCAL_WATCH_DELAY : BACKGROUND_SYNC_DELAY,
    );
  }
}

async function initializeMeta(progress, savedMeta) {
  if (savedMeta?.version === 1 && savedMeta.initialized) {
    return {
      ...savedMeta,
      pending: Array.isArray(savedMeta.pending) ? savedMeta.pending.filter(validPendingOperation) : [],
      lastObservedDeleted: Array.isArray(savedMeta.lastObservedDeleted) ? savedMeta.lastObservedDeleted : [],
    };
  }
  const deletedWords = Array.isArray(progress?.deletedWords)
    ? [...new Set(progress.deletedWords.map(normalizeWord).filter(Boolean))]
    : [];
  const pending = await Promise.all(deletedWords.map(createMigrationOperation));
  return {
    version: 1,
    initialized: true,
    cursor: 0,
    uiRevision: 0,
    hasSyncedOnce: false,
    pending,
    lastObservedDeleted: deletedWords.sort(),
    lastObservedActiveList: progress?.activeList ?? null,
    lastObservedShowMeaning: progress?.showMeaning ?? null,
    uiDirty: Boolean(progress),
  };
}

function observeLocalChanges(progress, meta) {
  if (!progress) return meta;
  const current = new Set(
    (Array.isArray(progress.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean),
  );
  const previous = new Set((meta.lastObservedDeleted || []).map(normalizeWord));
  for (const word of current) if (!previous.has(word)) meta.pending.push(createOperation(word, true));
  for (const word of previous) if (!current.has(word)) meta.pending.push(createOperation(word, false));
  meta.lastObservedDeleted = [...current].sort();

  if (meta.hasSyncedOnce || meta.lastObservedActiveList !== null) {
    const listChanged = Number(progress.activeList) !== Number(meta.lastObservedActiveList);
    const meaningChanged = Boolean(progress.showMeaning) !== Boolean(meta.lastObservedShowMeaning);
    if (listChanged || meaningChanged) meta.uiDirty = true;
  }
  meta.lastObservedActiveList = Number(progress.activeList) || 1;
  meta.lastObservedShowMeaning = progress.showMeaning !== false;
  return meta;
}

async function postSync(credentials, cursor, pending, uiState) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const operations = await Promise.all(
      pending.map(async (operation) => ({
        opId: operation.opId,
        payload: await encryptPayload({ word: operation.word, deleted: operation.deleted }, credentials),
      })),
    );
    const response = await fetch(SYNC_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ syncId: credentials.syncId, cursor, operations, uiState }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`sync_http_${response.status}`);
    const body = await response.json();
    if (!body?.ok || !Array.isArray(body.events)) throw new Error("invalid_sync_response");
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runSync() {
  if (busy) {
    rerunRequested = true;
    return "queued";
  }
  busy = true;
  rerunRequested = false;
  try {
    const [fragmentKey, savedKey, initialProgress, savedMeta] = await Promise.all([
      Promise.resolve(keyFromFragment()),
      readLocal(PERSONAL_KEY),
      readLocal(PROGRESS_KEY),
      readLocal(SYNC_META_KEY),
    ]);
    const personalKey = fragmentKey || savedKey;
    if (!personalKey) {
      setStatus("waiting");
      schedule(BACKGROUND_SYNC_DELAY);
      return "waiting";
    }

    let progress = initialProgress;
    let meta = observeLocalChanges(progress, await initializeMeta(progress, savedMeta));
    await writeLocalEntries([[SYNC_META_KEY, meta]]);
    setStatus("syncing");
    const credentials = await deriveCredentials(personalKey);
    let cursor = Math.max(0, Number(meta.cursor) || 0);
    const remoteOperations = [];
    const pendingQueue = [...meta.pending];
    const acknowledged = new Set();
    let latestUiState = null;
    let sentUi = false;

    for (let round = 0; round < 80; round += 1) {
      const sent = pendingQueue.splice(0, MAX_BATCH);
      let uiState = null;
      if (!sentUi && meta.uiDirty && progress) {
        uiState = {
          opId: crypto.randomUUID(),
          payload: await encryptPayload(
            { activeList: Number(progress.activeList) || 1, showMeaning: progress.showMeaning !== false },
            credentials,
          ),
        };
        sentUi = true;
      }
      const response = await postSync(credentials, cursor, sent, uiState);
      for (const operation of sent) acknowledged.add(operation.opId);
      for (const event of response.events) {
        const operation = await decryptPayload(event.payload, credentials);
        const word = normalizeWord(operation?.word);
        if (word && typeof operation?.deleted === "boolean") {
          remoteOperations.push({ word, deleted: operation.deleted });
        }
      }
      cursor = Math.max(cursor, Number(response.cursor) || cursor);
      if (response.uiState) latestUiState = response.uiState;
      if (!response.hasMore && pendingQueue.length === 0) break;
      if (round === 79) throw new Error("sync_round_limit");
    }

    progress = (await readLocal(PROGRESS_KEY)) || progress || {
      fingerprint: "",
      deletedWords: [],
      activeList: 1,
      showMeaning: true,
    };
    meta = observeLocalChanges(progress, meta);
    meta.pending = meta.pending.filter((operation) => !acknowledged.has(operation.opId));
    const currentWords = new Set(
      (Array.isArray(progress.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean),
    );
    let mergedWords = applyOperations(currentWords, remoteOperations);
    mergedWords = applyOperations(mergedWords, meta.pending);
    const wordsChanged = !sameWords(currentWords, mergedWords);

    if (sentUi) meta.uiDirty = false;
    if (!meta.uiDirty && latestUiState && Number(latestUiState.revision) > Number(meta.uiRevision || 0)) {
      const remoteUi = await decryptPayload(latestUiState.payload, credentials);
      progress.activeList = Math.min(10, Math.max(1, Number(remoteUi?.activeList) || 1));
      progress.showMeaning = remoteUi?.showMeaning !== false;
      meta.lastObservedActiveList = progress.activeList;
      meta.lastObservedShowMeaning = progress.showMeaning;
      meta.uiRevision = Number(latestUiState.revision) || meta.uiRevision || 0;
    }

    progress.deletedWords = [...mergedWords].sort();
    meta.lastObservedDeleted = [...mergedWords].sort();
    meta.cursor = cursor;
    meta.hasSyncedOnce = true;
    if (wordsChanged) {
      meta.applyOnNextLoad = true;
      meta.appliedDeletedWords = [...mergedWords].sort();
    }
    await writeLocalEntries([
      [PROGRESS_KEY, progress],
      [SYNC_META_KEY, meta],
    ]);
    failureCount = 0;
    syncedDeletedCount = mergedWords.size;
    setStatus("synced");
    schedule(nextSyncDelay());
    if (wordsChanged && document.readyState !== "loading") renderIncomingProgressNotice();
    return "synced";
  } catch (error) {
    failureCount += 1;
    setStatus("offline");
    schedule(failureCount === 1 ? 20000 : failureCount === 2 ? 60000 : 300000);
    console.info("WordLoop云同步暂不可用，本机进度已保留。", error instanceof Error ? error.message : error);
    return "offline";
  } finally {
    busy = false;
    if (rerunRequested) schedule(0);
  }
}

async function applyCloudSnapshotBeforeApp() {
  const [progress, meta] = await Promise.all([readLocal(PROGRESS_KEY), readLocal(SYNC_META_KEY)]);
  if (!progress || !meta?.applyOnNextLoad || !Array.isArray(meta.appliedDeletedWords)) return;
  progress.deletedWords = [...new Set(meta.appliedDeletedWords.map(normalizeWord).filter(Boolean))].sort();
  meta.lastObservedDeleted = [...progress.deletedWords];
  meta.applyOnNextLoad = false;
  delete meta.appliedDeletedWords;
  await writeLocalEntries([
    [PROGRESS_KEY, progress],
    [SYNC_META_KEY, meta],
  ]);
}

function captureReadingPosition() {
  try {
    const rows = [...document.querySelectorAll(".word-row")];
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > 72);
    const word = anchor?.querySelector(".word-main strong")?.textContent?.trim() || "";
    const offset = anchor ? Math.max(0, anchor.getBoundingClientRect().top) : 0;
    sessionStorage.setItem(
      READING_POSITION_KEY,
      JSON.stringify({ word, offset, scrollTop: window.scrollY, savedAt: Date.now() }),
    );
  } catch {
    // Some private browsing modes may not expose sessionStorage.
  }
}

function reloadPreservingReadingPosition() {
  captureReadingPosition();
  location.reload();
}

function renderIncomingProgressNotice() {
  let button = document.querySelector(".cloud-progress-notice");
  if (button) return;
  button = document.createElement("button");
  button.type = "button";
  button.className = "cloud-progress-notice";
  button.textContent = "已收到其他设备进度 · 点此更新（不会跳回顶部）";
  button.addEventListener("click", reloadPreservingReadingPosition);
  document.body.append(button);
}

function restoreReadingPosition() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(READING_POSITION_KEY) || "null");
    sessionStorage.removeItem(READING_POSITION_KEY);
  } catch {
    return;
  }
  if (!saved || Date.now() - Number(saved.savedAt || 0) > 120000) return;

  const restore = (attempt = 0) => {
    const rows = [...document.querySelectorAll(".word-row")];
    const anchor = rows.find(
      (row) => normalizeWord(row.querySelector(".word-main strong")?.textContent) === normalizeWord(saved.word),
    );
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
      window.scrollBy({ top: -Math.max(0, Number(saved.offset) || 0), behavior: "auto" });
      return;
    }
    const loadMore = document.querySelector(".load-more");
    if (loadMore instanceof HTMLButtonElement && attempt < 30) {
      loadMore.click();
      window.setTimeout(() => restore(attempt + 1), 80);
      return;
    }
    window.scrollTo({ top: Math.max(0, Number(saved.scrollTop) || 0), behavior: "auto" });
  };
  window.setTimeout(restore, 250);
}

async function startBrowserApp() {
  try {
    await applyCloudSnapshotBeforeApp();
  } catch (error) {
    console.info("WordLoop启动前进度恢复失败，将继续使用本机数据。", error instanceof Error ? error.message : error);
  }
  await import("./assets/index-DiX3UPkj.js");
  restoreReadingPosition();
  const observer = new MutationObserver(renderStatus);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("online", () => schedule(100));
  window.addEventListener("focus", () => schedule(250));
  window.addEventListener("pageshow", () => schedule(250));
  window.addEventListener("pagehide", () => runSync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedule(250);
      watchLocalProgress();
    } else {
      runSync();
    }
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.info("WordLoop离线缓存暂不可用。", error instanceof Error ? error.message : error);
      });
    });
  }
  watchLocalProgress();
  runSync();
}

if (typeof window !== "undefined" && typeof indexedDB !== "undefined") startBrowserApp();

export {
  applyOperations,
  createMigrationOperation,
  decryptPayload,
  deletedWordsFromRemaining,
  deriveCredentials,
  encryptPayload,
  importOldProgress,
  nextSyncDelay,
  normalizeWord,
  personalKeyFromInput,
  progressSignature,
};
