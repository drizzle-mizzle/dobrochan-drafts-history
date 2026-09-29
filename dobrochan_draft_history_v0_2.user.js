// ==UserScript==
// @name         Dobrochan Draft History
// @namespace    https://rf.dobrochan.net/
// @version      0.2.0
// @description  Автосохранение, восстановление и история текста формы постинга Dobrochan/Vichan с поддержкой Dollchan.
// @author       Dobrochan userscript
// @match        *://rf.dobrochan.net/vichan/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const SCRIPT = 'Dobrochan Draft History';
    const VERSION = 1;

    const NS = 'ddh:v1:';
    const DRAFT_PREFIX = `${NS}draft:`;
    const PULSE_KEY = `${NS}pulse`;
    const SESSION_TAB_KEY = `${NS}tab-id`;
    const SESSION_DRAFT_KEY = `${NS}current-draft-id`;
    const BC_NAME = 'dobrochan-draft-history-v1';
    const LOCK_NAME = 'dobrochan-draft-history-claim-v1';

    const SAVE_DEBOUNCE_MS = 2000;
    const REVISION_INTERVAL_MS = 15000;
    const MAX_REVISIONS = 20;
    const SUBMISSION_TIMEOUT_MS = 20000;
    const SUBMISSION_POLL_MS = 100;
    const HEARTBEAT_MS = 15000;
    const ABANDON_AFTER_MS = 30000;
    const ABANDON_SWEEP_DELAY_MS = 32000;
    const HISTORY_MAX_ITEMS = 500;
    const HISTORY_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

    const STATUS = Object.freeze({
        ACTIVE: 'active',
        SENT: 'sent',
        ABANDONED: 'abandoned'
    });

    let form = null;
    let textarea = null;
    let scope = null;
    let currentDraftId = null;
    let tabId = null;
    let saveTimer = null;
    let heartbeatTimer = null;
    let submissionObserver = null;
    let pendingSubmission = null;
    let suppressInput = false;
    let historyUi = null;
    let historyUiOpen = false;
    let historyRenderTimer = null;
    let pulseListenerId = null;

    let bc = null;
    const probeCollectors = new Map();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const now = () => Date.now();

    function log(...args) {
        console.debug(`[${SCRIPT}]`, ...args);
    }

    function warn(...args) {
        console.warn(`[${SCRIPT}]`, ...args);
    }

    function uuid() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
        const bytes = new Uint8Array(16);
        if (globalThis.crypto?.getRandomValues) {
            globalThis.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const h = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
            return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }

    function safeSessionGet(key) {
        try {
            return sessionStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function safeSessionSet(key, value) {
        try {
            if (value == null) {
                sessionStorage.removeItem(key);
            } else {
                sessionStorage.setItem(key, String(value));
            }
        } catch {
            // sessionStorage is only an optimization; persistent data lives in GM storage.
        }
    }

    function getOrCreateTabId() {
        let id = safeSessionGet(SESSION_TAB_KEY);
        if (!id) {
            id = uuid();
            safeSessionSet(SESSION_TAB_KEY, id);
        }
        return id;
    }

    function draftKey(id) {
        return `${DRAFT_PREFIX}${id}`;
    }

    function isDraft(value) {
        return Boolean(value && typeof value === 'object' && value.id && value.version === VERSION);
    }

    function readDraft(id) {
        if (!id) return null;
        const value = GM_getValue(draftKey(id), null);
        return isDraft(value) ? value : null;
    }

    function loadAllDrafts() {
        const values = [];
        for (const key of GM_listValues()) {
            if (!key.startsWith(DRAFT_PREFIX)) continue;
            const value = GM_getValue(key, null);
            if (isDraft(value)) values.push(value);
        }
        return values;
    }

    function notifyHistoryChanged(id) {
        GM_setValue(PULSE_KEY, {
            id: id || null,
            at: now(),
            tabId
        });
        scheduleHistoryRender();
    }

    function writeDraft(draft, pulse = true) {
        GM_setValue(draftKey(draft.id), draft);
        if (pulse) notifyHistoryChanged(draft.id);
        return draft;
    }

    function deleteDraft(id) {
        GM_deleteValue(draftKey(id));
        notifyHistoryChanged(id);
    }

    function getThreadUrl(board, threadId) {
        if (/^\d+$/.test(String(threadId))) {
            return `${location.origin}/vichan/${encodeURIComponent(board)}/res/${threadId}.html`;
        }
        return `${location.origin}/vichan/${encodeURIComponent(board)}/`;
    }

    function getThreadIdFromLocation() {
        const m = location.pathname.match(/\/res\/(\d+)(?:\+\d+)?\.html/i);
        return m?.[1] || null;
    }

    function detectScope(postForm) {
        const board = postForm.querySelector('input[name="board"]')?.value?.trim();
        const formThread = postForm.querySelector('input[name="thread"]')?.value?.trim();
        const threadId = formThread || getThreadIdFromLocation() || 'new';

        if (!board) return null;

        return {
            board,
            threadId,
            key: `${board}/${threadId}`,
            url: getThreadUrl(board, threadId),
            title: document.querySelector('#de-win-reply .de-win-title')?.textContent?.trim() || document.title || `/${board}/ #${threadId}`
        };
    }

    function sameScope(draft, sc = scope) {
        return Boolean(draft && sc && draft.board === sc.board && String(draft.threadId) === String(sc.threadId));
    }

    async function waitForPostingForm(timeoutMs = 30000) {
        const find = () => {
            const f = document.querySelector('#de-pform form[name="post"]')
                || document.querySelector('form[name="post"][action*="post.php"]');
            const ta = f?.querySelector('textarea[name="body"]');
            return f && ta ? { form: f, textarea: ta } : null;
        };

        const immediate = find();
        if (immediate) return immediate;

        return new Promise(resolve => {
            let done = false;
            const finish = value => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearTimeout(timer);
                resolve(value);
            };

            const observer = new MutationObserver(() => {
                const result = find();
                if (result) finish(result);
            });

            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timer = setTimeout(() => finish(null), timeoutMs);
        });
    }

    function normalizeTextForComparison(value) {
        return String(value || '')
            .replace(/\r\n?/g, '\n')
            .replace(/[ \t]+$/gm, '')
            .trim();
    }

    function maybeAddRevision(draft, newText, force = false) {
        const oldText = String(draft.text || '');
        if (!oldText || oldText === newText) return;

        const t = now();
        const lastRevisionAt = draft.lastRevisionAt || 0;
        const bigDeletion = oldText.length >= 20
            && (newText.length === 0 || newText.length < oldText.length * 0.55);

        if (!force && !bigDeletion && t - lastRevisionAt < REVISION_INTERVAL_MS) return;

        draft.revisions = Array.isArray(draft.revisions) ? draft.revisions : [];
        const last = draft.revisions[draft.revisions.length - 1];
        if (!last || last.text !== oldText) {
            draft.revisions.push({
                at: draft.updatedAt || t,
                text: oldText
            });
            if (draft.revisions.length > MAX_REVISIONS) {
                draft.revisions.splice(0, draft.revisions.length - MAX_REVISIONS);
            }
        }
        draft.lastRevisionAt = t;
    }

    function updateDraftText(draft, newText, { forceRevision = false, pulse = true } = {}) {
        newText = String(newText ?? '');
        const changed = String(draft.text ?? '') !== newText;
        if (changed) {
            maybeAddRevision(draft, newText, forceRevision);
            draft.text = newText;
            draft.updatedAt = now();
        }
        draft.heartbeatAt = now();
        draft.ownerTabId = tabId;
        if (changed || forceRevision) {
            writeDraft(draft, pulse);
        } else {
            writeDraft(draft, false);
        }
        return draft;
    }

    function newDraft(text) {
        const t = now();
        return {
            version: VERSION,
            id: uuid(),
            board: scope.board,
            threadId: scope.threadId,
            threadUrl: scope.url,
            threadTitle: scope.title,
            ownerTabId: tabId,
            status: STATUS.ACTIVE,
            text: String(text ?? ''),
            revisions: [],
            createdAt: t,
            updatedAt: t,
            heartbeatAt: t,
            sentAt: null,
            abandonedAt: null,
            restoredAt: null,
            restoredCount: 0,
            lastRevisionAt: t
        };
    }

    function setCurrentDraft(draft) {
        currentDraftId = draft?.id || null;
        safeSessionSet(SESSION_DRAFT_KEY, currentDraftId);
        if (bc) {
            try {
                bc.postMessage({
                    type: 'state',
                    tabId,
                    bufferId: currentDraftId,
                    scopeKey: scope?.key || null
                });
            } catch {
                // BroadcastChannel is best-effort only.
            }
        }
    }

    function createActiveDraft(text, { pulse = true } = {}) {
        const draft = newDraft(text);
        writeDraft(draft, pulse);
        setCurrentDraft(draft);
        return draft;
    }

    function getCurrentDraft() {
        const draft = readDraft(currentDraftId);
        if (!draft || draft.status !== STATUS.ACTIVE || !sameScope(draft)) return null;
        return draft;
    }

    function ensureCurrentDraft(text) {
        let draft = getCurrentDraft();
        if (!draft) {
            draft = createActiveDraft(text);
        }
        return draft;
    }

    function flushTextNow({ forceRevision = false, reason = 'flush' } = {}) {
        if (!textarea || suppressInput) return null;

        if (pendingSubmission) {
            if (reason === 'pagehide') preservePendingTextareaOnUnload();
            return readDraft(pendingSubmission.draftId);
        }

        const text = textarea.value;
        let draft = getCurrentDraft();

        if (!draft && text === '') return null;
        if (!draft) draft = createActiveDraft(text, { pulse: false });

        updateDraftText(draft, text, { forceRevision, pulse: true });
        return draft;
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            flushTextNow({ reason: 'debounce' });
        }, SAVE_DEBOUNCE_MS);
    }

    function onTextareaInput() {
        if (suppressInput) return;
        if (pendingSubmission) {
            pendingSubmission.userEditedAfterSubmit = true;
            return;
        }
        scheduleSave();
    }

    function initBroadcastChannel() {
        if (!('BroadcastChannel' in globalThis)) return;

        try {
            bc = new BroadcastChannel(BC_NAME);
            bc.addEventListener('message', event => {
                const msg = event.data;
                if (!msg || typeof msg !== 'object') return;

                if (msg.type === 'probe' && msg.probeId) {
                    const advertised = currentDraftId || safeSessionGet(SESSION_DRAFT_KEY) || null;
                    bc.postMessage({
                        type: 'alive',
                        probeId: msg.probeId,
                        tabId,
                        bufferId: advertised,
                        scopeKey: scope?.key || null
                    });
                    return;
                }

                if (msg.type === 'alive' && msg.probeId) {
                    const collector = probeCollectors.get(msg.probeId);
                    if (collector) {
                        collector.tabIds.add(msg.tabId);
                        if (msg.bufferId) collector.bufferIds.add(msg.bufferId);
                    }
                }
            });
        } catch (error) {
            warn('BroadcastChannel недоступен:', error);
            bc = null;
        }
    }

    async function collectLiveState(waitMs = 250) {
        const result = { tabIds: new Set(), bufferIds: new Set() };
        if (!bc) return result;

        const probeId = uuid();
        probeCollectors.set(probeId, result);
        try {
            bc.postMessage({ type: 'probe', probeId, fromTabId: tabId });
            await sleep(waitMs);
        } finally {
            probeCollectors.delete(probeId);
        }
        return result;
    }

    async function ensureUniqueTabId() {
        if (!bc) return;
        const live = await collectLiveState(180);
        if (live.tabIds.has(tabId)) {
            tabId = uuid();
            safeSessionSet(SESSION_TAB_KEY, tabId);
            log('Обнаружена копия sessionStorage; назначен новый tabId.');
        }
    }

    async function withClaimLock(callback) {
        if (navigator.locks?.request) {
            return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, callback);
        }

        // Fallback for browsers without Web Locks. The write/read verification below still
        // makes duplicate claims unlikely, but Web Locks is the preferred path.
        await sleep(50 + Math.floor(Math.random() * 200));
        return callback();
    }

    function claimDraft(draft) {
        const claimToken = uuid();
        draft.ownerTabId = tabId;
        draft.claimToken = claimToken;
        draft.claimedAt = now();
        draft.heartbeatAt = now();
        writeDraft(draft, false);

        const verify = readDraft(draft.id);
        return verify?.claimToken === claimToken ? verify : null;
    }

    async function claimRecoverableDraft() {
        return withClaimLock(async () => {
            const live = await collectLiveState(260);
            const drafts = loadAllDrafts()
                .filter(d => d.status === STATUS.ACTIVE && sameScope(d))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

            const sessionDraftId = safeSessionGet(SESSION_DRAFT_KEY);
            let candidate = null;

            if (sessionDraftId) {
                const sessionDraft = drafts.find(d => d.id === sessionDraftId);
                if (sessionDraft && (!live.bufferIds.has(sessionDraft.id) || sessionDraft.ownerTabId === tabId)) {
                    candidate = sessionDraft;
                }
            }

            if (!candidate) {
                if (bc) {
                    candidate = drafts.find(d => !live.bufferIds.has(d.id)) || null;
                } else {
                    const t = now();
                    candidate = drafts.find(d =>
                        t - (d.heartbeatAt || d.updatedAt || d.createdAt || 0) >= ABANDON_AFTER_MS
                    ) || null;
                }
            }

            if (!candidate) return null;

            const currentText = textarea.value;
            if (currentText && normalizeTextForComparison(currentText) !== normalizeTextForComparison(candidate.text)) {
                return null;
            }

            return claimDraft(candidate);
        });
    }

    async function restoreOrStart() {
        const recovered = await claimRecoverableDraft();
        if (recovered) {
            setCurrentDraft(recovered);
            recovered.restoredAt = now();
            recovered.restoredCount = (recovered.restoredCount || 0) + 1;
            recovered.heartbeatAt = now();
            writeDraft(recovered, true);

            if (!textarea.value && recovered.text) {
                suppressInput = true;
                textarea.value = recovered.text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                suppressInput = false;
            }
            log(`Восстановлен буфер ${recovered.id}.`);
            return recovered;
        }

        safeSessionSet(SESSION_DRAFT_KEY, null);
        currentDraftId = null;

        if (textarea.value) {
            const created = createActiveDraft(textarea.value);
            log(`Создан буфер для уже заполненной формы ${created.id}.`);
            return created;
        }

        return null;
    }

    async function sweepAbandonedDrafts() {
        try {
            await withClaimLock(async () => {
                const live = await collectLiveState(350);
                const t = now();
                let changed = false;

                for (const draft of loadAllDrafts()) {
                    if (draft.status !== STATUS.ACTIVE) continue;
                    if (draft.id === currentDraftId) continue;
                    if (live.bufferIds.has(draft.id)) continue;
                    if (t - (draft.heartbeatAt || draft.updatedAt || draft.createdAt || 0) < ABANDON_AFTER_MS) continue;

                    draft.status = STATUS.ABANDONED;
                    draft.abandonedAt = t;
                    draft.ownerTabId = null;
                    draft.claimToken = null;
                    writeDraft(draft, false);
                    changed = true;
                }

                if (changed) notifyHistoryChanged(null);
            });
        } catch (error) {
            warn('Не удалось выполнить анализ брошенных буферов:', error);
        }
    }

    function heartbeat() {
        const draft = getCurrentDraft();
        if (!draft || pendingSubmission) return;
        draft.heartbeatAt = now();
        draft.ownerTabId = tabId;
        writeDraft(draft, false);
    }

    function startHeartbeat() {
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    }

    function getThreadContainer() {
        if (/^\d+$/.test(String(scope.threadId))) {
            return document.querySelector(`#thread_${scope.threadId}`) || document.querySelector('.thread');
        }
        return document.querySelector('.thread') || document.body;
    }

    function nodeContainsNewMyPost(node, knownIds) {
        if (!(node instanceof Element)) return false;
        const candidates = [];
        if (node.matches('.de-mypost, .de-mypost-reply')) candidates.push(node);
        candidates.push(...node.querySelectorAll('.de-mypost, .de-mypost-reply'));
        return candidates.some(el => el.id && !knownIds.has(el.id));
    }

    function installSubmissionObserver() {
        const container = getThreadContainer();
        if (!container) return;

        submissionObserver?.disconnect();
        submissionObserver = new MutationObserver(mutations => {
            if (!pendingSubmission) return;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (nodeContainsNewMyPost(node, pendingSubmission.myPostIdsBefore)) {
                        pendingSubmission.myPostObserved = true;
                        tryFinalizeSubmission();
                        return;
                    }
                }
            }
        });

        submissionObserver.observe(container, { childList: true, subtree: true });
    }

    function clearPendingSubmissionTimer(pending = pendingSubmission) {
        if (pending?.pollTimer) clearInterval(pending.pollTimer);
        if (pending?.timeoutTimer) clearTimeout(pending.timeoutTimer);
    }

    function beginSubmission() {
        if (!textarea) return;
        const submittedText = textarea.value;
        if (!submittedText && !currentDraftId) return;

        clearTimeout(saveTimer);
        saveTimer = null;

        if (pendingSubmission) {
            failPendingSubmission('new-submit');
        }

        let draft = getCurrentDraft();
        if (!draft && submittedText) draft = createActiveDraft(submittedText, { pulse: false });
        if (!draft) return;

        updateDraftText(draft, submittedText, { forceRevision: false, pulse: true });
        draft.pendingSubmissionAt = now();
        writeDraft(draft, false);

        const myPostIdsBefore = new Set(
            [...document.querySelectorAll('.de-mypost, .de-mypost-reply')]
                .map(el => el.id)
                .filter(Boolean)
        );

        pendingSubmission = {
            draftId: draft.id,
            submittedText,
            startedAt: now(),
            myPostIdsBefore,
            myPostObserved: false,
            textareaCleared: false,
            userEditedAfterSubmit: false,
            pollTimer: null,
            timeoutTimer: null
        };

        pendingSubmission.pollTimer = setInterval(() => {
            if (!pendingSubmission) return;
            if (textarea.value === '') pendingSubmission.textareaCleared = true;
            tryFinalizeSubmission();
        }, SUBMISSION_POLL_MS);

        pendingSubmission.timeoutTimer = setTimeout(() => {
            failPendingSubmission('timeout');
        }, SUBMISSION_TIMEOUT_MS);
    }

    function tryFinalizeSubmission() {
        const pending = pendingSubmission;
        if (!pending) return;

        if (textarea.value === '') pending.textareaCleared = true;
        if (!pending.textareaCleared || !pending.myPostObserved) return;

        finalizeSuccessfulSubmission();
    }

    function finalizeSuccessfulSubmission() {
        const pending = pendingSubmission;
        if (!pending) return;

        clearPendingSubmissionTimer(pending);
        pendingSubmission = null;

        const draft = readDraft(pending.draftId);
        if (draft) {
            draft.status = STATUS.SENT;
            draft.text = pending.submittedText;
            draft.sentAt = now();
            draft.updatedAt = draft.sentAt;
            draft.ownerTabId = null;
            draft.heartbeatAt = null;
            draft.claimToken = null;
            delete draft.pendingSubmissionAt;
            writeDraft(draft, true);
        }

        if (currentDraftId === pending.draftId) {
            setCurrentDraft(null);
        }

        // If the user managed to type the next message before success detection completed,
        // keep that text in a fresh buffer rather than attaching it to the sent one.
        if (textarea.value && textarea.value !== pending.submittedText) {
            createActiveDraft(textarea.value);
        }

        log(`Буфер ${pending.draftId} отмечен как отправленный.`);
    }

    function failPendingSubmission(reason) {
        const pending = pendingSubmission;
        if (!pending) return;

        clearPendingSubmissionTimer(pending);
        pendingSubmission = null;

        const draft = readDraft(pending.draftId);
        if (!draft) return;

        draft.status = STATUS.ACTIVE;
        draft.ownerTabId = tabId;
        draft.heartbeatAt = now();
        draft.claimToken = null;
        delete draft.pendingSubmissionAt;

        // A failed submit should never erase the last known good text merely because
        // the page cleared the textarea unexpectedly. If text is still present, keep it.
        if (textarea.value) {
            maybeAddRevision(draft, textarea.value, false);
            draft.text = textarea.value;
            draft.updatedAt = now();
        }

        writeDraft(draft, true);
        setCurrentDraft(draft);
        log(`Отправка не подтверждена (${reason}); буфер оставлен активным.`);
    }

    function preservePendingTextareaOnUnload() {
        const pending = pendingSubmission;
        if (!pending) return;
        const currentText = textarea.value;
        if (!currentText || currentText === pending.submittedText) return;

        // Preserve a second piece of text rather than risk losing it. On the next start
        // normal claim/abandon logic will decide which orphan can be resumed.
        const extra = newDraft(currentText);
        extra.recoveryNote = 'Text entered while a previous post submission was still pending.';
        writeDraft(extra, true);
    }

    function cleanupHistory() {
        const drafts = loadAllDrafts();
        const t = now();
        const removable = drafts.filter(d => d.status !== STATUS.ACTIVE);
        let changed = false;

        for (const draft of removable) {
            const stamp = draft.sentAt || draft.abandonedAt || draft.updatedAt || draft.createdAt || 0;
            if (t - stamp > HISTORY_MAX_AGE_MS) {
                GM_deleteValue(draftKey(draft.id));
                changed = true;
            }
        }

        const remaining = loadAllDrafts();
        if (remaining.length > HISTORY_MAX_ITEMS) {
            const nonActiveOldest = remaining
                .filter(d => d.status !== STATUS.ACTIVE)
                .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
            let toDelete = remaining.length - HISTORY_MAX_ITEMS;
            for (const draft of nonActiveOldest) {
                if (toDelete <= 0) break;
                GM_deleteValue(draftKey(draft.id));
                changed = true;
                toDelete--;
            }
        }

        if (changed) notifyHistoryChanged(null);
    }

    function formatTime(ts) {
        if (!ts) return '—';
        return new Intl.DateTimeFormat('ru-RU', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(new Date(ts));
    }

    function formatDate(ts) {
        if (!ts) return '—';
        return new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric'
        }).format(new Date(ts));
    }

    function statusLabel(status) {
        switch (status) {
            case STATUS.SENT: return 'Отправлен';
            case STATUS.ABANDONED: return 'Брошен';
            case STATUS.ACTIVE:
            default: return 'Активный';
        }
    }

    function readHistoryPosition() {
        try {
            const raw = sessionStorage.getItem(`${NS}history-position`);
            if (!raw) return null;
            const value = JSON.parse(raw);
            return Number.isFinite(value?.left) && Number.isFinite(value?.top) ? value : null;
        } catch {
            return null;
        }
    }

    function saveHistoryPosition(win) {
        try {
            const rect = win.getBoundingClientRect();
            sessionStorage.setItem(`${NS}history-position`, JSON.stringify({
                left: Math.round(rect.left),
                top: Math.round(rect.top)
            }));
        } catch {
            // Position persistence is only a convenience.
        }
    }

    function clampHistoryWindow(win) {
        if (!win || !historyUiOpen) return;
        const rect = win.getBoundingClientRect();
        const margin = 6;
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin);
        const left = Math.min(Math.max(rect.left, margin), maxLeft);
        const top = Math.min(Math.max(rect.top, margin), maxTop);
        win.style.left = `${Math.round(left)}px`;
        win.style.top = `${Math.round(top)}px`;
        win.style.right = 'auto';
        win.style.bottom = 'auto';
    }

    function positionHistoryWindowNearForm(win, { force = false } = {}) {
        if (!win) return;

        const saved = !force ? readHistoryPosition() : null;
        if (saved) {
            win.style.left = `${saved.left}px`;
            win.style.top = `${saved.top}px`;
            win.style.right = 'auto';
            win.style.bottom = 'auto';
            requestAnimationFrame(() => clampHistoryWindow(win));
            return;
        }

        const replyWindow = document.querySelector('#de-win-reply');
        const anchor = replyWindow?.getBoundingClientRect?.() || form?.getBoundingClientRect?.();
        const rect = win.getBoundingClientRect();
        const gap = 8;
        const margin = 8;

        let left = window.innerWidth - rect.width - 16;
        let top = 36;

        if (anchor && anchor.width && anchor.height) {
            const roomRight = window.innerWidth - anchor.right;
            const roomLeft = anchor.left;
            if (roomRight >= rect.width + gap + margin) {
                left = anchor.right + gap;
            } else if (roomLeft >= rect.width + gap + margin) {
                left = anchor.left - rect.width - gap;
            } else {
                left = Math.min(Math.max(anchor.left, margin), window.innerWidth - rect.width - margin);
            }
            top = Math.min(Math.max(anchor.top, margin), window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin);
        }

        win.style.left = `${Math.round(left)}px`;
        win.style.top = `${Math.round(top)}px`;
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        requestAnimationFrame(() => clampHistoryWindow(win));
    }

    function makeHistoryDraggable(win, handle) {
        let drag = null;

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            if (event.target.closest('button, a, input, textarea, select, summary')) return;

            const rect = win.getBoundingClientRect();
            drag = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top
            };
            handle.setPointerCapture?.(event.pointerId);
            document.documentElement.classList.add('ddh-dragging');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const rect = win.getBoundingClientRect();
            const margin = 6;
            const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
            const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin);
            const left = Math.min(Math.max(event.clientX - drag.offsetX, margin), maxLeft);
            const top = Math.min(Math.max(event.clientY - drag.offsetY, margin), maxTop);
            win.style.left = `${Math.round(left)}px`;
            win.style.top = `${Math.round(top)}px`;
            win.style.right = 'auto';
            win.style.bottom = 'auto';
        });

        const endDrag = event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag = null;
            document.documentElement.classList.remove('ddh-dragging');
            try { handle.releasePointerCapture?.(event.pointerId); } catch { /* noop */ }
            saveHistoryPosition(win);
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
    }

    function createHistoryUi() {
        if (historyUi) return historyUi;

        let style = document.getElementById('ddh-history-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'ddh-history-style';
            style.textContent = `
                #ddh-history-window {
                    position: fixed !important;
                    z-index: 10003 !important;
                    display: none !important;
                    flex-direction: column;
                    width: min(620px, calc(100vw - 16px));
                    height: min(68vh, 720px);
                    min-width: min(390px, calc(100vw - 16px));
                    min-height: 180px;
                    max-width: calc(100vw - 12px);
                    max-height: calc(100vh - 12px);
                    padding: 0 !important;
                    margin: 0 !important;
                    overflow: hidden !important;
                    resize: both;
                    box-sizing: border-box !important;
                    color: inherit;
                    border: 1px solid gray !important;
                    border-radius: 10px 10px 3px 3px;
                    box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
                    font: 13px/1.35 Arial, sans-serif;
                }
                #ddh-history-window.ddh-open { display: flex !important; }
                #ddh-history-window > .ddh-head {
                    flex: none;
                    display: flex !important;
                    align-items: center;
                    gap: 7px;
                    width: auto !important;
                    min-height: 18px;
                    height: auto !important;
                    padding: 2px 3px 2px 6px !important;
                    user-select: none;
                    touch-action: none;
                    cursor: move !important;
                }
                #ddh-history-window .ddh-title {
                    flex: 1 1 auto;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                #ddh-history-window .ddh-count {
                    flex: none;
                    opacity: .72;
                    font-size: 11px;
                    font-weight: normal;
                    white-space: nowrap;
                }
                #ddh-history-window .ddh-close {
                    width: 18px;
                    height: 18px;
                    min-width: 18px;
                    padding: 0 !important;
                    margin: 0 !important;
                    border: 0 !important;
                    background: transparent !important;
                    color: inherit !important;
                    font: bold 16px/16px Arial, sans-serif !important;
                    cursor: pointer;
                    opacity: .8;
                }
                #ddh-history-window .ddh-close:hover { opacity: 1; background: rgba(127,127,127,.18) !important; }
                #ddh-history-window > .ddh-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    display: flex !important;
                    flex-direction: column;
                    width: auto !important;
                    padding: 2px !important;
                    margin: 0 !important;
                    overflow: hidden !important;
                    border: 0 !important;
                    background: transparent !important;
                }
                #ddh-history-window .ddh-list {
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow: auto;
                    overscroll-behavior: contain;
                    padding: 4px;
                }
                #ddh-history-window .empty {
                    padding: 28px 14px;
                    text-align: center;
                    opacity: .7;
                }
                #ddh-history-window .card {
                    display: block !important;
                    float: none !important;
                    width: auto !important;
                    padding: 0 !important;
                    margin: 0 0 6px !important;
                    overflow: hidden;
                    color: inherit;
                    background: rgba(255,255,255,.18);
                    border: 1px solid rgba(127,127,127,.48) !important;
                    border-radius: 3px;
                    box-shadow: none !important;
                }
                #ddh-history-window .card.other-thread { background: rgba(127,127,127,.13); }
                #ddh-history-window .card.current-tab { outline: 1px solid currentColor; outline-offset: -2px; }
                #ddh-history-window .meta {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    min-height: 30px;
                    padding: 4px 6px;
                    border-bottom: 1px solid rgba(127,127,127,.34);
                    flex-wrap: wrap;
                }
                #ddh-history-window .badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                    padding: 2px 6px;
                    border: 1px solid rgba(127,127,127,.35);
                    border-radius: 3px;
                    font-weight: bold;
                    white-space: nowrap;
                    background: rgba(127,127,127,.08);
                }
                #ddh-history-window .badge::before {
                    content: "";
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: currentColor;
                }
                #ddh-history-window .badge.active { color: #b05a00; }
                #ddh-history-window .badge.sent { color: #2f7d32; }
                #ddh-history-window .badge.abandoned { opacity: .7; }
                #ddh-history-window .stamp { opacity: .82; white-space: nowrap; }
                #ddh-history-window .thread-link {
                    margin-left: auto;
                    color: inherit !important;
                    text-decoration: underline;
                    white-space: nowrap;
                    opacity: .9;
                }
                #ddh-history-window .tab-note { opacity: .65; font-size: 11px; }
                #ddh-history-window .actions { display: flex; gap: 3px; margin-left: 2px; }
                #ddh-history-window button.action {
                    min-width: 0 !important;
                    height: 21px !important;
                    padding: 0 5px !important;
                    margin: 0 !important;
                    color: inherit !important;
                    font: 11px/19px Arial, sans-serif !important;
                    cursor: pointer;
                }
                #ddh-history-window button.action.danger:hover { text-decoration: line-through; }
                #ddh-history-window .text {
                    display: block;
                    margin: 0;
                    padding: 7px 8px;
                    max-height: 180px;
                    overflow: auto;
                    white-space: pre-wrap;
                    overflow-wrap: anywhere;
                    color: inherit;
                    background: transparent;
                    font: 13px/1.4 Arial, sans-serif;
                }
                #ddh-history-window .no-text { opacity: .6; font-style: italic; }
                #ddh-history-window details.revisions {
                    border-top: 1px solid rgba(127,127,127,.30);
                    background: rgba(127,127,127,.06);
                }
                #ddh-history-window details.revisions > summary {
                    cursor: pointer;
                    padding: 5px 7px;
                    font-size: 11px;
                    opacity: .8;
                }
                #ddh-history-window .revision-row {
                    display: grid;
                    grid-template-columns: 135px minmax(0, 1fr) auto;
                    gap: 5px;
                    align-items: center;
                    padding: 5px 6px;
                    border-top: 1px solid rgba(127,127,127,.22);
                    font-size: 11px;
                }
                #ddh-history-window .revision-preview {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    opacity: .78;
                }
                #ddh-history-window .revision-actions { display: flex; gap: 3px; }
                #ddh-history-window .toast {
                    position: absolute;
                    left: 50%;
                    bottom: 8px;
                    transform: translateX(-50%);
                    z-index: 2;
                    max-width: calc(100% - 16px);
                    padding: 5px 8px;
                    border: 1px solid rgba(127,127,127,.65);
                    border-radius: 3px;
                    background: inherit;
                    color: inherit;
                    box-shadow: 0 2px 10px rgba(0,0,0,.25);
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity .15s ease;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                #ddh-history-window .toast.show { opacity: 1; }
                html.ddh-dragging, html.ddh-dragging * { cursor: move !important; user-select: none !important; }
                @media (max-width: 720px) {
                    #ddh-history-window {
                        width: calc(100vw - 12px);
                        min-width: 0;
                        height: min(70vh, 620px);
                        resize: vertical;
                    }
                    #ddh-history-window .thread-link { margin-left: 0; }
                    #ddh-history-window .actions { width: 100%; margin-left: 0; }
                    #ddh-history-window .revision-row { grid-template-columns: 1fr; }
                }
            `;
            document.head.appendChild(style);
        }

        const win = document.createElement('div');
        win.id = 'ddh-history-window';
        win.className = 'post reply de-win';
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-label', 'История ввода');
        win.innerHTML = `
            <div class="de-win-head ddh-head">
                <span class="de-win-title ddh-title">История ввода</span>
                <span class="ddh-count"></span>
                <span class="de-win-buttons">
                    <button class="ddh-close" type="button" title="Закрыть" aria-label="Закрыть">×</button>
                </span>
            </div>
            <div class="de-win-body ddh-body">
                <div class="ddh-list"></div>
            </div>
            <div class="toast"></div>
        `;
        document.body.appendChild(win);

        const head = win.querySelector('.ddh-head');
        const close = win.querySelector('.ddh-close');
        close.addEventListener('click', closeHistory);
        win.addEventListener('click', onHistoryAction);
        makeHistoryDraggable(win, head);

        // Keep the floating window usable after viewport changes without snapping it back to the form.
        window.addEventListener('resize', () => {
            if (!historyUiOpen) return;
            requestAnimationFrame(() => clampHistoryWindow(win));
        });

        historyUi = {
            host: win,
            window: win,
            list: win.querySelector('.ddh-list'),
            count: win.querySelector('.ddh-count'),
            toast: win.querySelector('.toast')
        };
        return historyUi;
    }

    function showHistoryToast(message) {
        const ui = createHistoryUi();
        ui.toast.textContent = message;
        ui.toast.classList.add('show');
        clearTimeout(ui.toast._hideTimer);
        ui.toast._hideTimer = setTimeout(() => ui.toast.classList.remove('show'), 1300);
    }

    function openHistory() {
        const ui = createHistoryUi();
        historyUiOpen = true;
        ui.window.classList.add('ddh-open');
        positionHistoryWindowNearForm(ui.window);
        renderHistory();
    }

    function closeHistory() {
        if (!historyUi) return;
        historyUiOpen = false;
        historyUi.window.classList.remove('ddh-open');
    }

    function scheduleHistoryRender() {
        if (!historyUiOpen) return;
        clearTimeout(historyRenderTimer);
        historyRenderTimer = setTimeout(renderHistory, 80);
    }

    function makeButton(label, action, id, extraClass = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `action ${extraClass}`.trim();
        button.textContent = label;
        button.dataset.action = action;
        if (id) button.dataset.id = id;
        return button;
    }

    function renderRevisionRows(details, draft) {
        const revisions = Array.isArray(draft.revisions) ? [...draft.revisions] : [];
        revisions.reverse();

        revisions.forEach((revision, reverseIndex) => {
            const originalIndex = draft.revisions.length - 1 - reverseIndex;
            const row = document.createElement('div');
            row.className = 'revision-row';

            const stamp = document.createElement('span');
            stamp.textContent = `${formatTime(revision.at)}  ${formatDate(revision.at)}`;

            const preview = document.createElement('span');
            preview.className = 'revision-preview';
            preview.textContent = revision.text || '(пусто)';

            const actions = document.createElement('span');
            actions.className = 'revision-actions';

            const copy = makeButton('Копировать', 'copy-revision', draft.id);
            copy.dataset.revisionIndex = String(originalIndex);
            const restore = makeButton('В форму', 'restore-revision', draft.id);
            restore.dataset.revisionIndex = String(originalIndex);
            actions.append(copy, restore);

            row.append(stamp, preview, actions);
            details.appendChild(row);
        });
    }

    function renderHistory() {
        if (!historyUiOpen) return;
        const ui = createHistoryUi();
        const drafts = loadAllDrafts().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        ui.count.textContent = `${drafts.length} ${drafts.length === 1 ? 'буфер' : 'буферов'}`;
        ui.list.replaceChildren();

        if (!drafts.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Сохранённых буферов пока нет.';
            ui.list.appendChild(empty);
            return;
        }

        for (const draft of drafts) {
            const card = document.createElement('article');
            card.className = 'card';
            if (!sameScope(draft)) card.classList.add('other-thread');
            if (draft.id === currentDraftId) card.classList.add('current-tab');

            const meta = document.createElement('div');
            meta.className = 'meta';

            const badge = document.createElement('span');
            badge.className = `badge ${draft.status}`;
            badge.textContent = statusLabel(draft.status);

            const stamp = document.createElement('span');
            stamp.className = 'stamp';
            stamp.textContent = `${formatTime(draft.updatedAt)}  ${formatDate(draft.updatedAt)}`;

            meta.append(badge, stamp);

            if (draft.restoredCount) {
                const note = document.createElement('span');
                note.className = 'tab-note';
                note.textContent = `восстановлен ×${draft.restoredCount}`;
                meta.appendChild(note);
            }
            if (draft.id === currentDraftId) {
                const note = document.createElement('span');
                note.className = 'tab-note';
                note.textContent = 'эта вкладка';
                meta.appendChild(note);
            }

            const link = document.createElement('a');
            link.className = 'thread-link';
            link.href = draft.threadUrl || getThreadUrl(draft.board, draft.threadId);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = /^\d+$/.test(String(draft.threadId))
                ? `/${draft.board}/ #${draft.threadId}`
                : `/${draft.board}/ новый тред`;
            meta.appendChild(link);

            const actions = document.createElement('span');
            actions.className = 'actions';
            actions.append(
                makeButton('Копировать', 'copy', draft.id),
                makeButton('В форму', 'restore', draft.id),
                makeButton('Удалить', 'delete', draft.id, 'danger')
            );
            meta.appendChild(actions);

            const pre = document.createElement('pre');
            pre.className = 'text';
            if (draft.text) {
                pre.textContent = draft.text;
            } else {
                const emptyText = document.createElement('span');
                emptyText.className = 'no-text';
                emptyText.textContent = '(пустой текст)';
                pre.appendChild(emptyText);
            }

            card.append(meta, pre);

            if (Array.isArray(draft.revisions) && draft.revisions.length) {
                const details = document.createElement('details');
                details.className = 'revisions';
                const summary = document.createElement('summary');
                summary.textContent = `Предыдущие версии: ${draft.revisions.length}`;
                details.appendChild(summary);
                renderRevisionRows(details, draft);
                card.appendChild(details);
            }

            ui.list.appendChild(card);
        }
    }

    function copyText(text) {
        try {
            GM_setClipboard(String(text ?? ''), 'text');
            showHistoryToast('Скопировано');
        } catch (error) {
            warn('Не удалось скопировать текст:', error);
        }
    }

    function applyTextToForm(text) {
        text = String(text ?? '');
        if (!textarea) return;
        if (pendingSubmission) {
            alert('Сейчас выполняется отправка поста. Дождитесь её завершения перед восстановлением текста.');
            return;
        }

        const existing = textarea.value;
        if (existing && existing !== text) {
            const ok = confirm('В форме уже есть другой текст. Заменить его выбранной версией? Текущий текст останется в истории версий активного буфера.');
            if (!ok) return;
            flushTextNow({ forceRevision: true, reason: 'manual-restore-before' });
        }

        suppressInput = true;
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        suppressInput = false;

        let draft = getCurrentDraft();
        if (!draft) {
            draft = createActiveDraft(text);
        } else {
            updateDraftText(draft, text, { forceRevision: true, pulse: true });
        }
        textarea.focus();
        showHistoryToast('Текст восстановлен в форму');
    }

    function onHistoryAction(event) {
        const button = event.target.closest?.('button[data-action]');
        if (!button) return;

        const action = button.dataset.action;
        const id = button.dataset.id;
        const draft = readDraft(id);
        if (!draft) {
            showHistoryToast('Буфер уже отсутствует');
            renderHistory();
            return;
        }

        let text = draft.text || '';
        if (action.endsWith('-revision')) {
            const index = Number(button.dataset.revisionIndex);
            const revision = draft.revisions?.[index];
            if (!revision) return;
            text = revision.text || '';
        }

        switch (action) {
            case 'copy':
            case 'copy-revision':
                copyText(text);
                break;
            case 'restore':
            case 'restore-revision':
                applyTextToForm(text);
                break;
            case 'delete': {
                const ok = confirm(`Удалить буфер «${statusLabel(draft.status)}» от ${formatDate(draft.updatedAt)} ${formatTime(draft.updatedAt)}?`);
                if (!ok) return;
                if (draft.id === currentDraftId) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                    setCurrentDraft(null);
                }
                deleteDraft(draft.id);
                renderHistory();
                break;
            }
        }
    }

    function installHistoryButton() {
        if (document.getElementById('ddh-history-button')) return;
        const submit = form.querySelector('input[type="submit"][name="post"], button[type="submit"]');
        const td = submit?.closest('td') || submit?.parentElement;
        if (!td) return;

        const button = document.createElement('button');
        button.id = 'ddh-history-button';
        button.type = 'button';
        button.textContent = 'История ввода';
        button.title = 'Открыть сохранённые буферы текста';
        button.addEventListener('click', openHistory);
        td.appendChild(button);

        const style = document.createElement('style');
        style.id = 'ddh-page-style';
        style.textContent = `
            #ddh-history-button {
                float: right;
                margin: 0 2px 0 12px !important;
                padding: 1px 6px !important;
                min-height: 21px;
                color: inherit !important;
                font: 12px/16px Arial, sans-serif;
                cursor: pointer;
            }
        `;
        document.head.appendChild(style);
    }

    function installEventHandlers() {
        textarea.addEventListener('input', onTextareaInput, true);
        form.addEventListener('submit', beginSubmission, true);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                clearTimeout(saveTimer);
                saveTimer = null;
                if (!pendingSubmission) flushTextNow({ reason: 'visibility-hidden' });
                heartbeat();
            }
        });

        window.addEventListener('pagehide', () => {
            clearTimeout(saveTimer);
            saveTimer = null;
            flushTextNow({ reason: 'pagehide' });
        }, { capture: true });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && historyUiOpen) closeHistory();
        }, true);
    }

    function installPulseListener() {
        try {
            pulseListenerId = GM_addValueChangeListener(PULSE_KEY, (_name, _oldValue, _newValue, remote) => {
                if (remote) scheduleHistoryRender();
            });
        } catch (error) {
            warn('Не удалось включить межвкладочное обновление UI:', error);
        }
    }

    async function init() {
        tabId = getOrCreateTabId();

        const found = await waitForPostingForm();
        if (!found) {
            log('Форма постинга не найдена на этой странице.');
            try {
                GM_registerMenuCommand('История ввода', openHistory);
            } catch {
                // Optional convenience only.
            }
            return;
        }

        form = found.form;
        textarea = found.textarea;
        scope = detectScope(form);
        if (!scope) {
            warn('Не удалось определить доску/тред формы постинга.');
            return;
        }

        initBroadcastChannel();
        await ensureUniqueTabId();

        installHistoryButton();
        createHistoryUi();
        installPulseListener();
        installSubmissionObserver();

        await restoreOrStart();
        installEventHandlers();
        startHeartbeat();

        try {
            GM_registerMenuCommand('История ввода', openHistory);
        } catch {
            // Optional convenience only.
        }

        cleanupHistory();
        setTimeout(sweepAbandonedDrafts, ABANDON_SWEEP_DELAY_MS);

        log(`Запущен для ${scope.key}; tabId=${tabId}; currentDraft=${currentDraftId || 'none'}.`);
    }

    init().catch(error => {
        console.error(`[${SCRIPT}] Ошибка инициализации`, error);
    });
})();
