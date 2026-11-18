// Promises Verd makes that hold for every line of shipped code, checked by reading it.
//
//   cd tests && node --test guardrails.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHIPPED = ['index.html', 'app.js', 'core.js', 'sw.js'];
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('no notifications of any kind: no push, no notification permission, no badge number on the app icon', () => {
  for (const f of SHIPPED)
    assert.doesNotMatch(read(f), /\bNotification\b|PushManager|pushManager|showNotification|setAppBadge|periodicSync|addEventListener\(\s*["']push["']|onpush\b/, f);
});
