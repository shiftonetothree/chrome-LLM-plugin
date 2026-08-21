// Popup script - handles multiple LLM providers
// =============================================================================
// TabDataStore — central data layer for all per-tab state
// Data lives as long as the extension page is open (sidepanel mode).
// View just switches which tab's data it renders — no data is destroyed on tab switch.
// =============================================================================

class TabDataStore {
  constructor() {
    this._tabs = {}; // tabId -> { tabId, pageContext, conversationHistory, streaming, dirty }
  }

  // ---- internal helpers ----
  _storageKey(tabId) {
    return `conversation_${tabId}`;
  }

  _ensure(tabId) {
    if (!this._tabs[tabId]) {
      this._tabs[tabId] = {
        tabId,
        pageContext: null,
        conversationHistory: [],
        streaming: null, // { messageId, content, done, stopped, toolMessages }
        dirty: false
      };
    }
    return this._tabs[tabId];
  }

  // ---- lifecycle ----
  getOrCreate(tabId) {
    return this._ensure(tabId);
  }

  remove(tabId) {
    delete this._tabs[tabId];
  }

  // ---- conversation operations ----
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
    t.dirty = false; // just loaded, not dirty
  }

  clearConversation(tabId) {
    const t = this._ensure(tabId);
    t.conversationHistory = [];
    t.dirty = true;
  }

  // ---- streaming operations (pure memory, no persistence) ----
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

  // ---- page context ----
  getPageContext(tabId) {
    const t = this._tabs[tabId];
    return t ? t.pageContext : null;
  }

  setPageContext(tabId, ctx) {
    this._ensure(tabId).pageContext = ctx;
  }

  // ---- persistence ----
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

  // Check if tab has any data (for UI to decide whether to show welcome message)
  hasConversation(tabId) {
    const t = this._tabs[tabId];
    return t && t.conversationHistory.length > 0;
  }
}

// =============================================================================
// Global state — View layer only
// =============================================================================
const store = new TabDataStore();
let activeTabId = null;           // currently displayed tab
let activeStreamEl = null;        // streaming message DOM element in the active tab
let isFirstChunkAfterStreamStart = false;
let isFetchingModels = false;
let lastDebugInfo = { systemContent: '', userText: '' };
let searchEngines = null;
let enabledSearchEngines = { bing: true, google: false, baidu: false, wikipedia: false };

// DOM Elements
const chatContainer = document.getElementById('chatContainer');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const pageTitleEl = document.getElementById('pageTitle');
const pageUrlEl = document.getElementById('pageUrl');
const contextBanner = document.getElementById('contextBanner');
const loadingIndicator = document.getElementById('loadingIndicator');
const apiKeyInput = document.getElementById('apiKey');
const providerSelect = document.getElementById('providerSelect');
const modelSelect = document.getElementById('modelSelect');
const customEndpointRow = document.getElementById('customEndpointRow');
const customEndpointInput = document.getElementById('customEndpoint');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');
const configToggleRow = document.getElementById('configToggleRow');
const toggleConfigBtn = document.getElementById('toggleConfigBtn');

// Provider presets
const PROVIDERS = {
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', modelsEndpoint: 'https://api.openai.com/v1/models', modelKey: 'id', defaultModel: 'gpt-4o' },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', modelsEndpoint: 'https://api.deepseek.com/v1/models', modelKey: 'id', defaultModel: 'deepseek-chat' },
  siliconflow: { name: 'SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', modelsEndpoint: 'https://api.siliconflow.cn/v1/models', modelKey: 'id', defaultModel: 'deepseek-ai/DeepSeek-V2.5' },
  ollama: { name: 'Ollama', endpoint: 'http://localhost:11434/v1/chat/completions', modelsEndpoint: 'http://localhost:11434/api/tags', modelKey: 'name', defaultModel: 'llama3' },
  custom: { name: 'Custom', endpoint: '', modelsEndpoint: '', modelKey: 'id', defaultModel: '' }
};

// =============================================================================
// View helpers — pure DOM manipulation
// =============================================================================

// Allowed tags/attributes for AI-generated Markdown content
const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup',
  'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'br', 'img', 'span', 'div',
  'section', 'article', 'header', 'footer'
]);

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel',
  'width', 'height', 'colspan', 'rowspan', 'scope'
]);

