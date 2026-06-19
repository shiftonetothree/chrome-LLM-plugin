// Popup script - handles multiple LLM providers
let pageContext = null;
let conversationHistory = [];
let isFetchingModels = false;
let lastDebugInfo = { systemContent: '', userText: '' }; // Store last sent context
let currentTabId = null; // Track current tab for conversation keying

// DOM Elements
const chatContainer = document.getElementById('chatContainer');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const statusEl = document.getElementById('status');
const pageTitleEl = document.getElementById('pageTitle');
const pageUrlEl = document.getElementById('pageUrl');
const loadingIndicator = document.getElementById('loadingIndicator');
const apiKeyInput = document.getElementById('apiKey');
const providerSelect = document.getElementById('providerSelect');
const modelSelect = document.getElementById('modelSelect');
const customEndpointRow = document.getElementById('customEndpointRow');
const customEndpointInput = document.getElementById('customEndpoint');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');

// Provider presets
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    modelKey: 'id',
    defaultModel: 'gpt-4o'
  },
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    modelsEndpoint: 'https://api.deepseek.com/v1/models',
    modelKey: 'id',
    defaultModel: 'deepseek-chat'
  },
  siliconflow: {
    name: 'SiliconFlow',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    modelsEndpoint: 'https://api.siliconflow.cn/v1/models',
    modelKey: 'id',
    defaultModel: 'deepseek-ai/DeepSeek-V2.5'
  },
  ollama: {
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    modelsEndpoint: 'http://localhost:11434/api/tags',
    modelKey: 'name',
    defaultModel: 'llama3'
  },
  custom: {
    name: 'Custom',
    endpoint: '',
    modelsEndpoint: '',
    modelKey: 'id',
    defaultModel: ''
  }
};

// Load saved configuration
async function loadConfig() {
  const result = await chrome.storage.local.get(['provider', 'apiKey', 'model', 'customEndpoint']);
  if (result.provider) providerSelect.value = result.provider;
  if (result.apiKey) apiKeyInput.value = result.apiKey;
  if (result.model) {}
  if (result.customEndpoint) customEndpointInput.value = result.customEndpoint;

  customEndpointRow.classList.toggle('show', providerSelect.value === 'custom');
  updateModelSelectState();

  if (result.provider && result.apiKey) {
    fetchModels();
  }
}

// Save configuration
async function saveConfig() {
  await chrome.storage.local.set({
    provider: providerSelect.value,
    apiKey: apiKeyInput.value,
    model: modelSelect.value,
    customEndpoint: customEndpointInput.value
  });
}

// Update model select state
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

// Fetch models from API
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

  } catch (error) {
    console.error('Error fetching models:', error);
    statusEl.textContent = '获取模型失败';
    statusEl.classList.add('error');
    modelSelect.innerHTML = '<option value="">-- 获取失败，手动输入 --</option>';

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

// Build system content from page context
function buildSystemContent() {
  let systemContent = 'You are a helpful AI assistant.';
  if (pageContext) {
    systemContent = `You are an AI assistant helping the user understand a webpage.\n\n`;
    systemContent += `Page Title: ${pageContext.title}\n`;
    systemContent += `Page URL: ${pageContext.url}\n\n`;
    systemContent += `Page Content:\n${pageContext.text}\n\n`;
    systemContent += `Please answer the user's questions based on this content. Be helpful and concise.`;
  }
  return systemContent;
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();

  statusEl.textContent = '加载页面...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });

    if (response && response.content) {
      pageContext = response.content;
      pageTitleEl.textContent = pageContext.title || '无标题页面';
      pageUrlEl.textContent = pageContext.url;
      document.getElementById('contextBanner').style.borderLeft = '3px solid #4ade80';
      statusEl.textContent = '就绪';
      statusEl.classList.add('ready');
    } else {
      pageContext = null;
      pageTitleEl.textContent = '无法提取页面内容';
      statusEl.textContent = '页面受限';
    }
  } catch (error) {
    pageContext = null;
    pageTitleEl.textContent = '无法访问此页面';
    pageUrlEl.textContent = error.message;
    statusEl.textContent = '页面错误';
  }

  // Load saved conversation for this tab
  const saved = await loadConversation(currentTabId);
  if (saved && saved.history && saved.history.length > 0) {
    conversationHistory = saved.history;
    renderConversation();
    statusEl.textContent = '已恢复对话';
    setTimeout(() => {
      if (statusEl.textContent === '已恢复对话') {
        statusEl.textContent = '就绪';
      }
    }, 2000);
  }
});

