import assert from "node:assert/strict";

import { applyOperations, decryptPayload, deriveCredentials, encryptPayload } from "../sync-v1.js";

const SYNC_URL = "https://wordloop-sync.wordloop-20191864123.workers.dev/v1/sync";
const TEST_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

async function sync(credentials, cursor, operations) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  const { ProxyAgent, fetch } = await import("../../wordloop-web/node_modules/undici/index.js");
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const sealedOperations = await Promise.all(
    operations.map(async (operation) => ({
      opId: operation.opId,
      payload: await encryptPayload({ word: operation.word, deleted: operation.deleted }, credentials),
    })),
  );
  const response = await fetch(SYNC_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.authToken}`,
      "Content-Type": "application/json",
      Origin: "https://20191864123.github.io",
    },
    body: JSON.stringify({ syncId: credentials.syncId, cursor, operations: sealedOperations, uiState: null }),
    dispatcher,
  });
  assert.equal(response.status, 200);
  return response.json();
}

if (process.env.WORDLOOP_LIVE_SMOKE !== "1") {
  console.log("Skipped live sync smoke test; set WORDLOOP_LIVE_SMOKE=1 to run it.");
} else {
  const credentials = await deriveCredentials(TEST_KEY);
  const deleteId = `smoke_delete_${crypto.randomUUID()}`;
  const restoreId = `smoke_restore_${crypto.randomUUID()}`;
  const testWord = `wordloop-smoke-${crypto.randomUUID()}`;

  await sync(credentials, 0, [{ opId: deleteId, word: testWord, deleted: true }]);
  const secondDevice = await sync(credentials, 0, []);
  const deleteEvent = secondDevice.events.find((event) => event.opId === deleteId);
  assert.ok(deleteEvent, "second device did not receive the delete event");
  const deleted = await decryptPayload(deleteEvent.payload, credentials);
  assert.deepEqual(deleted, { word: testWord, deleted: true });

  await sync(credentials, secondDevice.cursor, [{ opId: restoreId, word: testWord, deleted: false }]);
  const firstDevice = await sync(credentials, secondDevice.cursor, []);
  const decoded = await Promise.all(firstDevice.events.map((event) => decryptPayload(event.payload, credentials)));
  const merged = applyOperations(new Set([testWord]), decoded);
  assert.equal(merged.has(testWord), false, "first device did not receive the restore event");

  console.log(JSON.stringify({ ok: true, syncId: credentials.syncId, deleteId, restoreId }));
}