function sanitizeHTML(html) {
  try {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const container = doc.body.firstChild;

    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED_TAGS.has(node.tagName.toLowerCase())) {
          // Replace disallowed tag with its text content
          const text = node.textContent;
          node.replaceWith(document.createTextNode(text));
          return;
        }
        // Remove disallowed attributes
        const attrsToRemove = [];
        for (const attr of node.attributes) {
          if (!ALLOWED_ATTRS.has(attr.name.toLowerCase())) {
            attrsToRemove.push(attr.name);
          } else if (attr.name.toLowerCase() === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:')) {
            attrsToRemove.push(attr.name);
          }
        }
        for (const name of attrsToRemove) {
          node.removeAttribute(name);
        }
        // Recursively clean children (iterate backwards since we may replace nodes)
        let child = node.firstChild;
        while (child) {
          const next = child.nextSibling;
          cleanNode(child);
          child = next;
        }
      }
    }

    cleanNode(container);
    return container.innerHTML;
  } catch (e) {
    // Fallback: return text-only version
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
  }
}

function addMessage(role, content) {
  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  const fontSize = (fontSizeSlider?.value || 12) + 'px';

  if (role === 'assistant' && typeof marked !== 'undefined' && content) {
    const parsed = marked.parse(content);
    if (parsed && parsed.trim()) {
      msg.innerHTML = sanitizeHTML(parsed);
    } else {
      msg.textContent = content;
    }
  } else {
    msg.textContent = content || '';
  }

  msg.style.fontSize = fontSize;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addPlaceholderMessage(text) {
  const msg = document.createElement('div');
  msg.className = 'message assistant placeholder-message';
  msg.textContent = text;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showLoading(show) {
  loadingIndicator.classList.toggle('active', show);
}

function restoreInputState() {
  showLoading(false);
  sendBtn.style.display = 'block';
  stopBtn.style.display = 'none';
  userInput.disabled = false;
  userInput.focus();
}

function renderConversation(tabId) {
  const history = store.getConversation(tabId);
  history.forEach(msg => {
    if (msg.role === 'tool') return;
    if (msg.role === 'assistant' && msg.tool_calls) return;
    addMessage(msg.role, msg.content);
  });
}

// Render or update the streaming message element from the store
function renderStreamingMessage(tabId) {
  const streaming = store.getStreaming(tabId);
  if (!streaming) return;

  const content = streaming.content || '';

  if (streaming.done) {
    // Finalize streaming into a regular message
    if (activeStreamEl) {
      const currentFontSize = fontSizeSlider?.value || 12;
      if (typeof marked !== 'undefined' && content) {
        activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content));
      } else {
        activeStreamEl.textContent = content || '(已停止生成)';
      }
      activeStreamEl.style.fontSize = currentFontSize + 'px';
      activeStreamEl.classList.remove('streaming');
      activeStreamEl = null;
    }
    store.finalizeStreaming(tabId);
    store.persist(tabId);
    restoreInputState();
    statusEl.textContent = streaming.stopped ? '已停止' : '就绪';
  } else {
    // Update or create streaming element
    if (!activeStreamEl) {
      activeStreamEl = document.createElement('div');
      activeStreamEl.className = 'message assistant streaming';
      chatContainer.appendChild(activeStreamEl);
      showLoading(true);
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'block';
    }

    const currentFontSize = fontSizeSlider?.value || 12;

    let shouldScrollToBottom;
    if (isFirstChunkAfterStreamStart) {
      shouldScrollToBottom = true;
      isFirstChunkAfterStreamStart = false;
    } else {
      const threshold = 50;
      shouldScrollToBottom = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - threshold;
    }

    if (typeof marked !== 'undefined' && content) {
      activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content)) + '<span class="streaming-cursor">▊</span>';
    } else if (content) {
      activeStreamEl.textContent = content;
    } else {
      activeStreamEl.innerHTML = '<span class="streaming-cursor">▊</span>';
    }
    activeStreamEl.style.fontSize = currentFontSize + 'px';

    if (shouldScrollToBottom) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }
}

