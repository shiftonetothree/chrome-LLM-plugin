// Background service worker for API calls - supports multiple LLM providers

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

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SEND_TO_AI') {
    sendToLLM(request.config, request.messages)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
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

async function sendToLLM(config, messages) {
  const { provider, apiKey, model, customEndpoint } = config;

  if (!apiKey) {
    throw new Error('请先填写 API Key');
  }

  if (!model) {
    throw new Error('请选择模型');
  }

  let endpoint;

  if (provider === 'custom') {
    endpoint = customEndpoint;
    if (!endpoint) {
      throw new Error('请填写自定义 API 端点');
    }
  } else {
    endpoint = PROVIDERS[provider].endpoint;
  }

  // Build request body for OpenAI-compatible API
  const body = {
    model: model,
    messages: messages,
    stream: false
  };

  // Add max_tokens for providers that require it
  if (provider === 'anthropic') {
    body.max_tokens = 1024;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    let errorMsg = `API error: ${response.status}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error?.message || errorData.message || errorMsg;
    } catch (e) {}
    throw new Error(errorMsg);
  }

  const data = await response.json();

  // Parse response - OpenAI compatible format
  if (data.choices && data.choices[0]?.message?.content) {
    return {
      content: data.choices[0].message.content,
      id: data.id || Date.now().toString()
    };
  }

  throw new Error('无法解析 API 响应');
}