// Event listeners for config changes
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

// Fetch fresh page context
async function refreshPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });
    if (response && response.content) {
      pageContext = response.content;
      pageTitleEl.textContent = pageContext.title || '无标题页面';
      pageUrlEl.textContent = pageContext.url;
      document.getElementById('contextBanner').style.borderLeft = '3px solid #4ade80';
      return true;
    }
  } catch (error) {
    console.error('Error refreshing page context:', error);
  }
  return false;
}

// Send message
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;
  const customEndpoint = customEndpointInput.value.trim();

  if (!provider) {
    addMessage('error', '请先选择一个 AI 提供商。');
    return;
  }

  if (!apiKey) {
    addMessage('error', '请先填写 API Key。');
    return;
  }

  if (!model && provider !== 'custom') {
    addMessage('error', '请先选择一个模型，或手动输入模型名称。');
    return;
  }

  // Store for debug
  const userText = text;

  addMessage('user', text);
  userInput.value = '';
  conversationHistory.push({ role: 'user', content: text });
  await saveConversation();

  showLoading(true);
  sendBtn.disabled = true;
  statusEl.textContent = '刷新页面内容...';

  try {
    // Refresh page context before sending
    await refreshPageContext();
    statusEl.textContent = '发送中...';

    // Build system content and store for debug
    const systemContent = buildSystemContent();
    lastDebugInfo = { systemContent, userText };

    const messages = [
      { role: 'system', content: systemContent },
      ...conversationHistory
    ];

    const actualModel = model || (provider === 'custom' ? 'custom-model' : '');
    const config = { provider, apiKey, model: actualModel, customEndpoint };

    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TO_AI',
      config,
      messages
    });

    if (response.error) throw new Error(response.error);

    addMessage('assistant', response.content);
    conversationHistory.push({ role: 'assistant', content: response.content });
    await saveConversation();
    statusEl.textContent = '就绪';

  } catch (error) {
    addMessage('error', `错误: ${error.message}`);
    conversationHistory.pop();
    await saveConversation();
    statusEl.textContent = '就绪';
  } finally {
    showLoading(false);
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// Add message to chat
function addMessage(role, content) {
  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  msg.textContent = content;
  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show/hide loading
function showLoading(show) {
  loadingIndicator.classList.toggle('active', show);
}

// Event listeners
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 100) + 'px';
});

// ============ Conversation Persistence ============

// Get storage key for current tab
function getConversationKey() {
  return `conversation_${currentTabId}`;
}

// Save conversation history to storage
async function saveConversation() {
  if (!currentTabId) return;
  try {
    const key = getConversationKey();
    await chrome.storage.local.set({
      [key]: {
        history: conversationHistory,
        pageContext: pageContext,
        savedAt: Date.now()
      }
    });
  } catch (error) {
    console.error('Error saving conversation:', error);
  }
}

// Load conversation history from storage
async function loadConversation(tabId) {
  try {
    const key = `conversation_${tabId}`;
    const result = await chrome.storage.local.get([key]);
    if (result[key]) {
      return result[key];
    }
  } catch (error) {
    console.error('Error loading conversation:', error);
  }
  return null;
}

// Render existing conversation messages
function renderConversation() {
  conversationHistory.forEach(msg => {
    addMessage(msg.role, msg.content);
  });
}

// ============ Debug Modal ============
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
  // First refresh page context
  refreshPageContext().then(() => {
    // Update with fresh context
    lastDebugInfo.systemContent = buildSystemContent();
    lastDebugInfo.userText = userInput.value.trim() || '(无输入)';
    showDebugModal();
  });
});

debugClose.addEventListener('click', hideDebugModal);

// Close modal when clicking outside content
debugModal.addEventListener('click', (e) => {
  if (e.target === debugModal) {
    hideDebugModal();
  }
});

// ============ Clear Conversation ============
const clearBtn = document.getElementById('clearBtn');

clearBtn.addEventListener('click', async () => {
  if (conversationHistory.length === 0) return;

  if (confirm('确定要清空当前对话记录吗？')) {
    conversationHistory = [];
    chatContainer.innerHTML = '';
    addMessage('assistant', '对话已清空。');
    await chrome.storage.local.remove([getConversationKey()]);
  }
});