// Switch the view to a different tab — load data from store, render UI
async function switchToTab(tabId) {
  if (!tabId) return;

  const prevTabId = activeTabId;
  const isDifferentTab = prevTabId !== null && prevTabId !== tabId;

  // If switching AWAY from a tab that has an active stream, we DON'T clear
  // the streaming state in the store — data stays. We just detach the DOM element.
  if (isDifferentTab) {
    activeStreamEl = null;
    isFirstChunkAfterStreamStart = false;
    restoreInputState();
  }

  activeTabId = tabId;
  store.getOrCreate(tabId);

  // Clear UI
  chatContainer.innerHTML = '';
  activeStreamEl = null;
  isFirstChunkAfterStreamStart = false;

  // Load page context from store (memory) — fetch fresh if switching tabs
  let pageContext = store.getPageContext(tabId);
  if (isDifferentTab || !pageContext) {
    statusEl.textContent = '加载页面...';
    if (pageTitleEl) pageTitleEl.textContent = '正在加载页面内容...';
    if (pageUrlEl) pageUrlEl.textContent = '';
    if (contextBanner) contextBanner.style.borderLeft = '3px solid #666';

    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTENT' });
      if (response && response.content) {
        store.setPageContext(tabId, response.content);
        pageContext = response.content;
      }
    } catch (error) {
      // Page may not be injectable — that's OK
    }
  }

  // Update header UI
  if (pageContext) {
    if (pageTitleEl) pageTitleEl.textContent = pageContext.title || '无标题页面';
    if (pageUrlEl) pageUrlEl.textContent = pageContext.url;
    if (contextBanner) contextBanner.style.borderLeft = '3px solid #4ade80';
    statusEl.textContent = '就绪';
    statusEl.classList.add('ready');
  } else {
    if (pageTitleEl) pageTitleEl.textContent = '无法提取页面内容';
    statusEl.textContent = '页面受限';
  }

  // Render existing conversation from store
  if (store.hasConversation(tabId)) {
    renderConversation(tabId);
  } else if (!apiKeyInput.value.trim()) {
    addPlaceholderMessage('👋 你好！请先在顶部配置你的 AI API，然后就可以开始对话了。');
  }

  // If this tab has a live stream in the store, render it
  const streaming = store.getStreaming(tabId);
  if (streaming && !streaming.done) {
    activeStreamEl = document.createElement('div');
    activeStreamEl.className = 'message assistant streaming';
    const currentFontSize = fontSizeSlider?.value || 12;
    activeStreamEl.style.fontSize = currentFontSize + 'px';
    const content = streaming.content || '';
    if (typeof marked !== 'undefined' && content) {
      activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content)) + '<span class="streaming-cursor">▊</span>';
    } else if (content) {
      activeStreamEl.textContent = content;
    } else {
      activeStreamEl.innerHTML = '<span class="streaming-cursor">▊</span>';
    }
    chatContainer.appendChild(activeStreamEl);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    showLoading(true);
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    statusEl.textContent = '接收中...';
  } else if (streaming && streaming.done) {
    // Stream completed while we were away — finalize it
    store.finalizeStreaming(tabId);
    store.persist(tabId);
    // Re-render to show the finalized message
    chatContainer.innerHTML = '';
    renderConversation(tabId);
  }
}

// =============================================================================
// Config & Provider Logic
// =============================================================================

async function loadConfig() {
  const result = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'customEndpoint', 'searchEngines']);
  if (result.provider) providerSelect.value = result.provider;
  if (result.apiKey) apiKeyInput.value = result.apiKey;
  if (result.model) { }
  if (result.customEndpoint) customEndpointInput.value = result.customEndpoint;

  if (result.searchEngines) {
    enabledSearchEngines = result.searchEngines;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_SEARCH_ENGINES' });
    if (resp && resp.engines) {
      searchEngines = resp.engines;
    }
  } catch (e) {
    console.error('Failed to fetch search engines:', e);
  }

  customEndpointRow.classList.toggle('show', providerSelect.value === 'custom');
  updateModelSelectState();
  showConfig();

  if (result.provider && result.apiKey) {
    fetchModels();
  }
}

async function saveConfig() {
  await chrome.storage.local.set({
    provider: providerSelect.value,
    apiKey: apiKeyInput.value,
    model: modelSelect.value,
    customEndpoint: customEndpointInput.value
  });
}

function updateModelSelectState() {
  const hasProvider = !!providerSelect.value;
  const hasApiKey = !!apiKeyInput.value.trim();
  const isCustom = providerSelect.value === 'custom';

  modelSelect.disabled = !hasProvider || !hasApiKey;

  if (!hasProvider) {
    modelSelect.innerHTML = '<option value="">-- 选择提供商 --</option>';
  } else if (!hasApiKey) {
    modelSelect.innerHTML = '<option value="">-- 填写 API Key --</option>';
  } else if (isCustom) {
    modelSelect.innerHTML = '<option value="">-- 自定义模型名称 --</option>';
  }

  refreshModelsBtn.style.display = hasProvider && hasApiKey && !isCustom ? 'block' : 'none';
}

