// Background service worker for API calls - supports multiple LLM providers

// Track last active content tab per window (excludes extension pages)
const lastActiveContentTab = {}; // windowId -> tabId

// Preset provider configurations
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
    name: 'SiliconFlow (硅基流动)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    modelsEndpoint: 'https://api.siliconflow.cn/v1/models',
    modelKey: 'id',
    defaultModel: 'deepseek-ai/DeepSeek-V2.5'
  },
  ollama: {
    name: 'Ollama (本地)',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    modelsEndpoint: 'http://localhost:11434/api/tags',
    modelKey: 'name',
    defaultModel: 'llama3',
    isLocal: true
  },
  custom: {
    name: '自定义 API',
    endpoint: '',
    modelsEndpoint: '',
    modelKey: 'id',
    defaultModel: ''
  }
};

// Handle messages from popup / sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SEND_TO_AI') {
    // For streaming, we don't wait for response - chunks are sent via chrome.runtime.sendMessage
    sendToLLM(request.config, request.messages, request.senderTabId).catch(error => {
      console.error('[DEBUG] sendToLLM error:', error);
      chrome.runtime.sendMessage({
        type: 'STREAM_ERROR',
        error: error.message,
        senderTabId: request.senderTabId
      }).catch(() => {});
    });
    sendResponse({ started: true });
    return true;
  }

  if (request.type === 'FETCH_MODELS') {
    fetchModels(request.config)
      .then(models => sendResponse({ models }))
      .catch(error => sendResponse({ error: error.message, models: [] }));
    return true;
  }

  if (request.type === 'GET_PROVIDERS') {
    sendResponse({ providers: PROVIDERS });
    return true;
  }

  // Return the active content tab for the current window
  if (request.type === 'GET_ACTIVE_CONTENT_TAB') {
    const windowId = request.windowId;

    // First, try to get the currently active tab in this window
    chrome.tabs.query({ active: true, windowId: windowId }, (activeTabs) => {
      if (activeTabs && activeTabs.length > 0) {
        const activeTab = activeTabs[0];
        // If the active tab is a content tab (not extension), use it directly
        if (activeTab.url && !activeTab.url.startsWith('chrome-extension://') && !activeTab.url.startsWith('chrome://')) {
          lastActiveContentTab[windowId] = activeTab.id;
          sendResponse({ tabId: activeTab.id });
          return;
        }
      }

      // Fallback: find the first non-extension tab in this window (e.g., when sidepanel is active)
      chrome.tabs.query({ windowId: windowId }, (tabs) => {
        if (tabs && tabs.length > 0) {
          const targetTab = tabs.find(t =>
            t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://')
          );

          if (targetTab) {
            lastActiveContentTab[windowId] = targetTab.id;
            sendResponse({ tabId: targetTab.id });
          } else {
            sendResponse({ tabId: null });
          }
        } else {
          sendResponse({ tabId: null });
        }
      });
    });
    return true;
  }
});

// Track active content tab, ignoring extension pages (sidepanel, devtools, etc.)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Skip extension pages - we want the actual content tab
    if (tab.url && !tab.url.startsWith('chrome-extension://')) {
      lastActiveContentTab[windowId] = tabId;
    }
  } catch (e) {
    // Tab may not be accessible
  }
});

// Also update on tab URL changes (e.g. navigation within same tab)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const windowId = tab.windowId;
    // If this tab is the currently tracked one, update it
    if (lastActiveContentTab[windowId] === tabId) {
      if (tab.url && !tab.url.startsWith('chrome-extension://')) {
        lastActiveContentTab[windowId] = tabId;
      }
    }
  }
});

