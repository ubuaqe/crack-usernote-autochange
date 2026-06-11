// ==UserScript==
// @name         크랙 채팅모드별 유저노트 자동변경
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  crack.wrtn.ai 채팅방별로 채팅 모드 4개 유저노트를 저장하고, 채팅 모드 변경 시 자동 적용합니다.
// @match        https://crack.wrtn.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://crack-api.wrtn.ai/crack-gen';

    const BTN_POS_KEY_X = 'crack_mode_user_note_btn_x';
    const BTN_POS_KEY_Y = 'crack_mode_user_note_btn_y';
    const PANEL_OPEN_KEY = 'crack_mode_user_note_panel_open_v3';
    const MODE_NOTES_KEY_PREFIX = 'crack_mode_user_notes_v3';
    const LAST_APPLIED_NOTE_KEY = 'crack_last_applied_mode_user_note_v3';

    const CHAT_MODES = [
        { key: 'hyperchat_1_5', label: '하이퍼챗 1.5' },
        { key: 'hyperchat', label: '하이퍼챗' },
        { key: 'prochat_2_5', label: '프로챗 2.5' },
        { key: 'prochat_1_0', label: '프로챗 1.0' },
    ];

    let lastAutoAppliedModeKey = '';
    let lastAutoApplyAt = 0;

    let lastAppliedUserNoteContent = '';
    let lastAppliedUserNoteIsExtend = false;
    let lastAppliedUserNoteChatId = '';
    let lastAppliedUserNoteMode = '';

    let lastSeenUserNoteTextarea = null;
    let lastSyncedUserNoteKey = '';
    let userNoteUiSyncScheduled = false;
    let lastUserNoteInputAt = 0;

    let pendingUserNotePatchMode = null;

    let nativeUserNoteSaveInterceptorAttached = false;
    let nativeUserNoteSaveTimer = null;
    let internalUserNotePatchInProgress = false;

    function parseChatId() {
        const m = location.pathname.match(/\/stories\/[^/]+\/episodes\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    function isChatPage() {
        return !!parseChatId();
    }

    function getModeNotesKey() {
        const chatId = parseChatId();
        return `${MODE_NOTES_KEY_PREFIX}_${chatId || 'global'}`;
    }

    function getModeLabel(modeKey) {
        return CHAT_MODES.find(mode => mode.key === modeKey)?.label || modeKey;
    }

    function getModeNotes() {
        const saved = GM_getValue(getModeNotesKey(), null);

        const notes = {};
        CHAT_MODES.forEach(mode => {
            notes[mode.key] = {
                content: '',
                isExtend: false,
                updatedAt: null,
            };
        });

        if (saved && typeof saved === 'object') {
            CHAT_MODES.forEach(mode => {
                notes[mode.key] = {
                    content: typeof saved?.[mode.key]?.content === 'string'
                        ? saved[mode.key].content
                        : '',
                    isExtend: !!saved?.[mode.key]?.isExtend,
                    updatedAt: saved?.[mode.key]?.updatedAt || null,
                };
            });
        }

        GM_setValue(getModeNotesKey(), notes);
        return notes;
    }

    function setModeNotes(notes) {
        GM_setValue(getModeNotesKey(), notes);
    }

    function getPanelOpen() {
        return GM_getValue(PANEL_OPEN_KEY, false);
    }

    function setPanelOpen(value) {
        GM_setValue(PANEL_OPEN_KEY, !!value);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function formatTime(ts) {
        if (!ts) return '저장되지 않았습니다.';

        try {
            return new Date(ts).toLocaleString();
        } catch {
            return '시간 표시 중 오류가 발생했습니다.';
        }
    }

    function countChars(text) {
        return [...String(text || '')].length;
    }

    function previewText(text, maxLen = 120) {
        if (!text) return '(비어 있습니다)';

        const normalized = text.replace(/\s+/g, ' ').trim();

        return countChars(normalized) > maxLen
            ? [...normalized].slice(0, maxLen).join('') + '…'
            : normalized;
    }

    function getCookie(name) {
        const entry = document.cookie
            .split(';')
            .map(v => v.trim())
            .find(v => v.startsWith(name + '='));

        return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
    }

    function getToken() {
        return getCookie('access_token');
    }

    function buildHeaders() {
        const token = getToken();
        const wrtnId = getCookie('__w_id');

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'platform': 'web',
            'wrtn-locale': 'ko-KR',
        };

        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (wrtnId) headers['x-wrtn-id'] = wrtnId;

        return headers;
    }

    async function fetchCurrentUserNote(chatId) {
        const res = await fetch(`${API_BASE}/v3/chats/${chatId}`, {
            method: 'GET',
            headers: buildHeaders(),
            credentials: 'include',
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`현재 유저노트 조회에 실패했습니다. (${res.status}) ${text.slice(0, 160)}`);
        }

        const json = await res.json();
        const userNote = json?.data?.story?.userNote;

        return {
            content: userNote?.content ?? '',
            isExtend: !!userNote?.isExtend,
        };
    }

    async function patchUserNote(chatId, content, isExtend = false, modeKey = '') {
        if (modeKey) {
            pendingUserNotePatchMode = {
                chatId,
                modeKey,
                content: content || '',
                isExtend: !!isExtend,
                until: Date.now() + 4000,
            };
        }

        internalUserNotePatchInProgress = true;

        try {
            const res = await fetch(`${API_BASE}/v3/chats/${chatId}`, {
                method: 'PATCH',
                headers: buildHeaders(),
                credentials: 'include',
                body: JSON.stringify({
                    userNote: {
                        content,
                        isExtend,
                    },
                }),
            });

            if (!res.ok) {
                if (modeKey && pendingUserNotePatchMode?.chatId === chatId && pendingUserNotePatchMode?.modeKey === modeKey) {
                    pendingUserNotePatchMode = null;
                }

                const text = await res.text().catch(() => '');
                throw new Error(`유저노트 수정에 실패했습니다. (${res.status}) ${text.slice(0, 160)}`);
            }

            return res.json().catch(() => ({}));
        } finally {
            setTimeout(() => {
                internalUserNotePatchInProgress = false;
            }, 0);
        }
    }

    function rememberLastAppliedNote(chatId, modeKey, content, isExtend) {
        lastAppliedUserNoteContent = content || '';
        lastAppliedUserNoteIsExtend = !!isExtend;
        lastAppliedUserNoteChatId = chatId || '';
        lastAppliedUserNoteMode = modeKey || '';

        lastSyncedUserNoteKey = '';

        GM_setValue(LAST_APPLIED_NOTE_KEY, {
            chatId,
            mode: modeKey,
            content: content || '',
            isExtend: !!isExtend,
            updatedAt: Date.now(),
        });
    }

    function restoreLastAppliedNoteIfNeeded() {
        const chatId = parseChatId();
        if (!chatId) return;

        if (
            lastAppliedUserNoteChatId === chatId &&
            lastAppliedUserNoteMode
        ) {
            return;
        }

        const saved = GM_getValue(LAST_APPLIED_NOTE_KEY, null);

        if (saved && saved.chatId === chatId && saved.mode) {
            lastAppliedUserNoteContent = saved.content || '';
            lastAppliedUserNoteIsExtend = !!saved.isExtend;
            lastAppliedUserNoteChatId = saved.chatId;
            lastAppliedUserNoteMode = saved.mode || '';
        }
    }

    function getCurrentAppliedModeForChat() {
        const chatId = parseChatId();

        if (!chatId) return '';

        if (
            lastAppliedUserNoteChatId === chatId &&
            lastAppliedUserNoteMode
        ) {
            return lastAppliedUserNoteMode;
        }

        const saved = GM_getValue(LAST_APPLIED_NOTE_KEY, null);

        if (saved && saved.chatId === chatId && saved.mode) {
            return saved.mode;
        }

        return '';
    }

    function getPendingPatchMode(chatId, patchedUserNote) {
        if (!pendingUserNotePatchMode) return '';

        const expired = Date.now() > pendingUserNotePatchMode.until;
        if (expired) {
            pendingUserNotePatchMode = null;
            return '';
        }

        const content = typeof patchedUserNote?.content === 'string'
            ? patchedUserNote.content
            : '';

        const isExtend = !!patchedUserNote?.isExtend;

        const matched =
            pendingUserNotePatchMode.chatId === chatId &&
            pendingUserNotePatchMode.content === content &&
            pendingUserNotePatchMode.isExtend === isExtend;

        if (!matched) return '';

        const modeKey = pendingUserNotePatchMode.modeKey;
        pendingUserNotePatchMode = null;

        return modeKey;
    }

    function getUserNoteRootFromTextarea(textarea) {
        return (
            textarea.closest('[role="dialog"]') ||
            textarea.closest('.flex.flex-col.gap-3') ||
            textarea.closest('.flex.flex-col.gap-5') ||
            textarea.parentElement
        );
    }

    function findVisibleUserNoteTextarea() {
        const textareas = [...document.querySelectorAll('textarea')];

        return textareas.find(textarea => {
            const rect = textarea.getBoundingClientRect();
            const style = window.getComputedStyle(textarea);

            const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden';

            if (!isVisible) return false;

            const placeholder = textarea.getAttribute('placeholder') || '';
            const ariaLabel = textarea.getAttribute('aria-label') || '';
            const root = getUserNoteRootFromTextarea(textarea);
            const parentText = root?.textContent || textarea.closest('div')?.textContent || '';

            const isLikelyUserNote =
                placeholder.includes('잊으면 안되는 중요한 내용') ||
                placeholder.includes('추가하고 싶은 설정') ||
                placeholder.includes('유저') ||
                placeholder.includes('노트') ||
                ariaLabel.includes('유저') ||
                ariaLabel.includes('노트') ||
                parentText.includes('유저노트') ||
                parentText.includes('유저 노트') ||
                parentText.includes('반드시 기억해 줬으면') ||
                parentText.includes('2000자 확장');

            const isProbablyChatInput =
                placeholder.includes('메시지') ||
                placeholder.includes('입력') ||
                placeholder.includes('대화') ||
                ariaLabel.includes('메시지') ||
                parentText.includes('전송');

            return isLikelyUserNote && !isProbablyChatInput;
        }) || null;
    }

    function setDisplayTextareaValueOnly(textarea, value) {
        const valueSetter = Object.getOwnPropertyDescriptor(textarea, 'value')?.set;
        const prototype = Object.getPrototypeOf(textarea);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(textarea, value);
        } else if (valueSetter) {
            valueSetter.call(textarea, value);
        } else {
            textarea.value = value;
        }

        // input/change 이벤트 금지.
        // 여기서 input 이벤트를 쏘면 크랙이 자동 동기화를 사용자 수정으로 오해해서 닫을 때 팝업을 띄움.
    }

    function updateUserNoteCounterUI(textarea, content, isExtend) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return;

        const maxLength = isExtend ? 2000 : 500;
        const length = countChars(content);

        const spans = [...root.querySelectorAll('span')];

        const counterSpan = spans.find(span => {
            const text = span.textContent?.trim() || '';
            return /^\d+\s*\/\s*\d+$/.test(text);
        });

        if (!counterSpan) return;

        const nextText = `${length}/${maxLength}`;
        if (counterSpan.textContent !== nextText) {
            counterSpan.textContent = nextText;
        }
    }

    function updateUserNoteExtendSwitchUI(textarea, isExtend) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return;

        const switchBtn = root.querySelector('button[role="switch"]');
        if (!switchBtn) return;

        const nextChecked = isExtend ? 'true' : 'false';
        const nextState = isExtend ? 'checked' : 'unchecked';

        if (switchBtn.getAttribute('aria-checked') !== nextChecked) {
            switchBtn.setAttribute('aria-checked', nextChecked);
        }

        if (switchBtn.getAttribute('data-state') !== nextState) {
            switchBtn.setAttribute('data-state', nextState);
        }

        const thumb = switchBtn.querySelector('span');
        if (thumb && thumb.getAttribute('data-state') !== nextState) {
            thumb.setAttribute('data-state', nextState);
        }
    }

    function syncUserNoteTextareaHeightLikeCrack(textarea) {
        if (!textarea) return;

        const computed = window.getComputedStyle(textarea);

        const minHeight = parseFloat(computed.minHeight) || 200;
        const maxHeight = parseFloat(computed.maxHeight) || 386;

        const previousOverflowY = textarea.style.overflowY;

        textarea.style.height = 'auto';

        const nextHeight = Math.max(
            minHeight,
            Math.min(textarea.scrollHeight, maxHeight)
        );

        textarea.style.height = `${nextHeight}px`;

        if (textarea.scrollHeight > maxHeight) {
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.overflowY = previousOverflowY || '';
        }
    }

    function attachUserNoteInputTracker(textarea) {
        if (!textarea || textarea.dataset.modeUserNoteInputTrackerAttached === '1') return;

        textarea.dataset.modeUserNoteInputTrackerAttached = '1';

        textarea.addEventListener('keydown', () => {
            lastUserNoteInputAt = Date.now();
        });

        textarea.addEventListener('input', () => {
            lastUserNoteInputAt = Date.now();
        });
    }

    function isUserRecentlyEditingUserNote() {
        return Date.now() - lastUserNoteInputAt < 1000;
    }

    function getVisibleUserNoteExtendState(textarea) {
        const root = getUserNoteRootFromTextarea(textarea);
        if (!root) return !!lastAppliedUserNoteIsExtend;

        const switchBtn = root.querySelector('button[role="switch"]');
        if (!switchBtn) return !!lastAppliedUserNoteIsExtend;

        const ariaChecked = switchBtn.getAttribute('aria-checked');
        const dataState = switchBtn.getAttribute('data-state');

        if (ariaChecked === 'true' || dataState === 'checked') return true;
        if (ariaChecked === 'false' || dataState === 'unchecked') return false;

        return !!lastAppliedUserNoteIsExtend;
    }

    async function syncVisibleUserNoteUIFromAppliedThenServer() {
        const chatId = parseChatId();
        if (!chatId) return;

        const textarea = findVisibleUserNoteTextarea();
        if (!textarea) return;

        attachUserNoteInputTracker(textarea);

        if (isUserRecentlyEditingUserNote()) {
            console.log('[채팅모드별 유저노트 자동변경] 사용자가 입력 중이라 표시 동기화를 건너뜁니다.');
            return;
        }

        restoreLastAppliedNoteIfNeeded();

        if (lastAppliedUserNoteChatId === chatId && lastAppliedUserNoteMode) {
            const immediateContent = lastAppliedUserNoteContent || '';
            const immediateIsExtend = !!lastAppliedUserNoteIsExtend;

            const immediateKey = `${chatId}:immediate:${lastAppliedUserNoteMode}:${countChars(immediateContent)}:${immediateIsExtend}`;

            if (lastSyncedUserNoteKey !== immediateKey || textarea.value !== immediateContent) {
                setDisplayTextareaValueOnly(textarea, immediateContent);
                updateUserNoteCounterUI(textarea, immediateContent, immediateIsExtend);
                updateUserNoteExtendSwitchUI(textarea, immediateIsExtend);
                syncUserNoteTextareaHeightLikeCrack(textarea);

                lastSyncedUserNoteKey = immediateKey;

                console.log('[채팅모드별 유저노트 자동변경] 유저노트 창을 마지막 적용값으로 즉시 동기화했습니다.', {
                    chatId,
                    mode: lastAppliedUserNoteMode,
                    length: countChars(immediateContent),
                    isExtend: immediateIsExtend,
                });
            }
        }

        try {
            const serverNote = await fetchCurrentUserNote(chatId);

            if (isUserRecentlyEditingUserNote()) {
                console.log('[채팅모드별 유저노트 자동변경] 서버 조회 후 사용자가 입력 중이라 서버값 동기화를 건너뜁니다.');
                return;
            }

            const content = serverNote.content || '';
            const isExtend = !!serverNote.isExtend;
            const serverKey = `${chatId}:server:${countChars(content)}:${isExtend}:${content.slice(0, 40)}`;

            if (lastSyncedUserNoteKey === serverKey && textarea.value === content) {
                return;
            }

            setDisplayTextareaValueOnly(textarea, content);
            updateUserNoteCounterUI(textarea, content, isExtend);
            updateUserNoteExtendSwitchUI(textarea, isExtend);
            syncUserNoteTextareaHeightLikeCrack(textarea);

            lastSyncedUserNoteKey = serverKey;

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 창을 서버값으로 검증 동기화했습니다.', {
                chatId,
                length: countChars(content),
                isExtend,
            });
        } catch (err) {
            console.warn('[채팅모드별 유저노트 자동변경] 서버값 검증 실패', err);
        }
    }

    function scheduleVisibleUserNoteUiSync() {
        if (userNoteUiSyncScheduled) return;

        userNoteUiSyncScheduled = true;

        setTimeout(() => {
            syncVisibleUserNoteUIFromAppliedThenServer();
        }, 0);

        setTimeout(() => {
            syncVisibleUserNoteUIFromAppliedThenServer();
            userNoteUiSyncScheduled = false;
        }, 350);
    }

    function syncPatchedUserNoteToPreset(chatId, patchedUserNote, modeKeyOverride = '') {
        if (!chatId || !patchedUserNote) return;

        const currentChatId = parseChatId();
        if (currentChatId && currentChatId !== chatId) return;

        const content = typeof patchedUserNote.content === 'string'
            ? patchedUserNote.content
            : '';

        const isExtend = !!patchedUserNote.isExtend;

        const modeKey =
            modeKeyOverride ||
            getPendingPatchMode(chatId, { content, isExtend }) ||
            getCurrentAppliedModeForChat();

        if (!modeKey) {
            console.log('[채팅모드별 유저노트 자동변경] 현재 적용 모드를 알 수 없어 PATCH 유저노트를 프리셋에 반영하지 않았습니다.');
            return;
        }

        const notes = getModeNotes();

        notes[modeKey] = {
            content,
            isExtend,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);

        rememberLastAppliedNote(
            chatId,
            modeKey,
            content,
            isExtend
        );

        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋에 유저노트 수정값을 반영했습니다.`);

        console.log('[채팅모드별 유저노트 자동변경] PATCH 유저노트를 프리셋에 동기화했습니다.', {
            chatId,
            modeKey,
            length: countChars(content),
            isExtend,
        });
    }

    async function saveVisibleUserNoteToServerAndPreset(textarea) {
        const chatId = parseChatId();
        if (!chatId || !textarea) return;

        const modeKey = getCurrentAppliedModeForChat();

        if (!modeKey) {
            console.log('[채팅모드별 유저노트 자동변경] 현재 적용 모드를 알 수 없어 유저노트 저장값을 프리셋에 반영하지 않았습니다.');
            return;
        }

        const content = textarea.value || '';
        const isExtend = getVisibleUserNoteExtendState(textarea);

        try {
            await patchUserNote(chatId, content, isExtend, modeKey);

            syncPatchedUserNoteToPreset(
                chatId,
                {
                    content,
                    isExtend,
                },
                modeKey
            );

            rememberLastAppliedNote(chatId, modeKey, content, isExtend);

            setStatus(`${getModeLabel(modeKey)} 프리셋에 유저노트 저장값을 반영했습니다.`);
            showToast(`${getModeLabel(modeKey)} 프리셋 반영 완료`);

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 저장 버튼 값 강제 동기화 완료', {
                chatId,
                modeKey,
                length: countChars(content),
                isExtend,
            });
        } catch (err) {
            console.error('[채팅모드별 유저노트 자동변경] 유저노트 저장값 강제 동기화 실패', err);
            setStatus('유저노트 저장값을 서버/프리셋에 반영하는 중 오류가 발생했습니다.');
            showToast('유저노트 프리셋 반영 실패');
        }
    }

    function attachNativeUserNoteSaveInterceptor() {
        if (nativeUserNoteSaveInterceptorAttached) return;

        nativeUserNoteSaveInterceptorAttached = true;

        document.addEventListener('click', event => {
            const button = event.target?.closest?.('button');
            if (!button) return;

            const textarea = findVisibleUserNoteTextarea();
            if (!textarea) return;

            const root = getUserNoteRootFromTextarea(textarea);

            if (root && !root.contains(button)) return;

            const buttonText = (button.textContent || '').trim();

            const isSaveButton =
                buttonText === '저장' ||
                buttonText === '완료' ||
                buttonText.includes('저장') ||
                buttonText.includes('완료');

            if (!isSaveButton) return;

            const capturedTextarea = textarea;

            clearTimeout(nativeUserNoteSaveTimer);

            nativeUserNoteSaveTimer = setTimeout(() => {
                saveVisibleUserNoteToServerAndPreset(capturedTextarea);
            }, 250);

            console.log('[채팅모드별 유저노트 자동변경] 유저노트 저장 버튼 클릭 감지');
        }, true);
    }

    async function getFetchBodyText(resource, config) {
        const body = config?.body;

        if (typeof body === 'string') {
            return body;
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        if (
            resource &&
            typeof Request !== 'undefined' &&
            resource instanceof Request
        ) {
            try {
                return await resource.clone().text();
            } catch {
                return '';
            }
        }

        return '';
    }

    function getFetchUrl(resource) {
        if (typeof resource === 'string') return resource;
        return resource?.url || '';
    }

    function getFetchMethod(resource, config) {
        return String(config?.method || resource?.method || 'GET').toUpperCase();
    }

    GM_addStyle(`
        #mun-toggle-btn {
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 999999;
            width: 52px;
            height: 52px;
            border: none;
            border-radius: 50%;
            background: #6A3DE8;
            color: #fff;
            font-size: 22px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.18);
            display: flex;
            align-items: center;
            justify-content: center;
            touch-action: none;
            transition: transform .15s ease, opacity .15s ease, background .15s ease;
        }

        #mun-toggle-btn:hover {
            transform: scale(1.05);
            background: #5a31cf;
        }

        #mun-toggle-btn.dragging {
            opacity: 0.85;
            transform: scale(1.08);
            transition: none;
        }

        #mun-panel {
            position: fixed;
            right: 20px;
            bottom: 82px;
            z-index: 999999;
            width: 520px;
            max-width: 94vw;
            max-height: 82vh;
            overflow-y: auto;
            background: #F7F7F5;
            border: 1px solid #C7C5BD;
            border-radius: 12px;
            box-shadow: 0 8px 22px rgba(0,0,0,0.15);
            padding: 14px;
            display: none;
            font-family: sans-serif;
        }

        #mun-panel.show {
            display: block;
        }

        #mun-panel h3 {
            font-size: 15px;
            color: #1A1918;
        }

        .mun-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 10px;
        }

        .mun-panel-header h3 {
            margin: 0;
        }

        #mun-close-btn {
            border: none;
            background: transparent;
            color: #61605A;
            font-size: 22px;
            line-height: 1;
            cursor: pointer;
            padding: 4px 7px;
            border-radius: 6px;
        }

        #mun-close-btn:hover {
            background: rgba(0,0,0,0.06);
            color: #1A1918;
        }

        #mun-status {
            font-size: 12px;
            line-height: 1.5;
            min-height: 18px;
            margin-bottom: 10px;
            color: #61605A;
            word-break: break-word;
        }

        .mun-top-actions {
            display: flex;
            gap: 6px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }

        .mun-btn {
            border: none;
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
        }

        .mun-btn.primary { background: #6A3DE8; color: white; }
        .mun-btn.gray { background: #61605A; color: white; }
        .mun-btn.red { background: #C0392B; color: white; }

        .mun-mode-slot {
            border: 1px solid #D9D7CF;
            border-radius: 10px;
            background: white;
            padding: 10px;
            margin-bottom: 10px;
        }

        .mun-mode-header {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            align-items: flex-start;
            margin-bottom: 8px;
        }

        .mun-mode-title {
            font-size: 13px;
            font-weight: bold;
            color: #1A1918;
            word-break: break-word;
        }

        .mun-mode-key {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 999px;
            background: #EEEAFD;
            color: #5a31cf;
            white-space: nowrap;
        }

        .mun-meta {
            font-size: 11px;
            color: #777;
            margin-bottom: 8px;
            line-height: 1.5;
        }

        .mun-preview {
            font-size: 12px;
            color: #555;
            background: #FAFAF8;
            border: 1px solid #ECEAE4;
            border-radius: 8px;
            padding: 8px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 70px;
            overflow: hidden;
            margin-bottom: 8px;
        }

        .mun-textarea {
            width: 100%;
            min-height: 130px;
            resize: vertical;
            box-sizing: border-box;
            border: 1px solid #C7C5BD;
            border-radius: 8px;
            padding: 8px;
            font-size: 12px;
            font-family: sans-serif;
            line-height: 1.5;
            color: #1A1918;
            background: #FFFFFF;
            margin-bottom: 8px;
        }

        .mun-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        }

        .mun-extend-label {
            font-size: 12px;
            color: #555;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            margin-right: 4px;
        }

        .mun-empty {
            font-size: 12px;
            color: #777;
            padding: 10px 4px;
        }

        #mun-toast {
            position: fixed;
            left: 50%;
            bottom: 90px;
            transform: translateX(-50%);
            z-index: 1000000;
            background: rgba(30,30,30,0.92);
            color: white;
            padding: 10px 16px;
            border-radius: 18px;
            font-size: 12px;
            font-family: sans-serif;
            opacity: 0;
            transition: opacity .25s ease;
            pointer-events: none;
            max-width: 88vw;
            text-align: center;
            word-break: break-word;
        }

        #mun-toast.show {
            opacity: 1;
        }
    `);

    function showToast(message, duration = 2200) {
        const toast = document.getElementById('mun-toast');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    function setStatus(message) {
        const el = document.getElementById('mun-status');
        if (el) el.textContent = message;
    }

    function buildUI() {
        if (document.getElementById('mun-toggle-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'mun-toggle-btn';
        btn.textContent = '🧩';

        const panel = document.createElement('div');
        panel.id = 'mun-panel';
        panel.innerHTML = `
            <div class="mun-panel-header">
                <h3>채팅모드별 유저노트 자동변경</h3>
                <button id="mun-close-btn" type="button" aria-label="닫기">×</button>
            </div>

            <div id="mun-status">준비되었습니다.</div>

            <div class="mun-top-actions">
                <button id="mun-export-btn" class="mun-btn gray">전체 내보내기</button>
                <button id="mun-import-btn" class="mun-btn gray">전체 가져오기</button>
            </div>

            <div id="mun-slots"></div>
        `;

        const toast = document.createElement('div');
        toast.id = 'mun-toast';

        document.body.appendChild(btn);
        document.body.appendChild(panel);
        document.body.appendChild(toast);

        const savedX = GM_getValue(BTN_POS_KEY_X, null);
        const savedY = GM_getValue(BTN_POS_KEY_Y, null);

        if (savedX !== null && savedY !== null) {
            btn.style.left = `${savedX}px`;
            btn.style.top = `${savedY}px`;
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }

        if (getPanelOpen()) {
            panel.classList.add('show');
        }

        btn.addEventListener('click', () => {
            if (btn.dataset.dragged === '1') {
                btn.dataset.dragged = '0';
                return;
            }

            panel.classList.toggle('show');
            setPanelOpen(panel.classList.contains('show'));

            if (panel.classList.contains('show')) {
                renderModeSlots();
            }
        });

        document.getElementById('mun-close-btn')?.addEventListener('click', () => {
            panel.classList.remove('show');
            setPanelOpen(false);
        });

        document.getElementById('mun-export-btn')?.addEventListener('click', exportModeNotes);
        document.getElementById('mun-import-btn')?.addEventListener('click', importModeNotes);

        attachDrag(btn);
        renderModeSlots();
    }

    function renderModeSlots() {
        const container = document.getElementById('mun-slots');
        if (!container) return;

        const chatId = parseChatId();
        const notes = getModeNotes();

        if (!chatId) {
            container.innerHTML = `<div class="mun-empty">채팅방 페이지에서만 채팅방별 프리셋을 사용할 수 있습니다.</div>`;
            return;
        }

        container.innerHTML = CHAT_MODES.map(mode => {
            const note = notes[mode.key] || {
                content: '',
                isExtend: false,
                updatedAt: null,
            };

            return `
                <div class="mun-mode-slot" data-mode="${escapeHtml(mode.key)}">
                    <div class="mun-mode-header">
                        <div class="mun-mode-title">${escapeHtml(mode.label)}</div>
                        <div class="mun-mode-key">${escapeHtml(mode.key)}</div>
                    </div>

                    <div class="mun-meta">
                        현재 채팅방: ${escapeHtml(chatId)}
                        <br>
                        마지막 저장: ${escapeHtml(formatTime(note.updatedAt))}
                        <br>
                        확장 모드: ${note.isExtend ? '켜짐' : '꺼짐'}
                    </div>

                    <div class="mun-preview">${escapeHtml(previewText(note.content))}</div>

                    <textarea
                        class="mun-textarea"
                        data-mode-textarea="${escapeHtml(mode.key)}"
                        placeholder="${escapeHtml(mode.label)}에서 자동 적용할 유저노트를 입력하세요."
                    >${escapeHtml(note.content)}</textarea>

                    <div class="mun-actions">
                        <label class="mun-extend-label">
                            <input
                                type="checkbox"
                                data-mode-extend="${escapeHtml(mode.key)}"
                                ${note.isExtend ? 'checked' : ''}
                            >
                            확장 모드
                        </label>

                        <button class="mun-btn primary" data-action-save="${escapeHtml(mode.key)}">저장</button>
                        <button class="mun-btn gray" data-action-load="${escapeHtml(mode.key)}">현재 유저노트 불러오기</button>
                        <button class="mun-btn red" data-action-clear="${escapeHtml(mode.key)}">비우기</button>
                    </div>
                </div>
            `;
        }).join('');

        CHAT_MODES.forEach(mode => {
            container.querySelector(`[data-action-save="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                saveModeNote(mode.key);
            });

            container.querySelector(`[data-action-load="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                loadCurrentUserNoteToMode(mode.key);
            });

            container.querySelector(`[data-action-clear="${CSS.escape(mode.key)}"]`)?.addEventListener('click', () => {
                clearModeNote(mode.key);
            });
        });
    }

    function saveModeNote(modeKey) {
        const textarea = document.querySelector(`[data-mode-textarea="${CSS.escape(modeKey)}"]`);
        const extendInput = document.querySelector(`[data-mode-extend="${CSS.escape(modeKey)}"]`);

        if (!textarea) return;

        const notes = getModeNotes();

        notes[modeKey] = {
            content: textarea.value || '',
            isExtend: !!extendInput?.checked,
            updatedAt: Date.now(),
        };

        setModeNotes(notes);

        const currentMode = getCurrentAppliedModeForChat();
        const chatId = parseChatId();

        if (chatId && currentMode === modeKey) {
            rememberLastAppliedNote(chatId, modeKey, textarea.value || '', !!extendInput?.checked);
        }

        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋을 현재 채팅방에 저장했습니다.`);
        showToast(`${getModeLabel(modeKey)} 저장 완료`);
    }

    async function loadCurrentUserNoteToMode(modeKey) {
        const chatId = parseChatId();

        if (!chatId) {
            setStatus('채팅방 페이지에서만 사용할 수 있습니다.');
            showToast('채팅방 페이지에서만 사용할 수 있습니다.');
            return;
        }

        const token = getToken();

        if (!token) {
            setStatus('인증 토큰을 찾지 못했습니다. 다시 로그인해 주세요.');
            showToast('인증 토큰을 찾지 못했습니다.');
            return;
        }

        try {
            setStatus('현재 채팅방 유저노트를 불러오는 중입니다...');

            const current = await fetchCurrentUserNote(chatId);
            const notes = getModeNotes();

            notes[modeKey] = {
                content: current.content || '',
                isExtend: !!current.isExtend,
                updatedAt: Date.now(),
            };

            setModeNotes(notes);

            const currentMode = getCurrentAppliedModeForChat();

            if (currentMode === modeKey) {
                rememberLastAppliedNote(chatId, modeKey, current.content || '', !!current.isExtend);
            }

            renderModeSlots();

            setStatus(`현재 유저노트를 ${getModeLabel(modeKey)} 프리셋에 저장했습니다.`);
            showToast(`${getModeLabel(modeKey)}에 불러오기 완료`);
        } catch (err) {
            console.error('[현재 유저노트 모드 저장]', err);
            setStatus(err.message || '현재 유저노트를 불러오는 중 오류가 발생했습니다.');
            showToast('불러오기 실패');
        }
    }

    function clearModeNote(modeKey) {
        if (!confirm(`${getModeLabel(modeKey)} 프리셋을 비우시겠습니까?`)) return;

        const notes = getModeNotes();

        notes[modeKey] = {
            content: '',
            isExtend: false,
            updatedAt: null,
        };

        setModeNotes(notes);

        const currentMode = getCurrentAppliedModeForChat();
        const chatId = parseChatId();

        if (chatId && currentMode === modeKey) {
            rememberLastAppliedNote(chatId, modeKey, '', false);
        }

        renderModeSlots();

        setStatus(`${getModeLabel(modeKey)} 프리셋을 비웠습니다.`);
        showToast('비우기 완료');
    }

    async function applyUserNoteByChatMode(chatId, chatMode) {
        if (!chatId || !chatMode) return;

        const notes = getModeNotes();
        const note = notes[chatMode];

        if (!note) {
            setStatus(`"${chatMode}" 모드는 등록되지 않은 모드입니다.`);
            return;
        }

        if (!note.content) {
            setStatus(`${getModeLabel(chatMode)}에 저장된 프리셋이 없어 자동 적용하지 않았습니다.`);
            rememberLastAppliedNote(chatId, chatMode, '', !!note.isExtend);
            scheduleVisibleUserNoteUiSync();
            return;
        }

        const token = getToken();

        if (!token) {
            setStatus('인증 토큰을 찾지 못해 자동 적용하지 못했습니다.');
            showToast('인증 토큰을 찾지 못했습니다.');
            return;
        }

        const applyKey = `${chatId}:${chatMode}`;
        const now = Date.now();

        if (lastAutoAppliedModeKey === applyKey && now - lastAutoApplyAt < 2500) {
            return;
        }

        lastAutoAppliedModeKey = applyKey;
        lastAutoApplyAt = now;

        try {
            setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용하는 중입니다...`);

            await patchUserNote(chatId, note.content, !!note.isExtend, chatMode);

            rememberLastAppliedNote(chatId, chatMode, note.content, !!note.isExtend);
            scheduleVisibleUserNoteUiSync();

            const confirmed = await fetchCurrentUserNote(chatId).catch(() => null);

            if (confirmed) {
                console.log('[채팅모드별 유저노트 자동변경] 서버 확인값', {
                    chatId,
                    mode: chatMode,
                    matched: confirmed.content === note.content,
                    expectedLength: countChars(note.content),
                    actualLength: countChars(confirmed.content),
                });
            }

            setStatus(`${getModeLabel(chatMode)} 프리셋을 현재 채팅방 유저노트에 자동 적용했습니다.`);
            showToast(`${getModeLabel(chatMode)} 자동 적용 완료`);
        } catch (err) {
            console.error('[채팅 모드 유저노트 자동 적용]', err);
            setStatus(err.message || '채팅 모드별 유저노트 자동 적용 중 오류가 발생했습니다.');
            showToast('자동 적용 실패');
        }
    }

    function exportModeNotes() {
        const chatId = parseChatId();

        if (!chatId) {
            setStatus('채팅방 페이지에서만 내보낼 수 있습니다.');
            showToast('채팅방 페이지에서만 내보낼 수 있습니다.');
            return;
        }

        const notes = getModeNotes();

        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            type: 'crack_chat_room_mode_user_notes',
            sourceChatId: chatId,
            modes: CHAT_MODES,
            notes,
        };

        const text = JSON.stringify(payload, null, 2);

        navigator.clipboard.writeText(text)
            .then(() => {
                setStatus('현재 채팅방의 모드별 프리셋을 클립보드에 복사했습니다.');
                showToast('현재 채팅방 프리셋 내보내기 완료');
            })
            .catch(() => {
                prompt('클립보드 복사에 실패했습니다. 아래 내용을 직접 복사해 주세요.', text);
                setStatus('현재 채팅방의 모드별 프리셋을 내보냈습니다.');
            });
    }

    async function importModeNotes() {
        const chatId = parseChatId();

        if (!chatId) {
            setStatus('채팅방 페이지에서만 가져올 수 있습니다.');
            showToast('채팅방 페이지에서만 가져올 수 있습니다.');
            return;
        }

        let raw = '';

        try {
            raw = await navigator.clipboard.readText();
        } catch (err) {
            console.error('[모드별 유저노트 가져오기] clipboard read failed', err);
            setStatus('클립보드 내용을 읽지 못했습니다. 브라우저 권한을 확인해 주세요.');
            showToast('클립보드 읽기 실패');
            return;
        }

        if (!raw || !raw.trim()) {
            setStatus('클립보드에 가져올 데이터가 없습니다.');
            showToast('클립보드가 비어 있습니다.');
            return;
        }

        let parsed;

        try {
            parsed = JSON.parse(raw);
        } catch {
            setStatus('클립보드 내용이 올바른 JSON 형식이 아닙니다.');
            showToast('JSON 형식 오류');
            return;
        }

        const imported = parsed?.notes;

        if (!imported || typeof imported !== 'object') {
            setStatus('가져오기 데이터에 notes 객체가 없습니다.');
            showToast('가져오기 형식 오류');
            return;
        }

        const nextNotes = getModeNotes();

        CHAT_MODES.forEach(mode => {
            if (imported[mode.key] && typeof imported[mode.key] === 'object') {
                nextNotes[mode.key] = {
                    content: typeof imported[mode.key].content === 'string'
                        ? imported[mode.key].content
                        : '',
                    isExtend: !!imported[mode.key].isExtend,
                    updatedAt: imported[mode.key].updatedAt || Date.now(),
                };
            }
        });

        setModeNotes(nextNotes);

        const currentMode = getCurrentAppliedModeForChat();

        if (currentMode && nextNotes[currentMode]) {
            rememberLastAppliedNote(
                chatId,
                currentMode,
                nextNotes[currentMode].content || '',
                !!nextNotes[currentMode].isExtend
            );
        }

        renderModeSlots();

        setStatus('현재 채팅방의 모드별 프리셋을 가져왔습니다.');
        showToast('현재 채팅방 프리셋 가져오기 완료');
    }

    function hookChatModeFetch() {
        const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        if (targetWindow.__crackModeUserNoteFetchHooked) return;
        targetWindow.__crackModeUserNoteFetchHooked = true;

        const originalFetch = targetWindow.fetch;

        targetWindow.fetch = async function (...args) {
            let shouldSyncPatchedUserNote = false;
            let patchedChatId = '';
            let patchedUserNote = null;

            try {
                const [resource, config] = args;

                const url = getFetchUrl(resource);
                const method = getFetchMethod(resource, config);
                const bodyText = await getFetchBodyText(resource, config);

                if (
                    url &&
                    url.includes('event-gateway.wrtn.ai/v1/track') &&
                    bodyText &&
                    bodyText.includes('select_chat_mode_btn')
                ) {
                    const parsed = JSON.parse(bodyText);

                    if (parsed?.eventName === 'select_chat_mode_btn') {
                        const chatMode = parsed?.eventProperties?.chat_mode;
                        const chatIdFromEvent = parsed?.eventProperties?.chat_id;
                        const chatId = chatIdFromEvent || parseChatId();

                        console.log('[채팅모드별 유저노트 자동변경 감지]', {
                            chatId,
                            chatMode,
                        });

                        setTimeout(() => {
                            applyUserNoteByChatMode(chatId, chatMode);
                        }, 300);
                    }
                }

                if (
                    !internalUserNotePatchInProgress &&
                    url &&
                    method === 'PATCH' &&
                    url.includes('crack-api.wrtn.ai/crack-gen/v3/chats/') &&
                    bodyText
                ) {
                    const parsed = JSON.parse(bodyText);

                    if (
                        parsed?.userNote &&
                        typeof parsed.userNote === 'object'
                    ) {
                        const chatIdMatch = url.match(/\/v3\/chats\/([^/?#]+)/);
                        patchedChatId = chatIdMatch?.[1] || parseChatId() || '';

                        patchedUserNote = {
                            content: typeof parsed.userNote.content === 'string'
                                ? parsed.userNote.content
                                : '',
                            isExtend: !!parsed.userNote.isExtend,
                        };

                        shouldSyncPatchedUserNote = true;
                    }
                }
            } catch (err) {
                console.warn('[채팅모드별 유저노트 자동변경 감지 실패]', err);
            }

            const response = await originalFetch.apply(this, args);

            if (shouldSyncPatchedUserNote && patchedChatId && patchedUserNote) {
                if (response?.ok) {
                    setTimeout(() => {
                        syncPatchedUserNoteToPreset(patchedChatId, patchedUserNote);
                        scheduleVisibleUserNoteUiSync();
                    }, 100);
                } else {
                    console.warn('[채팅모드별 유저노트 자동변경] PATCH 실패로 프리셋 동기화 생략', {
                        status: response?.status,
                        patchedChatId,
                    });
                }
            }

            return response;
        };
    }

    async function getFetchBodyText(resource, config) {
        const body = config?.body;

        if (typeof body === 'string') {
            return body;
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        if (
            resource &&
            typeof Request !== 'undefined' &&
            resource instanceof Request
        ) {
            try {
                return await resource.clone().text();
            } catch {
                return '';
            }
        }

        return '';
    }

    function getFetchUrl(resource) {
        if (typeof resource === 'string') return resource;
        return resource?.url || '';
    }

    function getFetchMethod(resource, config) {
        return String(config?.method || resource?.method || 'GET').toUpperCase();
    }

    function attachDrag(btn) {
        let isDragging = false;
        let hasDragged = false;
        let pressTimer = null;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        function startDrag(e) {
            hasDragged = false;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            const rect = btn.getBoundingClientRect();

            startX = clientX;
            startY = clientY;
            initialLeft = rect.left;
            initialTop = rect.top;

            pressTimer = setTimeout(() => {
                isDragging = true;
                btn.classList.add('dragging');
            }, 320);
        }

        function moveDrag(e) {
            if (!isDragging) return;

            e.preventDefault();
            hasDragged = true;

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;

            let newLeft = initialLeft + (clientX - startX);
            let newTop = initialTop + (clientY - startY);

            const maxX = window.innerWidth - btn.offsetWidth;
            const maxY = window.innerHeight - btn.offsetHeight;

            newLeft = Math.max(0, Math.min(newLeft, maxX));
            newTop = Math.max(0, Math.min(newTop, maxY));

            btn.style.left = `${newLeft}px`;
            btn.style.top = `${newTop}px`;
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }

        function endDrag() {
            clearTimeout(pressTimer);

            if (isDragging) {
                isDragging = false;
                btn.classList.remove('dragging');

                GM_setValue(BTN_POS_KEY_X, parseInt(btn.style.left, 10));
                GM_setValue(BTN_POS_KEY_Y, parseInt(btn.style.top, 10));
            }

            if (hasDragged) {
                btn.dataset.dragged = '1';

                setTimeout(() => {
                    btn.dataset.dragged = '0';
                }, 100);
            }
        }

        btn.addEventListener('touchstart', startDrag, { passive: false });
        btn.addEventListener('touchmove', moveDrag, { passive: false });
        btn.addEventListener('touchend', endDrag);

        btn.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', moveDrag);
        document.addEventListener('mouseup', endDrag);
    }

    function init() {
        buildUI();
        attachNativeUserNoteSaveInterceptor();

        restoreLastAppliedNoteIfNeeded();

        if (!isChatPage()) {
            setStatus('채팅방 페이지에서만 유저노트 적용 기능이 동작합니다.');
            return;
        }

        renderModeSlots();
    }

    let lastUrl = location.href;

    const observer = new MutationObserver(() => {
        if (!document.body) return;

        if (!document.getElementById('mun-toggle-btn')) {
            init();
        }

        const userNoteTextarea = findVisibleUserNoteTextarea();

        if (userNoteTextarea) {
            attachUserNoteInputTracker(userNoteTextarea);
        }

        if (userNoteTextarea && userNoteTextarea !== lastSeenUserNoteTextarea) {
            lastSeenUserNoteTextarea = userNoteTextarea;
            lastSyncedUserNoteKey = '';
            scheduleVisibleUserNoteUiSync();
        }

        if (!userNoteTextarea && lastSeenUserNoteTextarea) {
            lastSeenUserNoteTextarea = null;
            lastSyncedUserNoteKey = '';
            lastUserNoteInputAt = 0;
        }

        if (location.href !== lastUrl) {
            lastUrl = location.href;

            lastAutoAppliedModeKey = '';
            lastAutoApplyAt = 0;
            lastSeenUserNoteTextarea = null;
            lastSyncedUserNoteKey = '';
            lastUserNoteInputAt = 0;
            pendingUserNotePatchMode = null;

            setTimeout(() => {
                init();
                renderModeSlots();
                setStatus('채팅방이 변경되어 해당 채팅방의 모드별 프리셋을 불러왔습니다.');
            }, 500);
        }
    });

    function start() {
        hookChatModeFetch();

        init();

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