async function fetchModels() {
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();

  if (!provider || !apiKey) return;
  if (isFetchingModels) return;
  isFetchingModels = true;

  const originalText = refreshModelsBtn.textContent;
  refreshModelsBtn.textContent = '⏳';
  refreshModelsBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_MODELS',
      config: { provider, apiKey, customEndpoint: customEndpointInput.value.trim() }
    });

    if (response.error) throw new Error(response.error);

    modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';

    if (response.models && response.models.length > 0) {
      response.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelSelect.appendChild(option);
      });

      const providerPreset = PROVIDERS[provider];
      if (providerPreset?.defaultModel) {
        const defaultExists = response.models.find(m =>
          m.toLowerCase().includes(providerPreset.defaultModel.toLowerCase())
        );
        if (defaultExists) modelSelect.value = defaultExists;
      }
    } else {
      modelSelect.innerHTML = '<option value="">-- 无法获取，自动填充 --</option>';
    }

    const saved = await chrome.storage.local.get(['model']);
    if (saved.model && modelSelect.querySelector(`option[value="${saved.model}"]`)) {
      modelSelect.value = saved.model;
    }

    statusEl.textContent = '已加载 ' + (response.models?.length || 0) + ' 个模型';
    statusEl.classList.add('ready');
    hideConfig();

  } catch (error) {
    console.error('Error fetching models:', error);
    statusEl.textContent = '获取模型失败';
    statusEl.classList.add('error');
    modelSelect.innerHTML = '<option value="">-- 获取失败 --</option>';
    showConfig();

    setTimeout(() => {
      statusEl.classList.remove('error');
      statusEl.textContent = '就绪';
    }, 2000);
  } finally {
    isFetchingModels = false;
    refreshModelsBtn.textContent = originalText;
    refreshModelsBtn.disabled = false;
  }
}

function showConfig() {
  configToggleRow.classList.add('show');
  toggleConfigBtn.classList.add('active');
}

function hideConfig() {
  configToggleRow.classList.remove('show');
  toggleConfigBtn.classList.remove('active');
}

// =============================================================================
// Page Context & Tools
// =============================================================================

function buildSystemContent() {
  const pageContext = activeTabId ? store.getPageContext(activeTabId) : null;
  let systemContent = 'You are a helpful AI assistant.';
  if (pageContext) {
    systemContent = `You are an AI assistant helping the user understand a webpage.\n\n`;
    systemContent += `Page Title: ${pageContext.title}\n`;
    systemContent += `Page URL: ${pageContext.url}\n\n`;
    systemContent += `Page Content:\n${pageContext.text}\n\n`;

    if (pageContext.subtitles && pageContext.subtitles.raw) {
      const formattedSubtitles = pageContext.subtitles.raw.map(item => {
        const fromSec = item.from || 0;
        const min = Math.floor(fromSec / 60);
        const sec = Math.floor(fromSec % 60);
        const timestamp = `${min}:${sec.toString().padStart(2, '0')}`;
        const text = (item.content || '').replace(/<[^>]+>/g, '').trim();
        return `[${timestamp}] ${text}`;
      }).join('\n');
      systemContent += `=== Subtitles ===\n${formattedSubtitles}\n\n`;
    }

    if (pageContext.comments && pageContext.comments.length > 0) {
      const commentsStr = pageContext.comments
        .map(c => {
          const prefix = c.isReply ? '[Reply] ' : '[Comment] ';
          const userPart = c.user ? c.user + ': ' : '';
          const timePart = c.time ? ` (${c.time})` : '';
          return prefix + userPart + c.text + timePart;
        })
        .join('\n');
      systemContent += `=== Comments ===\n${commentsStr}\n\n`;
    }

    systemContent += `Please answer the user's questions based on this content. Be helpful and concise.

Page highlighting is available through the highlight_page_text tool. When your answer relies on one or more specific statements from the page, call highlight_page_text before giving the final answer. Pass 1-3 short passages (8-160 characters) copied verbatim from Page Content; do not summarize, translate, add labels, quotes, or markdown around them. Prefer a distinctive sentence or clause that appears exactly in Page Content. If the answer does not rely on a specific page statement, do not call it.

You have access to web search tools (up to 3 uses total per response).

Use web search when:
- The user asks you to verify/fact-check information
- The user needs real-time/current information not present in the page content
- The user explicitly asks you to search for something
- You are uncertain about a claim and need to verify it

Available search tools — use ONLY those listed here:`;

    const enabledEntries = Object.entries(searchEngines || {}).filter(([id]) => enabledSearchEngines[id]);
    const disabledEntries = Object.entries(searchEngines || {}).filter(([id]) => !enabledSearchEngines[id]);

    if (enabledEntries.length > 0) {
      for (const [id, eng] of enabledEntries) {
        systemContent += '\n- ' + eng.toolName + ': ' + eng.toolDescription;
      }
    } else {
      systemContent += '\n- No search tools enabled.';
    }

    if (disabledEntries.length > 0) {
      systemContent += '\n\nThe following tools are DISABLED and will return an error if called: ' +
        disabledEntries.map(([id, eng]) => eng.toolName + ' (' + eng.name + ')').join(', ') + '. ' +
        'DO NOT call these — pick from the available tools above instead.';
    }

    systemContent += `

Search results include titles, URLs, and snippets. Use these to provide accurate, up-to-date answers with source citations.

If you run out of searches, answer based on what you already found. If no results were found, state that honestly.`;
  }
  return systemContent;
}

