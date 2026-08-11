const DB_NAME = "wordloop-personal-v6";
const STORE_NAME = "wordloop";
const PROGRESS_KEY = "progress";
const PERSONAL_KEY = "personal-key";
const LIBRARY_KEY = "library";
const SYNC_META_KEY = "cloud-sync-v1";
const SYNC_API_URL = "https://wordloop-sync.wordloop-20191864123.workers.dev/v1/sync";
const SYNC_POLICY_VERSION = 4;
const MAX_BATCH = 500;
const FOREGROUND_SYNC_DELAY = 5000;
const BACKGROUND_SYNC_DELAY = 60000;
const LOCAL_WATCH_DELAY = 750;
const READING_POSITION_KEY = "wordloop-reading-position-v1";
const PERSISTED_READING_POSITION_KEY = "wordloop-reading-position-persistent-v1";
const DELETE_SIDE_KEY = "wordloop-delete-side-v1";
const SYNC_LEADER_KEY = "wordloop-cloud-leader-v1";
const SYNC_LEADER_LEASE = 12000;
const MEANING_PATCH_URL = "./personal/meanings-v1.json?v=20260811-10";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tabId = crypto.randomUUID();

let busy = false;
let rerunRequested = false;
let timer = 0;
let failureCount = 0;
let status = "waiting";
let syncedDeletedCount = null;
let deviceGroupCode = "";
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

function missingMeaning(value) {
  const meaning = String(value || "").trim();
  return meaning === "" || meaning === "暂无释义";
}

function applyMeaningPatchToLibrary(library, patch) {
  if (!Array.isArray(library?.words) || library.words.length === 0) {
    return { library, changed: 0, libraryFound: false };
  }
  if (
    patch?.format !== "wordloop-meaning-patch-v1" ||
    !Array.isArray(patch?.entries) ||
    !patch.datasetFingerprint ||
    patch.datasetFingerprint !== library.datasetFingerprint
  ) {
    throw new Error("释义补丁与当前词库版本不一致");
  }

  const entriesById = new Map(patch.entries.map((entry) => [String(entry.id), entry]));
  let changed = 0;
  const words = library.words.map((item) => {
    if (!missingMeaning(item?.meaning)) return item;
    const entry = entriesById.get(String(item?.id));
    if (
      !entry ||
      normalizeWord(entry.word) !== normalizeWord(item?.word) ||
      missingMeaning(entry.meaning)
    ) {
      return item;
    }
    changed += 1;
    return { ...item, meaning: String(entry.meaning).trim() };
  });
  return {
    library: changed > 0 ? { ...library, words } : library,
    changed,
    libraryFound: true,
  };
}

async function applyMeaningPatchBeforeApp() {
  const library = await readLocal(LIBRARY_KEY);
  if (!Array.isArray(library?.words) || library.words.length === 0) {
    return { libraryFound: false, changed: 0 };
  }
  const response = await fetch(MEANING_PATCH_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`释义补丁下载失败：${response.status}`);
  const result = applyMeaningPatchToLibrary(library, await response.json());
  if (result.changed > 0) await writeLocalEntries([[LIBRARY_KEY, result.library]]);
  return { libraryFound: true, changed: result.changed };
}

function scheduleMeaningPatchAfterApp(attempt = 0) {
  window.setTimeout(async () => {
    try {
      const result = await applyMeaningPatchBeforeApp();
      if (result.changed > 0) {
        reloadPreservingReadingPosition();
        return;
      }
      if (!result.libraryFound && attempt < 20) scheduleMeaningPatchAfterApp(attempt + 1);
    } catch (error) {
      if (attempt < 5) {
        scheduleMeaningPatchAfterApp(attempt + 1);
      } else {
        console.info("WordLoop释义补丁暂未载入。", error instanceof Error ? error.message : error);
      }
    }
  }, attempt === 0 ? 900 : 600);
}

function keyFromFragment() {
  return location.hash ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
}