async function fetchModels(config) {
  const { provider, apiKey, customEndpoint, customModelsEndpoint } = config;

  if (provider === 'custom') {
    if (!customEndpoint) {
      throw new Error('请填写自定义 API 端点');
    }
    return [];
  }

  const providerConfig = PROVIDERS[provider];
  const endpoint = providerConfig.modelsEndpoint;

  if (!endpoint || !apiKey) {
    return [];
  }

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    // Different APIs have different response structures
    if (provider === 'ollama') {
      return (data.models || []).map(m => m.name || m.model_name);
    }

    const modelKey = providerConfig.modelKey;
    const models = data.data || data.models || [];

    return models
      .filter(m => {
        const id = m[modelKey] || m.id || m.name;
        // Filter out non-chat models for better UX
        return id && !id.includes('embed') && !id.includes('embedding') && !id.includes('tts') && !id.includes('whisper');
      })
      .map(m => m[modelKey] || m.id || m.name);
  } catch (error) {
    console.error('Error fetching models:', error);
    throw error;
  }
}

async function sendToLLM(config, messages, senderTabId) {
  const { provider, apiKey, model, customEndpoint } = config;
  console.log('[DEBUG] sendToLLM called, provider:', provider, 'model:', model);

  if (!apiKey) {
    console.error('[DEBUG] No API key');
    throw new Error('请先填写 API Key');
  }

  if (!model) {
    console.error('[DEBUG] No model');
    throw new Error('请选择模型');
  }

  let endpoint;

  if (provider === 'custom') {
    endpoint = customEndpoint;
    if (!endpoint) {
      console.error('[DEBUG] No custom endpoint');
      throw new Error('请填写自定义 API 端点');
    }
  } else {
    endpoint = PROVIDERS[provider].endpoint;
  }
  console.log('[DEBUG] Endpoint:', endpoint);

  // Build request body for OpenAI-compatible API
  const body = {
    model: model,
    messages: messages,
    stream: true
  };

  // Add max_tokens for providers that require it
  if (provider === 'anthropic') {
    body.max_tokens = 1024;
  }

  console.log('[DEBUG] Sending fetch request...');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  console.log('[DEBUG] Response status:', response.status);

  if (!response.ok) {
    let errorMsg = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error?.message || errorData.message || errorMsg;
    } catch (e) {}
    console.error('[DEBUG] Response not ok:', errorMsg);
    // Send error to popup
    chrome.runtime.sendMessage({
      type: 'STREAM_ERROR',
      error: errorMsg,
      senderTabId
    }).catch(e => console.error('[DEBUG] Failed to send STREAM_ERROR:', e));
    return { error: errorMsg };
  }

  // Handle streaming response
  console.log('[DEBUG] Starting to read stream...');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let messageId = Date.now().toString();

  // Send initial "start" event
  console.log('[DEBUG] Sending STREAM_START, senderTabId:', senderTabId);
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'STREAM_START',
      messageId,
      senderTabId
    }).catch(e => console.error('[DEBUG] Failed to send STREAM_START:', e));
  }, 0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      console.log('[DEBUG] Received chunk, length:', chunk.length, 'data:', chunk.substring(0, 100));
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            console.log('[DEBUG] Received [DONE]');
            // Send final chunk
            setTimeout(() => {
              chrome.runtime.sendMessage({
                type: 'STREAM_CHUNK',
                messageId,
                content: '',
                done: true,
                senderTabId
              }).catch(e => console.error('[DEBUG] Failed to send final STREAM_CHUNK:', e));
            }, 0);
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              fullContent += content;
              console.log('[DEBUG] Sending chunk, fullContent length:', fullContent.length);
              // Send each chunk with setTimeout to allow message delivery during stream
              const chunkContent = fullContent;
              const chunkMessageId = messageId;
              const chunkSenderTabId = senderTabId;
              setTimeout(() => {
                chrome.runtime.sendMessage({
                  type: 'STREAM_CHUNK',
                  messageId: chunkMessageId,
                  content: chunkContent,
                  done: false,
                  senderTabId: chunkSenderTabId
                }).catch(e => console.error('[DEBUG] Failed to send STREAM_CHUNK:', e));
              }, 0);
            }
            // Note: keep using original messageId (timestamp), don't use API's id
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  console.log('[DEBUG] Stream complete, total content length:', fullContent.length);

  return {
    content: fullContent,
    id: messageId
  };
}