async function refreshPageContext() {
  if (!activeTabId) return false;
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_PAGE_CONTENT' });
    if (response && response.content) {
      store.setPageContext(activeTabId, response.content);
      if (pageTitleEl) pageTitleEl.textContent = response.content.title || '无标题页面';
      if (pageUrlEl) pageUrlEl.textContent = response.content.url;
      if (contextBanner) contextBanner.style.borderLeft = '3px solid #4ade80';
      return true;
    }
  } catch (error) {
    console.error('Error refreshing page context:', error);
  }
  return false;
}

function buildSearchTools() {
  const HIGHLIGHT_PAGE_TEXT_TOOL = {
    type: 'function',
    // Not JavaScript keyword, but OpenAI-compatible API 
    function: {
      name: 'highlight_page_text',
      description: 'Highlight passages from the current webpage that support the answer. Use only exact or near-exact text from the provided page content, maximum 3 passages.',
      parameters: {
        type: 'object',
        properties: {
          passages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short, distinctive passages copied from the current webpage.'
          }
        },
        required: ['passages']
      }
    }
  }

  const SEARCH_TOOL = {
    type: 'function',
    function: {
      name: engine.toolName,
      description: engine.toolDescription,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific and use keywords for best results.'
          }
        },
        required: ['query']
      }
    }
  }

  const tools = [HIGHLIGHT_PAGE_TEXT_TOOL];
  if (!searchEngines) return tools;
  for (const [id, engine] of Object.entries(searchEngines)) {
    if (!enabledSearchEngines[id]) continue;
    tools.push(SEARCH_TOOL);
  }
  return tools;
}

// =============================================================================
// Send / Stop Stream
// =============================================================================

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;
  const customEndpoint = customEndpointInput.value.trim();

  if (!provider) { addMessage('error', '请先选择一个 AI 提供商。'); return; }
  if (!apiKey) { addMessage('error', '请先填写 API Key。'); return; }
  if (!model && provider !== 'custom') { addMessage('error', '请先选择一个模型，或手动输入模型名称。'); return; }

  const userText = text;

  const placeholder = chatContainer.querySelector('.placeholder-message');
  if (placeholder) placeholder.remove();

  addMessage('user', text);
  userInput.value = '';
  store.appendMessage(activeTabId, { role: 'user', content: text });
  await store.persist(activeTabId);

  showLoading(true);
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  statusEl.textContent = '刷新页面内容...';

  try {
    await refreshPageContext();
    statusEl.textContent = '发送中...';

    const systemContent = buildSystemContent();
    lastDebugInfo = { systemContent, userText };

    const messages = [
      { role: 'system', content: systemContent },
      ...store.getConversation(activeTabId)
    ];

    const actualModel = model || (provider === 'custom' ? 'custom-model' : '');
    const config = { provider, apiKey, model: actualModel, customEndpoint };
    const tools = buildSearchTools();

    chrome.runtime.sendMessage({
      type: 'SEND_TO_AI',
      config,
      messages,
      tools,
      senderTabId: activeTabId
    }).catch(error => {
      addMessage('error', `错误: ${error.message}`);
      restoreInputState();
      store.getConversation(activeTabId).pop();
      store.persist(activeTabId);
      statusEl.textContent = '就绪';
    });

  } catch (error) {
    addMessage('error', `错误: ${error.message}`);
    store.getConversation(activeTabId).pop();
    await store.persist(activeTabId);
    statusEl.textContent = '就绪';
  }
}

function stopStream() {
  const streaming = store.getStreaming(activeTabId);
  if (!streaming || !streaming.messageId) return;

  console.log('[POPUP] User requested stop stream for tab:', activeTabId);
  statusEl.textContent = '正在停止...';

  chrome.runtime.sendMessage({
    type: 'STOP_STREAM',
    senderTabId: activeTabId
  }).catch(() => { });

  // Finalize locally
  if (activeStreamEl) {
    const currentFontSize = fontSizeSlider?.value || 12;
    const content = streaming.content || '';
    if (typeof marked !== 'undefined' && content) {
      activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content));
    } else {
      activeStreamEl.textContent = content || '(已停止生成)';
    }
    activeStreamEl.style.fontSize = currentFontSize + 'px';
    activeStreamEl.classList.remove('streaming');
    activeStreamEl = null;
  }

  store.finalizeStreaming(activeTabId);
  store.persist(activeTabId);
  isFirstChunkAfterStreamStart = false;
  restoreInputState();
  statusEl.textContent = '已停止';
}

