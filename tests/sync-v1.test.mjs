import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptedCloudOperation,
  applyMeaningPatchToLibrary,
  applyOperations,
  createMigrationOperation,
  decryptPayload,
  deletedWordsFromRemaining,
  deriveCredentials,
  encryptPayload,
  initializeMeta,
  initialCloudRestoreNeeded,
  mergeDeletedWords,
  personalKeyFromInput,
  progressSignature,
} from "../sync-v1.js";

const root = new URL("../", import.meta.url);

test("loads the cloud sync layer before WordLoop", async () => {
  const [html, sync] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("sync-v1.js", root), "utf8"),
  ]);
  assert.match(html, /sync-v1\.js/);
  assert.doesNotMatch(html, /<script[^>]+index-DiX3UPkj\.js/);
  assert.match(sync, /import\("\.\/assets\/index-DiX3UPkj\.js"\)/);
  assert.match(sync, /wordloop-personal-v6/);
  assert.match(sync, /cloud-sync-v1/);
  assert.match(sync, /migration_/);
  assert.match(sync, /未连接云端 · 点此连接/);
  assert.match(sync, /离线保存 · 联网后同步/);
  assert.match(sync, /连接云同步/);
  assert.match(sync, /重新上传本机删除记录/);
  assert.match(sync, /applyCloudSnapshotBeforeApp/);
  assert.match(sync, /导入iPhone备份并同步三端/);
  assert.match(sync, /authoritativeImportAt/);
  assert.match(sync, /renderProgressImporter\(\);\s+renderCloudConnector\(\);/);
  assert.match(sync, /分享至iPad\/Mac（无需导入）/);
  assert.match(sync, /立即同步三台设备/);
  assert.match(sync, /正在同步…/);
  assert.match(sync, /同步完成 \u2713/);
  assert.match(sync, /syncButton\.addEventListener\("click", manualSyncNow\)/);
  assert.match(sync, /FOREGROUND_SYNC_DELAY = 5000/);
  assert.match(sync, /LOCAL_WATCH_DELAY = 750/);
  assert.match(sync, /pagehide/);
  assert.match(sync, /rerunRequested/);
  assert.match(sync, /reloadPreservingReadingPosition/);
  assert.match(sync, /restoreReadingPosition/);
  assert.match(sync, /wordloop-reading-position-persistent-v1/);
  assert.match(sync, /installReadingPositionPersistence/);
  assert.match(sync, /installFullListPreloader/);
  assert.match(sync, /installShareableAddress/);
  assert.match(sync, /reloadAfterInitialCloudRestore/);
  assert.match(sync, /meta\.syncId = credentials\.syncId/);
  assert.match(sync, /navigator\.share/);
  assert.match(sync, /link\.hash = `key=\$\{personalKey\}`/);
  assert.doesNotMatch(sync, /renderIncomingProgressNotice|cloud-progress-notice|fast-scroll-control/);
  assert.doesNotMatch(sync, /wordsChanged[^\n]*location\.reload/);
  assert.match(sync, /wordloop-delete-side-v1/);
  assert.match(sync, /renderDeleteSideToggle/);
  assert.match(sync, /把删除按钮移到左边/);
  assert.match(html, /delete-side-left/);
  assert.match(sync, /document\.querySelector\("\.bottom-summary"\)/);
  assert.match(sync, /删除：右侧/);
  assert.match(sync, /button\.textContent !== text/);
  assert.match(sync, /SYNC_POLICY_VERSION = 4/);
  assert.match(sync, /ensureMonotonicSnapshot/);
  assert.match(sync, /installExplicitRestoreBridge/);
  assert.match(sync, /SYNC_LEADER_LEASE/);
  assert.doesNotMatch(sync, /wordsChanged[^\n]*reloadPreservingReadingPosition/);
  assert.match(sync, /设备组/);
  assert.match(sync, /serviceWorker\.register\("\.\/sw\.js"\)/);
  assert.match(sync, /personal\/meanings-v1\.json/);
  assert.match(sync, /scheduleMeaningPatchAfterApp/);
  assert.doesNotMatch(sync, /Promise\.all\(\[applyCloudSnapshotBeforeApp\(\), applyMeaningPatchBeforeApp\(\)\]\)/);
  assert.match(html, /content-visibility: auto/);
  assert.doesNotMatch(html, /fast-scroll-control/);
  assert.match(sync, /datasetFingerprint/);
  assert.match(sync, /AES-GCM/);
});

test("detects local deletion and list changes for immediate handoff sync", () => {
  assert.notEqual(
    progressSignature({ deletedWords: ["coverage"], activeList: 1, showMeaning: true }),
    progressSignature({ deletedWords: ["coverage", "stir"], activeList: 1, showMeaning: true }),
  );
  assert.notEqual(
    progressSignature({ deletedWords: ["coverage"], activeList: 1, showMeaning: true }),
    progressSignature({ deletedWords: ["coverage"], activeList: 2, showMeaning: true }),
  );
});

test("new devices reload once after receiving their first cloud deletion snapshot", () => {
  assert.equal(initialCloudRestoreNeeded(false, new Set(), new Set(["coverage"])), true);
  assert.equal(initialCloudRestoreNeeded(true, new Set(), new Set(["coverage"])), false);
  assert.equal(initialCloudRestoreNeeded(false, new Set(["coverage"]), new Set(["coverage", "stir"])), false);
});

