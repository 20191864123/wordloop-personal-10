import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyOperations,
  createMigrationOperation,
  decryptPayload,
  deletedWordsFromRemaining,
  deriveCredentials,
  encryptPayload,
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
  assert.match(sync, /复制三端同步链接/);
  assert.match(sync, /立即同步三台设备/);
  assert.match(sync, /正在同步…/);
  assert.match(sync, /同步完成 \u2713/);
  assert.match(sync, /syncButton\.addEventListener\("click", manualSyncNow\)/);
  assert.match(sync, /FOREGROUND_SYNC_DELAY = 5000/);
  assert.match(sync, /LOCAL_WATCH_DELAY = 750/);
  assert.match(sync, /pagehide/);
  assert.match(sync, /rerunRequested/);
  assert.match(sync, /renderIncomingProgressNotice/);
  assert.match(sync, /reloadPreservingReadingPosition/);
  assert.match(sync, /restoreReadingPosition/);
  assert.doesNotMatch(sync, /wordsChanged[^\n]*location\.reload/);
  assert.match(sync, /serviceWorker\.register\("\.\/sw\.js"\)/);
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
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(worker, /workers\.dev/);
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

test("later delete or restore event wins", () => {
  const result = applyOperations([], [
    { word: "coverage", deleted: true },
    { word: "stir", deleted: true },
    { word: "coverage", deleted: false },
  ]);
  assert.deepEqual([...result], ["stir"]);
});

test("accepts only a valid personal link or key", () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(personalKeyFromInput(key), key);
  assert.equal(personalKeyFromInput(`https://example.com/#key=${key}`), key);
  assert.throws(() => personalKeyFromInput("https://example.com/"), /格式不正确/);
});