// =============================================================================
// Initialization (DOMContentLoaded)
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();

  statusEl.textContent = '加载页面...';

  // Get the active content tab (not the extension page itself)
  const currentWindow = await chrome.windows.getLastFocused();
  const resp = await chrome.runtime.sendMessage({
    type: 'GET_ACTIVE_CONTENT_TAB',
    windowId: currentWindow.id
  });
  const initialTabId = resp.tabId;

  if (initialTabId) {
    // Load conversation from storage into store
    await store.load(initialTabId);

    // Fetch page context
    try {
      const response = await chrome.tabs.sendMessage(initialTabId, { type: 'GET_PAGE_CONTENT' });
      if (response && response.content) {
        store.setPageContext(initialTabId, response.content);
        if (pageTitleEl) pageTitleEl.textContent = response.content.title || '无标题页面';
        if (pageUrlEl) pageUrlEl.textContent = response.content.url;
        if (contextBanner) contextBanner.style.borderLeft = '3px solid #4ade80';
        statusEl.textContent = '就绪';
        statusEl.classList.add('ready');
      } else {
        if (pageTitleEl) pageTitleEl.textContent = '无法提取页面内容';
        statusEl.textContent = '页面受限';
      }
    } catch (error) {
      if (pageTitleEl) pageTitleEl.textContent = '无法访问此页面';
      if (pageUrlEl) pageUrlEl.textContent = error.message;
      statusEl.textContent = '页面错误';
    }

    // Set active tab BEFORE rendering (renderConversation uses activeTabId)
    activeTabId = initialTabId;

    if (store.hasConversation(initialTabId)) {
      renderConversation(initialTabId);
      statusEl.textContent = '已恢复对话';
      setTimeout(() => {
        if (statusEl.textContent === '已恢复对话') {
          statusEl.textContent = '就绪';
        }
      }, 2000);
    } else if (!apiKeyInput.value.trim()) {
      addPlaceholderMessage('👋 你好！请先在顶部配置你的 AI API，然后就可以开始对话了。');
    }

    // Reconnect to any active stream (popup closed/reopened mid-stream)
    const streamState = await chrome.runtime.sendMessage({
      type: 'GET_STREAM_STATE',
      senderTabId: initialTabId
    }).catch(() => ({ active: false }));

    if (streamState && streamState.active) {
      console.log('[POPUP] Reconnecting to active stream, messageId:', streamState.messageId, 'content length:', (streamState.content || '').length);
      store.startStreaming(initialTabId, streamState.messageId);
      store.updateStreamContent(initialTabId, streamState.content || '');
      if (streamState.done) {
        store.updateStreamDone(initialTabId, true);
        if (streamState.toolMessages) {
          store.updateStreamToolMessages(initialTabId, streamState.toolMessages);
        }
        store.finalizeStreaming(initialTabId);
        store.persist(initialTabId);
        // Re-render to show finalized message
        chatContainer.innerHTML = '';
        renderConversation(initialTabId);
      } else {
        // Show live content with cursor
        activeStreamEl = document.createElement('div');
        activeStreamEl.className = 'message assistant streaming';
        const currentFontSize = fontSizeSlider?.value || 12;
        activeStreamEl.style.fontSize = currentFontSize + 'px';
        const content = streamState.content || '';
        if (typeof marked !== 'undefined' && content) {
          activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content)) + '<span class="streaming-cursor">▊</span>';
        } else if (content) {
          activeStreamEl.textContent = content;
        } else {
          activeStreamEl.innerHTML = '<span class="streaming-cursor">▊</span>';
        }
        chatContainer.appendChild(activeStreamEl);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        showLoading(true);
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        statusEl.textContent = '接收中...';
      }
    }
  } else {
    activeTabId = initialTabId;
    if (pageTitleEl) pageTitleEl.textContent = '无可用页面';
    statusEl.textContent = '无活动页面';
    if (!apiKeyInput.value.trim()) {
      addPlaceholderMessage('👋 你好！请先在顶部配置你的 AI API，然后就可以开始对话了。');
    }
  }
});