function validPendingOperation(value) {
  return Boolean(
    value &&
      typeof value.opId === "string" &&
      typeof value.word === "string" &&
      typeof value.deleted === "boolean" &&
      (value.deleted || value.explicitRestore === true),
  );
}

function createOperation(word, deleted, explicitRestore = false) {
  return {
    opId: crypto.randomUUID(),
    word: normalizeWord(word),
    deleted: Boolean(deleted),
    explicitRestore: !deleted && explicitRestore === true,
  };
}

async function createMigrationOperation(word) {
  return {
    opId: `migration_${bytesToHex(await digest(`wordloop-sync-migration-v1:${word}`))}`,
    word,
    deleted: true,
  };
}

function acceptedCloudOperation(value) {
  const word = normalizeWord(value?.word);
  if (!word || typeof value?.deleted !== "boolean") return null;
  // Older clients could emit a restore when stale page state rewrote progress.
  // Only an explicit Undo/Restore action may now restore a deleted word.
  if (!value.deleted && value.explicitRestore !== true) return null;
  return { word, deleted: value.deleted, explicitRestore: value.explicitRestore === true };
}

function applyOperations(startingWords, operations) {
  const result = new Set(startingWords);
  for (const operation of operations) {
    if (operation.deleted) result.add(operation.word);
    else result.delete(operation.word);
  }
  return result;
}

function mergeDeletedWords(currentWords, protectedWords, remoteOperations, pendingOperations) {
  const localWords = new Set(currentWords);
  let result = applyOperations(new Set([...localWords, ...protectedWords]), remoteOperations);
  result = applyOperations(result, pendingOperations);
  // A cloud snapshot may add deletions, but it must never silently restore a
  // word already deleted on this device. A local Undo removes the word from
  // localWords first and is still carried by an explicit pending restore.
  for (const word of localWords) result.add(word);
  return result;
}

function sameWords(first, second) {
  if (first.size !== second.size) return false;
  for (const word of first) if (!second.has(word)) return false;
  return true;
}

function initialCloudRestoreNeeded(hasSyncedOnce, currentWords, mergedWords) {
  return !hasSyncedOnce && currentWords.size === 0 && mergedWords.size > 0;
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
    standby: "另一窗口正在同步 · 点此接管",
    syncing: "云同步中…",
    synced:
      syncedDeletedCount === null
        ? `云端已同步${deviceGroupCode ? ` · 设备组${deviceGroupCode}` : ""}`
        : `云端已同步 · 已删${syncedDeletedCount.toLocaleString()}词${deviceGroupCode ? ` · 组${deviceGroupCode}` : ""}`,
    offline: "离线保存 · 联网后同步",
  }[value];
}

function nextSyncDelay() {
  return document.visibilityState === "visible" ? FOREGROUND_SYNC_DELAY : BACKGROUND_SYNC_DELAY;
}

function claimSyncLeadership(force = false) {
  try {
    const now = Date.now();
    const saved = JSON.parse(localStorage.getItem(SYNC_LEADER_KEY) || "null");
    if (!force && saved?.tabId !== tabId && Number(saved?.expiresAt) > now) return false;
    localStorage.setItem(SYNC_LEADER_KEY, JSON.stringify({ tabId, expiresAt: now + SYNC_LEADER_LEASE }));
    return true;
  } catch {
    return true;
  }
}