test("converts an iPhone remaining-word backup into authoritative deletions", () => {
  const deleted = deletedWordsFromRemaining(
    [{ word: "coverage" }, { word: "stir" }, { word: "adept" }, { word: "fault" }],
    [{ word: "stir" }, { word: "fault" }],
  );
  assert.deepEqual(deleted, ["coverage", "adept"]);
});

test("ships an offline shell without caching the cross-origin sync API", async () => {
  const worker = await readFile(new URL("sw.js", root), "utf8");
  assert.match(worker, /personal\/library\.enc\.json/);
  assert.match(worker, /personal\/meanings-v1\.json/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(worker, /workers\.dev/);
});

test("fills only empty meanings for the matching library fingerprint", () => {
  const library = {
    datasetFingerprint: "fingerprint-v1",
    words: [
      { id: 1, word: "doodle", meaning: "暂无释义" },
      { id: 2, word: "known", meaning: "已有释义" },
      { id: 3, word: "untouched", meaning: "" },
    ],
  };
  const patch = {
    format: "wordloop-meaning-patch-v1",
    datasetFingerprint: "fingerprint-v1",
    entries: [
      { id: 1, word: "doodle", meaning: "涂鸦" },
      { id: 2, word: "known", meaning: "不应覆盖" },
      { id: 3, word: "wrong-word", meaning: "不应错配" },
    ],
  };
  const result = applyMeaningPatchToLibrary(library, patch);
  assert.equal(result.changed, 1);
  assert.equal(result.library.words[0].meaning, "涂鸦");
  assert.equal(result.library.words[1].meaning, "已有释义");
  assert.equal(result.library.words[2].meaning, "");
});

test("rejects a meaning patch for a different dataset", () => {
  assert.throws(
    () =>
      applyMeaningPatchToLibrary(
        { datasetFingerprint: "current", words: [{ id: 1, word: "doodle", meaning: "暂无释义" }] },
        { format: "wordloop-meaning-patch-v1", datasetFingerprint: "other", entries: [] },
      ),
    /词库版本不一致/,
  );
});

test("encrypts opaque progress and creates deterministic migration ids", async () => {
  const key = "test-only-personal-key-not-a-real-secret-0123456789";
  const credentials = await deriveCredentials(key);
  const sealed = await encryptPayload({ word: "coverage", deleted: true }, credentials);
  assert.ok(!sealed.includes("coverage"));
  assert.deepEqual(await decryptPayload(sealed, credentials), { word: "coverage", deleted: true });

  const first = await createMigrationOperation("coverage");
  const second = await createMigrationOperation("coverage");
  assert.equal(first.opId, second.opId);
  assert.match(first.opId, /^migration_[a-f0-9]{64}$/);
});

test("ordered safe delete or explicit restore event wins", () => {
  const result = applyOperations([], [
    { word: "coverage", deleted: true },
    { word: "stir", deleted: true },
    { word: "coverage", deleted: false, explicitRestore: true },
  ]);
  assert.deepEqual([...result], ["stir"]);
});

test("rejects legacy accidental restores but accepts explicit restores", () => {
  assert.deepEqual(acceptedCloudOperation({ word: "coverage", deleted: true }), {
    word: "coverage",
    deleted: true,
    explicitRestore: false,
  });
  assert.equal(acceptedCloudOperation({ word: "coverage", deleted: false }), null);
  assert.deepEqual(acceptedCloudOperation({ word: "coverage", deleted: false, explicitRestore: true }), {
    word: "coverage",
    deleted: false,
    explicitRestore: true,
  });
});

test("policy upgrade drops queued legacy restores and replays from the beginning", async () => {
  const upgraded = await initializeMeta(
    { deletedWords: [] },
    {
      version: 1,
      initialized: true,
      syncPolicyVersion: 1,
      cursor: 912,
      pending: [{ opId: "legacy-restore", word: "coverage", deleted: false }],
      lastObservedDeleted: ["coverage"],
    },
  );
  assert.equal(upgraded.syncPolicyVersion, 4);
  assert.equal(upgraded.cursor, 0);
  assert.ok(upgraded.pending.every((operation) => operation.deleted || operation.explicitRestore === true));
  assert.ok(upgraded.pending.some((operation) => operation.word === "coverage" && operation.deleted));
});

test("protected cloud snapshot survives stale local progress", () => {
  const result = mergeDeletedWords([], ["coverage"], [{ word: "stir", deleted: true }], []);
  assert.deepEqual([...result], ["coverage", "stir"]);
});

test("an explicit cloud undo can restore a word not locally deleted", () => {
  const result = mergeDeletedWords(
    [],
    ["coverage"],
    [{ word: "coverage", deleted: false, explicitRestore: true }],
    [],
  );
  assert.deepEqual([...result], []);
});

test("a stale cloud restore cannot undo this device's deletion", () => {
  const result = mergeDeletedWords(
    ["coverage"],
    ["coverage"],
    [{ word: "coverage", deleted: false, explicitRestore: true }],
    [],
  );
  assert.deepEqual([...result], ["coverage"]);
});

test("accepts only a valid personal link or key", () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(personalKeyFromInput(key), key);
  assert.equal(personalKeyFromInput(`https://example.com/#key=${key}`), key);
  assert.throws(() => personalKeyFromInput("https://example.com/"), /格式不正确/);
});
