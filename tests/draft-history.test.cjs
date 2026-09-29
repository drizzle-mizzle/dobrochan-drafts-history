const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const script = readFileSync(path.join(__dirname, '..', 'dobrochan_draft_history_v0_2.user.js'), 'utf8');
const startMarker = '    init().catch(error => {';
assert.ok(script.includes(startMarker));
const instrumented = script.replace(startMarker, `
    globalThis.ddhTest = {
        setup(sc, ta) { scope = sc; textarea = ta; tabId = uuid(); },
        newDraft, writeDraft, readDraft, createActiveDraft, getCurrentDraft,
        heartbeat, restoreOrStart, flushTextNow, cleanupHistory,
        failPendingSubmission, finalizeSuccessfulSubmission,
        setPending(draftId, submittedText) {
            pendingSubmission = { draftId, submittedText, pollTimer: null, timeoutTimer: null };
        },
        get currentDraftId() { return currentDraftId; },
        get instanceId() { return instanceId; }
    };
    if (false) init().catch(error => {`);

function openTab(storage, session = new Map(), withLocks = true) {
    let draftWrites = 0;
    const timers = [];
    const textarea = { value: '', dispatchEvent() {} };
    const context = {
        crypto: webcrypto,
        console,
        Date,
        Event: class Event {},
        location: { origin: 'https://rf.dobrochan.net' },
        navigator: withLocks ? { locks: { request: async (_name, _options, callback) => callback() } } : {},
        document: { body: null, getElementById: () => null },
        sessionStorage: {
            getItem: key => session.get(key) ?? null,
            setItem: (key, value) => session.set(key, value),
            removeItem: key => session.delete(key)
        },
        GM_getValue: (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback,
        GM_setValue: (key, value) => {
            if (key.startsWith('ddh:v1:draft:')) draftWrites++;
            storage.set(key, structuredClone(value));
        },
        GM_deleteValue: key => storage.delete(key),
        GM_listValues: () => [...storage.keys()],
        setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
        clearTimeout
    };
    vm.runInNewContext(instrumented, context);
    const api = context.ddhTest;
    api.setup({ board: 'b', threadId: '123', key: 'b/123', url: 'https://rf.dobrochan.net/vichan/b/res/123.html', title: 'Test' }, textarea);
    return { api, textarea, session, timers, get draftWrites() { return draftWrites; } };
}

test('heartbeat does not rewrite the draft and revisions have a total size limit', () => {
    const storage = new Map();
    const tab = openTab(storage);
    const draft = tab.api.createActiveDraft('current');
    const writes = tab.draftWrites;
    tab.api.heartbeat();
    assert.equal(tab.draftWrites, writes);

    draft.revisions = Array.from({ length: 3 }, (_, i) => ({ at: i, text: String(i).repeat(40000) }));
    tab.api.writeDraft(draft);
    assert.equal(tab.api.readDraft(draft.id).revisions.length, 2);
    assert.equal(tab.api.readDraft(draft.id).text, 'current');
});

test('an abandoned draft is reclaimed when its owner has no lease', async () => {
    const storage = new Map();
    const oldTab = openTab(storage);
    const original = oldTab.api.createActiveDraft('saved text');
    original.status = 'abandoned';
    oldTab.api.writeDraft(original);
    storage.delete(`ddh:v1:lease:${oldTab.api.instanceId}`);

    const nextTab = openTab(storage);
    const recovered = await nextTab.api.restoreOrStart();
    assert.equal(recovered.id, original.id);
    assert.equal(nextTab.textarea.value, 'saved text');
    assert.equal(nextTab.api.readDraft(original.id).status, 'active');
});

test('a fresh lease causes a copy instead of takeover', async () => {
    const storage = new Map();
    const oldTab = openTab(storage);
    const original = oldTab.api.createActiveDraft('saved text');
    const session = new Map([['ddh:v1:current-draft-id', original.id]]);

    const nextTab = openTab(storage, session);
    const recovered = await nextTab.api.restoreOrStart();
    assert.notEqual(recovered.id, original.id);
    assert.equal(recovered.text, original.text);
    assert.equal(nextTab.api.readDraft(original.id).claimToken, original.claimToken);
});

test('without Web Locks recovery copies an orphan instead of claiming its record', async () => {
    const storage = new Map();
    const oldTab = openTab(storage);
    const original = oldTab.api.createActiveDraft('saved text');
    storage.delete(`ddh:v1:lease:${oldTab.api.instanceId}`);

    const nextTab = openTab(storage, new Map(), false);
    const recovered = await nextTab.api.restoreOrStart();
    assert.notEqual(recovered.id, original.id);
    assert.equal(nextTab.api.readDraft(original.id).claimToken, original.claimToken);
});

test('recovery retries after a fresh lease expires if no tab session points to the draft', async () => {
    const storage = new Map();
    const oldTab = openTab(storage);
    const original = oldTab.api.createActiveDraft('saved text');
    const nextTab = openTab(storage);

    assert.equal(await nextTab.api.restoreOrStart(), null);
    assert.equal(nextTab.timers.length, 1);
    storage.delete(`ddh:v1:lease:${oldTab.api.instanceId}`);
    nextTab.timers[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nextTab.api.currentDraftId, original.id);
    assert.equal(nextTab.textarea.value, 'saved text');
});

test('a tab that lost ownership saves subsequent input to a new draft', () => {
    const storage = new Map();
    const tab = openTab(storage);
    const original = tab.api.createActiveDraft('old text');
    const stolen = tab.api.readDraft(original.id);
    stolen.claimToken = 'another-owner';
    storage.set(`ddh:v1:draft:${original.id}`, stolen);

    tab.textarea.value = 'new text';
    const replacement = tab.api.flushTextNow();
    assert.notEqual(replacement.id, original.id);
    assert.equal(tab.api.readDraft(original.id).text, 'old text');
    assert.equal(tab.api.readDraft(replacement.id).text, 'new text');
});

test('history cleanup preserves active drafts while enforcing the record limit', async () => {
    const storage = new Map();
    const tab = openTab(storage);
    const active = tab.api.createActiveDraft('keep me');
    for (let i = 0; i < 501; i++) {
        const draft = tab.api.newDraft(`closed ${i}`);
        draft.status = 'sent';
        tab.api.writeDraft(draft, false);
    }

    await tab.api.cleanupHistory();
    assert.ok(tab.api.readDraft(active.id));
    assert.equal([...storage.keys()].filter(key => key.startsWith('ddh:v1:draft:')).length, 500);
});

test('an unconfirmed submission keeps ownership protection and the saved text', () => {
    const storage = new Map();
    const tab = openTab(storage);
    const draft = tab.api.createActiveDraft('submitted text');
    tab.api.setPending(draft.id, 'submitted text');
    tab.api.failPendingSubmission('timeout');

    const saved = tab.api.getCurrentDraft();
    assert.ok(saved);
    assert.equal(saved.text, 'submitted text');
    assert.notEqual(saved.claimToken, draft.claimToken);
});