// =============================================================================
// Streaming Message Handling (chrome.runtime.onMessage)
// =============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[POPUP] Received message type:', request.type, 'senderTabId:', request.senderTabId, 'activeTabId:', activeTabId);

  const msgTabId = request.senderTabId;
  const isActive = msgTabId === activeTabId;

  if (request.type === 'STREAM_START') {
    console.log('[POPUP] STREAM_START received, messageId:', request.messageId);

    // Always update store regardless of whether this tab is active
    store.startStreaming(msgTabId, request.messageId);

    if (isActive) {
      // If already have a streaming element (reconnect), skip
      if (activeStreamEl && store.getStreaming(msgTabId)) {
        console.log('[POPUP] STREAM_START skipped - already have streaming element');
        sendResponse({ received: true });
        return true;
      }

      isFirstChunkAfterStreamStart = true;
      activeStreamEl = document.createElement('div');
      activeStreamEl.className = 'message assistant streaming';
      const currentFontSize = fontSizeSlider?.value || 12;
      activeStreamEl.style.fontSize = currentFontSize + 'px';
      activeStreamEl.innerHTML = '<span class="streaming-cursor">▊</span>';
      chatContainer.appendChild(activeStreamEl);
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
    sendResponse({ received: true });
    return true;
  }

  if (request.type === 'STREAM_CHUNK') {
    const content = request.content || '';

    // Always update store — data survives tab switches
    store.updateStreamContent(msgTabId, content);
    if (request.done) {
      store.updateStreamDone(msgTabId, true);
    }
    if (request.toolMessages && request.toolMessages.length > 0) {
      store.updateStreamToolMessages(msgTabId, request.toolMessages);
    }

    if (request.done) {
      // Stream complete — finalize in store regardless
      store.finalizeStreaming(msgTabId);
      store.persist(msgTabId);

      if (isActive) {
        // Finalize DOM
        if (activeStreamEl) {
          const currentFontSize = fontSizeSlider?.value || 12;
          if (typeof marked !== 'undefined' && content) {
            activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content));
          } else {
            activeStreamEl.textContent = content || '(已停止生成)';
          }
          activeStreamEl.style.fontSize = currentFontSize + 'px';
          activeStreamEl.classList.remove('streaming');
          activeStreamEl = null;
        }
        isFirstChunkAfterStreamStart = false;
        restoreInputState();
        statusEl.textContent = request.stopped ? '已停止' : '就绪';
      }
      sendResponse({ received: true });
      return true;
    }

    // In-progress chunk — only update DOM if this is the active tab
    if (isActive) {
      // Auto-reconnect: if we get a chunk but don't have a streaming element
      if (!activeStreamEl) {
        console.log('[POPUP] Auto-reconnecting to stream, messageId:', request.messageId);
        isFirstChunkAfterStreamStart = false;

        activeStreamEl = document.createElement('div');
        activeStreamEl.className = 'message assistant streaming';
        const currentFontSize = fontSizeSlider?.value || 12;
        activeStreamEl.style.fontSize = currentFontSize + 'px';

        if (typeof marked !== 'undefined' && content) {
          activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content)) + '<span class="streaming-cursor">▊</span>';
        } else if (content) {
          activeStreamEl.textContent = content;
        } else {
          activeStreamEl.innerHTML = '<span class="streaming-cursor">▊</span>';
        }
        chatContainer.appendChild(activeStreamEl);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        showLoading(true);
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        sendResponse({ received: true });
        return true;
      }

      // Normal in-progress update
      if (activeStreamEl) {
        const currentFontSize = fontSizeSlider?.value || 12;

        let shouldScrollToBottom;
        if (isFirstChunkAfterStreamStart) {
          shouldScrollToBottom = true;
          isFirstChunkAfterStreamStart = false;
        } else {
          const threshold = 50;
          shouldScrollToBottom = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - threshold;
        }

        if (typeof marked !== 'undefined' && content) {
          activeStreamEl.innerHTML = sanitizeHTML(marked.parse(content)) + '<span class="streaming-cursor">▊</span>';
        } else {
          activeStreamEl.textContent = content;
        }
        activeStreamEl.style.fontSize = currentFontSize + 'px';

        if (shouldScrollToBottom) {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      }
    }
    // else: chunk is for a non-active tab — store already updated, UI will
    // pick it up when user switches back to this tab

    sendResponse({ received: true });
    return true;
  }

  if (request.type === 'STREAM_ERROR') {
    console.log('[POPUP] STREAM_ERROR received:', request.error);

    if (isActive) {
      if (activeStreamEl) {
        const currentFontSize = fontSizeSlider?.value || 12;
        const errorSpan = document.createElement('span');
        errorSpan.className = 'error';
        errorSpan.textContent = `错误: ${request.error || '未知错误'}`;
        activeStreamEl.textContent = '';
        activeStreamEl.appendChild(errorSpan);
        activeStreamEl.style.fontSize = currentFontSize + 'px';
        activeStreamEl.classList.remove('streaming');
        activeStreamEl = null;
      }
      isFirstChunkAfterStreamStart = false;
      store.getConversation(msgTabId).pop(); // Remove failed user message
      store.persist(msgTabId);
      restoreInputState();
      statusEl.textContent = '就绪';
    }
    // Clear streaming state for this tab regardless
    if (store.getStreaming(msgTabId)) {
      store.getConversation(msgTabId).pop();
      store._ensure(msgTabId).streaming = null;
    }

    sendResponse({ received: true });
    return true;
  }
});

// =============================================================================
// Tab Switch Handling (chrome.tabs.onActivated)
// =============================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;

  // Only handle events for this extension page's window
  const currentWindow = await chrome.windows.getLastFocused();
  if (windowId !== currentWindow.id) return;

  // Load from storage if we haven't seen this tab yet
  if (!store.getPageContext(tabId) && !store.hasConversation(tabId)) {
    await store.load(tabId);
  }

  // Switch the view to this tab (data stays in store)
  await switchToTab(tabId);
});