function releaseSyncLeadership() {
  try {
    const saved = JSON.parse(localStorage.getItem(SYNC_LEADER_KEY) || "null");
    if (saved?.tabId === tabId) localStorage.removeItem(SYNC_LEADER_KEY);
  } catch {
    // Continue normally when localStorage is unavailable.
  }
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

async function shareSyncLink() {
  const personalKey = await currentPersonalKey();
  if (!personalKey) {
    await connectCloudSync();
    return;
  }
  const link = new URL(location.href);
  link.hash = `key=${personalKey}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: "WordLoop三端同步",
        text: "在iPad或Mac打开一次即可自动载入词库和同步进度，无需导入JSON。",
        url: link.toString(),
      });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(link.toString());
    window.alert("三端同步链接已复制。请在iPad或Mac打开一次，无需导入JSON。");
  } catch {
    window.prompt("请复制下面的三端同步链接：", link.toString());
  }
}

async function keepShareableKeyInAddressBar() {
  try {
    const personalKey = await currentPersonalKey();
    if (!personalKey || keyFromFragment() === personalKey) return;
    const link = new URL(location.href);
    link.hash = `key=${personalKey}`;
    window.history.replaceState(null, "", link);
  } catch {
    // The app still works locally if the address cannot be updated.
  }
}

function installShareableAddress() {
  for (const delay of [0, 600, 1800, 5000, 12000]) {
    window.setTimeout(() => void keepShareableKeyInAddressBar(), delay);
  }
  window.addEventListener("focus", () => void keepShareableKeyInAddressBar());
  window.addEventListener("pageshow", () => void keepShareableKeyInAddressBar());
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

function preferredDeleteSide() {
  try {
    return localStorage.getItem(DELETE_SIDE_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

function applyDeleteSide(side = preferredDeleteSide()) {
  const left = side === "left";
  document.body.classList.toggle("delete-side-left", left);
  for (const button of document.querySelectorAll(".delete-side-toggle")) {
    const text = left ? "← 删除：左侧" : "删除：右侧 →";
    const label = left ? "把删除按钮移到右边" : "把删除按钮移到左边";
    if (button.textContent !== text) button.textContent = text;
    if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
    if (button.getAttribute("aria-pressed") !== String(left)) button.setAttribute("aria-pressed", String(left));
  }
}

function toggleDeleteSide() {
  const next = preferredDeleteSide() === "left" ? "right" : "left";
  try {
    localStorage.setItem(DELETE_SIDE_KEY, next);
  } catch {
    // The switch still works for this page when storage is unavailable.
  }
  applyDeleteSide(next);
}

function renderDeleteSideToggle() {
  const summary = document.querySelector(".bottom-summary");
  if (!summary) return;
  let button = summary.querySelector(".delete-side-toggle");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "delete-side-toggle";
    button.addEventListener("click", toggleDeleteSide);
    const exportButton = summary.querySelector(":scope > button");
    if (exportButton) exportButton.before(button);
    else summary.append(button);
  }
  applyDeleteSide();
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
    shareButton.textContent = "分享至iPad/Mac（无需导入）";
    shareButton.addEventListener("click", shareSyncLink);
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
  const immediateResult = await runSync(true);
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
  renderDeleteSideToggle();
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
        void runSync(true);
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
  const deletedWords = Array.isArray(progress?.deletedWords)
    ? [...new Set(progress.deletedWords.map(normalizeWord).filter(Boolean))]
    : [];
  if (savedMeta?.version === 1 && savedMeta.initialized) {
    const pending = Array.isArray(savedMeta.pending) ? savedMeta.pending.filter(validPendingOperation) : [];
    const previousDeleted = Array.isArray(savedMeta.lastObservedDeleted)
      ? savedMeta.lastObservedDeleted.map(normalizeWord).filter(Boolean)
      : [];
    if (savedMeta.syncPolicyVersion === SYNC_POLICY_VERSION) {
      return {
        ...savedMeta,
        pending,
        lastObservedDeleted: [...new Set([...previousDeleted, ...deletedWords])].sort(),
        snapshotDeletedWords: Array.isArray(savedMeta.snapshotDeletedWords)
          ? [...new Set(savedMeta.snapshotDeletedWords.map(normalizeWord).filter(Boolean))].sort()
          : [],
      };
    }

    const snapshotOperations = await Promise.all(
      [...new Set([...previousDeleted, ...deletedWords])].map(createMigrationOperation),
    );
    const operationIds = new Set(pending.map((operation) => operation.opId));
    for (const operation of snapshotOperations) {
      if (!operationIds.has(operation.opId)) pending.push(operation);
    }
    return {
      ...savedMeta,
      syncPolicyVersion: SYNC_POLICY_VERSION,
      cursor: 0,
      pending,
      lastObservedDeleted: [...new Set([...previousDeleted, ...deletedWords])].sort(),
      snapshotDeletedWords: [],
    };
  }
  const pending = await Promise.all(deletedWords.map(createMigrationOperation));
  return {
    version: 1,
    initialized: true,
    syncPolicyVersion: SYNC_POLICY_VERSION,
    cursor: 0,
    uiRevision: 0,
    hasSyncedOnce: false,
    pending,
    lastObservedDeleted: deletedWords.sort(),
    snapshotDeletedWords: [],
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
  meta.pending = meta.pending.filter((operation) => operation.deleted || operation.explicitRestore);
  meta.lastObservedDeleted = [...new Set([...previous, ...current])].sort();

  if (meta.hasSyncedOnce || meta.lastObservedActiveList !== null) {
    const listChanged = Number(progress.activeList) !== Number(meta.lastObservedActiveList);
    const meaningChanged = Boolean(progress.showMeaning) !== Boolean(meta.lastObservedShowMeaning);
    if (listChanged || meaningChanged) meta.uiDirty = true;
  }
  meta.lastObservedActiveList = Number(progress.activeList) || 1;
  meta.lastObservedShowMeaning = progress.showMeaning !== false;
  return meta;
}

async function ensureMonotonicSnapshot(progress, meta) {
  const knownDeleted = new Set([
    ...(meta.lastObservedDeleted || []).map(normalizeWord),
    ...(Array.isArray(progress?.deletedWords) ? progress.deletedWords : []).map(normalizeWord),
  ]);
  const uploadedSnapshot = new Set((meta.snapshotDeletedWords || []).map(normalizeWord));
  const pendingIds = new Set(meta.pending.map((operation) => operation.opId));
  const missingWords = [...knownDeleted].filter(Boolean).filter((word) => !uploadedSnapshot.has(word));
  const operations = await Promise.all(missingWords.map(createMigrationOperation));
  for (const operation of operations) {
    if (!pendingIds.has(operation.opId)) {
      meta.pending.push(operation);
      pendingIds.add(operation.opId);
    }
  }
  return meta;
}

async function queueExplicitRestores(words = null) {
  try {
    const [progress, savedMeta] = await Promise.all([readLocal(PROGRESS_KEY), readLocal(SYNC_META_KEY)]);
    if (!progress || !savedMeta) return;
    const meta = await initializeMeta(progress, savedMeta);
    const current = new Set(
      (Array.isArray(progress.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean),
    );
    const previous = new Set((meta.lastObservedDeleted || []).map(normalizeWord));
    const requested = words ? new Set(words.map(normalizeWord)) : previous;
    const restored = [...requested].filter((word) => previous.has(word) && !current.has(word));
    if (restored.length === 0) return;
    meta.pending.push(...restored.map((word) => createOperation(word, false, true)));
    meta.lastObservedDeleted = [...previous].filter((word) => !restored.includes(word)).sort();
    await writeLocalEntries([[SYNC_META_KEY, meta]]);
    failureCount = 0;
    schedule(50);
  } catch (error) {
    console.info("WordLoop撤销同步暂不可用。", error instanceof Error ? error.message : error);
  }
}

function installExplicitRestoreBridge() {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const undoButton = target?.closest(".undo-toast button");
      if (undoButton) {
        const word = document.querySelector(".undo-toast strong")?.textContent?.trim();
        if (word) window.setTimeout(() => queueExplicitRestores([word]), 350);
        return;
      }
      const actionButton = target?.closest(".action-sheet button");
      if (actionButton?.textContent?.includes("恢复当前List已删除词")) {
        window.setTimeout(() => queueExplicitRestores(), 350);
      }
    },
    true,
  );
}

async function postSync(credentials, cursor, pending, uiState) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const operations = await Promise.all(
      pending.map(async (operation) => ({
        opId: operation.opId,
        payload: await encryptPayload(
          {
            word: operation.word,
            deleted: operation.deleted,
            explicitRestore: !operation.deleted && operation.explicitRestore === true,
          },
          credentials,
        ),
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

async function runSync(forceLeadership = false) {
  if (busy) {
    rerunRequested = true;
    return "queued";
  }
  if (!claimSyncLeadership(forceLeadership)) {
    setStatus("standby");
    schedule(4000);
    return "standby";
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

    const credentials = await deriveCredentials(personalKey);
    const compatibleSavedMeta =
      savedMeta?.syncId && savedMeta.syncId !== credentials.syncId ? null : savedMeta;
    let progress = initialProgress;
    let meta = observeLocalChanges(progress, await initializeMeta(progress, compatibleSavedMeta));
    meta.syncId = credentials.syncId;
    const hasSyncedOnceAtStart = Boolean(meta.hasSyncedOnce);
    meta = await ensureMonotonicSnapshot(progress, meta);
    await writeLocalEntries([[SYNC_META_KEY, meta]]);
    setStatus("syncing");
    deviceGroupCode = credentials.syncId.slice(0, 6).toUpperCase();
    let cursor = Math.max(0, Number(meta.cursor) || 0);
    const remoteOperations = [];
    const pendingQueue = [...meta.pending];
    const acknowledged = new Set();
    const acknowledgedOperations = [];
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
      for (const operation of sent) {
        acknowledged.add(operation.opId);
        acknowledgedOperations.push(operation);
      }
      for (const event of response.events) {
        const operation = acceptedCloudOperation(await decryptPayload(event.payload, credentials));
        if (operation) remoteOperations.push(operation);
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
    meta = await ensureMonotonicSnapshot(progress, meta);
    meta.pending = meta.pending.filter((operation) => !acknowledged.has(operation.opId));
    const currentWords = new Set(
      (Array.isArray(progress.deletedWords) ? progress.deletedWords : []).map(normalizeWord).filter(Boolean),
    );
    const protectedDeletedWords = new Set([
      ...(meta.lastObservedDeleted || []).map(normalizeWord),
      ...(meta.snapshotDeletedWords || []).map(normalizeWord),
    ]);
    const mergedWords = mergeDeletedWords(currentWords, protectedDeletedWords, remoteOperations, meta.pending);
    const wordsChanged = !sameWords(currentWords, mergedWords);
    const reloadAfterInitialCloudRestore = initialCloudRestoreNeeded(
      hasSyncedOnceAtStart,
      currentWords,
      mergedWords,
    );

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
    let confirmedSnapshot = applyOperations(
      new Set((meta.snapshotDeletedWords || []).map(normalizeWord)),
      remoteOperations,
    );
    confirmedSnapshot = applyOperations(confirmedSnapshot, acknowledgedOperations);
    meta.snapshotDeletedWords = [...confirmedSnapshot].sort();
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
    if (reloadAfterInitialCloudRestore) {
      window.setTimeout(() => location.reload(), 120);
    }
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
  if (meta.syncPolicyVersion !== SYNC_POLICY_VERSION) {
    // Never apply a snapshot written by the legacy client that could contain
    // accidental restores. Policy 3 replays the encrypted event history safely.
    meta.applyOnNextLoad = false;
    delete meta.appliedDeletedWords;
    await writeLocalEntries([[SYNC_META_KEY, meta]]);
    return;
  }
  const localDeletedWords = Array.isArray(progress.deletedWords)
    ? progress.deletedWords.map(normalizeWord).filter(Boolean)
    : [];
  progress.deletedWords = [
    ...new Set([...localDeletedWords, ...meta.appliedDeletedWords.map(normalizeWord).filter(Boolean)]),
  ].sort();
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
    if (!word) return;
    const offset = anchor ? Math.max(0, anchor.getBoundingClientRect().top) : 0;
    const saved = JSON.stringify({ word, offset, scrollTop: window.scrollY, savedAt: Date.now() });
    sessionStorage.setItem(READING_POSITION_KEY, saved);
    localStorage.setItem(PERSISTED_READING_POSITION_KEY, saved);
  } catch {
    // Some private browsing modes may not expose web storage.
  }
}

function reloadPreservingReadingPosition() {
  captureReadingPosition();
  location.reload();
}

function restoreReadingPosition() {
  let saved;
  try {
    saved = JSON.parse(
      sessionStorage.getItem(READING_POSITION_KEY) ||
        localStorage.getItem(PERSISTED_READING_POSITION_KEY) ||
        "null",
    );
    sessionStorage.removeItem(READING_POSITION_KEY);
  } catch {
    return;
  }
  if (!saved || Date.now() - Number(saved.savedAt || 0) > 30 * 24 * 60 * 60 * 1000) return;

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
    if (loadMore instanceof HTMLButtonElement && attempt < 60) {
      loadMore.click();
      window.setTimeout(() => restore(attempt + 1), 80);
      return;
    }
    if (rows.length === 0 && attempt < 80) {
      window.setTimeout(() => restore(attempt + 1), 150);
      return;
    }
    window.scrollTo({ top: Math.max(0, Number(saved.scrollTop) || 0), behavior: "auto" });
  };
  window.setTimeout(restore, 250);
}

function installReadingPositionPersistence() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let saveTimer = 0;
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(captureReadingPosition, 260);
  };
  window.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("pagehide", captureReadingPosition);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") captureReadingPosition();
  });
}

function installFullListPreloader() {
  let loading = false;
  let timer = 0;
  const loadAll = () => {
    if (loading) return;
    loading = true;
    const step = () => {
      timer = 0;
      const loadMore = document.querySelector(".load-more");
      if (!(loadMore instanceof HTMLButtonElement) || !loadMore.isConnected) {
        loading = false;
        return;
      }
      loadMore.click();
      timer = window.setTimeout(step, 36);
    };
    step();
  };
  const schedule = () => {
    if (loading || timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      loadAll();
    }, 20);
  };
  new MutationObserver(schedule).observe(document.getElementById("root") || document.body, {
    childList: true,
    subtree: true,
  });
  schedule();
}

async function startBrowserApp() {
  applyDeleteSide();
  try {
    await applyCloudSnapshotBeforeApp();
  } catch (error) {
    console.info("WordLoop启动前进度恢复失败，将继续使用本机数据。", error instanceof Error ? error.message : error);
  }
  await import("./assets/index-DiX3UPkj.js");
  // Meaning updates run only after the app is usable, so a slow connection can
  // never leave the user stuck on “正在核对并更新词库”.
  scheduleMeaningPatchAfterApp();
  installExplicitRestoreBridge();
  installReadingPositionPersistence();
  installFullListPreloader();
  installShareableAddress();
  restoreReadingPosition();
  const observer = new MutationObserver(renderStatus);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("online", () => schedule(100));
  window.addEventListener("focus", () => schedule(250));
  window.addEventListener("pageshow", () => schedule(250));
  window.addEventListener("pagehide", () => {
    void runSync(true);
  });
  window.addEventListener("unload", releaseSyncLeadership);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedule(250);
      watchLocalProgress();
    } else {
      void runSync(true).finally(releaseSyncLeadership);
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
  acceptedCloudOperation,
  applyMeaningPatchToLibrary,
  applyOperations,
  createMigrationOperation,
  decryptPayload,
  deletedWordsFromRemaining,
  deriveCredentials,
  encryptPayload,
  importOldProgress,
  initializeMeta,
  initialCloudRestoreNeeded,
  mergeDeletedWords,
  nextSyncDelay,
  normalizeWord,
  personalKeyFromInput,
  progressSignature,
};
