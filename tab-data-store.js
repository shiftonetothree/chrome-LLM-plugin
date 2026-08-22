// =============================================================================
// TabDataStore — central data layer for all per-tab state
// Data lives as long as the extension page is open (sidepanel mode).
// View just switches which tab's data it renders — no data is destroyed on tab switch.
// =============================================================================

export class TabDataStore {
    constructor() {
        this._tabs = {}; // tabId -> { tabId, pageContext, conversationHistory, streaming, dirty }
    }

    _storageKey(tabId) {
        return `conversation_${tabId}`;
    }

    _ensure(tabId) {
        if (!this._tabs[tabId]) {
            this._tabs[tabId] = {
                tabId,
                pageContext: null,
                conversationHistory: [],
                streaming: null,
                dirty: false
            };
        }
        return this._tabs[tabId];
    }

    getOrCreate(tabId) {
        return this._ensure(tabId);
    }

    remove(tabId) {
        delete this._tabs[tabId];
    }

    getConversation(tabId) {
        return this._ensure(tabId).conversationHistory;
    }

    appendMessage(tabId, message) {
        const t = this._ensure(tabId);
        t.conversationHistory.push(message);
        t.dirty = true;
    }

    appendToolMessages(tabId, msgs) {
        const t = this._ensure(tabId);
        for (const m of msgs) {
            t.conversationHistory.push(m);
        }
        t.dirty = true;
    }

    setConversation(tabId, history) {
        const t = this._ensure(tabId);
        t.conversationHistory = history;
        t.dirty = false;
    }

    clearConversation(tabId) {
        const t = this._ensure(tabId);
        t.conversationHistory = [];
        t.dirty = true;
    }

    startStreaming(tabId, messageId) {
        const t = this._ensure(tabId);
        t.streaming = { messageId, content: '', done: false, stopped: false, toolMessages: [] };
    }

    updateStreamContent(tabId, content) {
        const t = this._ensure(tabId);
        if (t.streaming) t.streaming.content = content;
    }

    updateStreamDone(tabId, done) {
        const t = this._ensure(tabId);
        if (t.streaming) t.streaming.done = done;
    }

    updateStreamToolMessages(tabId, toolMessages) {
        const t = this._ensure(tabId);
        if (t.streaming) t.streaming.toolMessages = toolMessages;
    }

    getStreaming(tabId) {
        const t = this._tabs[tabId];
        return t ? t.streaming : null;
    }

    stopStreaming(tabId) {
        const t = this._ensure(tabId);
        if (!t.streaming) return '';
        t.streaming.done = true;
        t.streaming.stopped = true;
        return t.streaming.content;
    }

    finalizeStreaming(tabId) {
        const t = this._ensure(tabId);
        if (!t.streaming) return;
        const s = t.streaming;
        if (s.content) {
            t.conversationHistory.push({ role: 'assistant', content: s.content });
        }
        if (s.toolMessages && s.toolMessages.length > 0) {
            for (const tm of s.toolMessages) {
                t.conversationHistory.push(tm);
            }
        }
        t.streaming = null;
        t.dirty = true;
    }

    getPageContext(tabId) {
        const t = this._tabs[tabId];
        return t ? t.pageContext : null;
    }

    setPageContext(tabId, ctx) {
        this._ensure(tabId).pageContext = ctx;
    }

    async persist(tabId) {
        const t = this._tabs[tabId];
        if (!t) return;
        try {
            const key = this._storageKey(tabId);
            await chrome.storage.local.set({
                [key]: {
                    history: t.conversationHistory,
                    pageContext: t.pageContext,
                    savedAt: Date.now()
                }
            });
            t.dirty = false;
        } catch (error) {
            console.error('[DataStore] Error saving conversation:', error);
        }
    }

    async load(tabId) {
        try {
            const key = this._storageKey(tabId);
            const result = await chrome.storage.local.get([key]);
            if (result[key]) {
                const t = this._ensure(tabId);
                t.conversationHistory = result[key].history || [];
                if (result[key].pageContext) {
                    t.pageContext = result[key].pageContext;
                }
                t.dirty = false;
                return result[key];
            }
        } catch (error) {
            console.error('[DataStore] Error loading conversation:', error);
        }
        return null;
    }

    async removePersisted(tabId) {
        try {
            await chrome.storage.local.remove([this._storageKey(tabId)]);
        } catch (error) {
            console.error('[DataStore] Error removing conversation:', error);
        }
    }

    hasConversation(tabId) {
        const t = this._tabs[tabId];
        return t && t.conversationHistory.length > 0;
    }
}
