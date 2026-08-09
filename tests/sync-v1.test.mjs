import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyOperations,
  createMigrationOperation,
  decryptPayload,
  deriveCredentials,
  encryptPayload,
  personalKeyFromInput,
} from "../sync-v1.js";

const root = new URL("../", import.meta.url);

test("loads the cloud sync layer before WordLoop", async () => {
  const [html, sync] = await Promise.all([
    readFile(new URL("index.html", root), "utf8"),
    readFile(new URL("sync-v1.js", root), "utf8"),
  ]);
  assert.match(html, /sync-v1\.js[\s\S]+index-DiX3UPkj\.js/);
  assert.match(sync, /wordloop-personal-v6/);
  assert.match(sync, /cloud-sync-v1/);
  assert.match(sync, /migration_/);
  assert.match(sync, /未连接云端 · 点此连接/);
  assert.match(sync, /离线保存 · 联网后同步/);
  assert.match(sync, /连接云同步/);
  assert.match(sync, /导入旧版删除进度/);
  assert.match(sync, /datasetFingerprint/);
  assert.match(sync, /AES-GCM/);
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