// =============================================================================
// Event Listeners
// =============================================================================

providerSelect.addEventListener('change', async () => {
  customEndpointRow.classList.toggle('show', providerSelect.value === 'custom');
  updateModelSelectState();
  await saveConfig();
  if (providerSelect.value && apiKeyInput.value.trim()) {
    fetchModels();
  }
});

apiKeyInput.addEventListener('change', async () => {
  updateModelSelectState();
  await saveConfig();
  if (providerSelect.value && apiKeyInput.value.trim()) {
    fetchModels();
  }
});

customEndpointInput.addEventListener('change', async () => {
  await saveConfig();
});

modelSelect.addEventListener('change', async () => {
  await saveConfig();
});

refreshModelsBtn.addEventListener('click', () => {
  fetchModels();
});

toggleConfigBtn.addEventListener('click', () => {
  if (configToggleRow.classList.contains('show')) {
    hideConfig();
  } else {
    showConfig();
  }
});

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', stopStream);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const streaming = store.getStreaming(activeTabId);
    if (streaming && streaming.messageId) {
      stopStream();
    } else {
      sendMessage();
    }
  }
});

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
});

// =============================================================================
// Debug Modal
// =============================================================================

const debugModal = document.getElementById('debugModal');
const debugContent = document.getElementById('debugContent');
const debugBtn = document.getElementById('debugBtn');
const debugClose = document.getElementById('debugClose');

function showDebugModal() {
  const fullContext = `=== SYSTEM PROMPT ===\n${lastDebugInfo.systemContent}\n\n=== USER MESSAGE ===\n${lastDebugInfo.userText}`;
  debugContent.textContent = fullContext;
  debugModal.classList.add('active');
}

function hideDebugModal() {
  debugModal.classList.remove('active');
}

debugBtn.addEventListener('click', () => {
  refreshPageContext().then(() => {
    lastDebugInfo.systemContent = buildSystemContent();
    lastDebugInfo.userText = userInput.value.trim() || '(无输入)';
    showDebugModal();
  });
});

debugClose.addEventListener('click', hideDebugModal);

debugModal.addEventListener('click', (e) => {
  if (e.target === debugModal) {
    hideDebugModal();
  }
});

// =============================================================================
// Clear Conversation
// =============================================================================

const clearBtn = document.getElementById('clearBtn');

clearBtn.addEventListener('click', async () => {
  if (!store.hasConversation(activeTabId)) return;

  if (confirm('确定要清空当前对话记录吗？')) {
    store.clearConversation(activeTabId);
    chatContainer.innerHTML = '';
    addMessage('assistant', '对话已清空。');
    await store.removePersisted(activeTabId);
  }
});

// =============================================================================
// Font Size Control
// =============================================================================

const fontSizeSlider = document.getElementById('fontSizeSlider');
const fontSizeValue = document.getElementById('fontSizeValue');

async function loadFontSize() {
  const result = await chrome.storage.local.get(['fontSize']);
  if (result.fontSize) {
    fontSizeSlider.value = result.fontSize;
    fontSizeValue.textContent = result.fontSize;
    applyFontSize(result.fontSize);
  }
}

function applyFontSize(size) {
  document.querySelectorAll('.message').forEach(msg => {
    msg.style.fontSize = size + 'px';
  });
}

fontSizeSlider.addEventListener('input', () => {
  const size = fontSizeSlider.value;
  fontSizeValue.textContent = size;
  applyFontSize(size);
});

fontSizeSlider.addEventListener('change', async () => {
  await chrome.storage.local.set({ fontSize: fontSizeSlider.value });
});

loadFontSize();

// =============================================================================
// Search Engine Toggles
// =============================================================================

function applySearchEngineToggles() {
  document.querySelectorAll('.engine-toggle input[type="checkbox"]').forEach(cb => {
    const engineId = cb.dataset.engine;
    if (engineId && enabledSearchEngines.hasOwnProperty(engineId)) {
      cb.checked = enabledSearchEngines[engineId];
    }
  });
}

async function saveSearchEngineToggles() {
  await chrome.storage.local.set({ searchEngines: enabledSearchEngines });
}

document.querySelectorAll('.engine-toggle input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', async () => {
    const engineId = cb.dataset.engine;
    if (engineId) {
      enabledSearchEngines[engineId] = cb.checked;
      await saveSearchEngineToggles();
      console.log('[POPUP] Search engine', engineId, cb.checked ? 'enabled' : 'disabled');
    }
  });
});

if (searchEngines) {
  applySearchEngineToggles();
} else {
  setTimeout(() => {
    if (searchEngines) applySearchEngineToggles();
  }, 1000);
}
