# AI Browser Assistant

一个 Chrome/Edge 浏览器插件，点击后可以与 AI 大语言模型对话，并自动将当前网页内容作为上下文。

## 🌐 浏览器兼容性

| 浏览器 | 状态 | 说明 |
|--------|------|------|
| Chrome | ✅ 完全支持 | 推荐使用 |
| Edge (Chromium) | ✅ 完全支持 | 直接安装，无需修改 |
| 其他 Chromium 浏览器 | ✅ 应该支持 | 如 Brave, Opera 等 |

## ✨ 功能特性

- 🤖 支持多种 LLM 提供商（OpenAI、DeepSeek、硅基流动、Ollama 等）
- 📄 自动提取当前网页的标题和内容作为上下文
- 🔄 填入 API Token 后自动获取模型列表
- 💬 支持多轮对话
- 💾 配置信息本地安全存储

## 🤖 支持的模型提供商

| 提供商 | 状态 | 模型示例 |
|--------|------|----------|
| **OpenAI** | ✅ 直接使用 | GPT-4o, GPT-4-turbo, GPT-3.5-turbo |
| **DeepSeek** | ✅ 直接使用 | deepseek-chat, deepseek-coder |
| **SiliconFlow (硅基流动)** | ✅ 直接使用 | DeepSeek-V2.5, Qwen, Yi |
| **Ollama (本地)** | ✅ 直接使用 | llama3, mistral, qwen |
| **自定义 API** | ✅ OpenAI 兼容格式 | 任何支持 OpenAI API 格式的服务 |

### 填入 Token 后自动获取模型列表

1. 选择提供商
2. 填写 API Key
3. 插件会自动获取该 API 账户下可用的模型列表
4. 从下拉菜单中选择要使用的模型

## 安装步骤

### Chrome 浏览器

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角的 **"开发者模式"**
3. 点击 **"加载已解压的扩展程序"**
4. 选择 `ai-browser` 文件夹

### Edge 浏览器 (Chromium)

1. 打开 Edge，进入 `edge://extensions/`
2. 开启左下角的 **"开发者模式"**
3. 点击 **"加载已解压的扩展程序"**
4. 选择 `ai-browser` 文件夹

> ⚠️ Edge 基于 Chromium 内核，Chrome 扩展基本完全兼容，无需修改任何代码。

## 使用方法

### 首次配置

1. 点击浏览器工具栏中的插件图标
2. 在顶部配置区域：
   - **Provider**: 选择你的 AI 服务提供商
   - **API Key**: 填入你的 API Token
3. 插件会自动获取可用模型列表
4. **Model**: 从下拉菜单中选择要使用的模型

### 开始对话

1. 插件会自动获取当前页面的内容作为上下文
2. 在底部输入框中输入你的问题
3. 按 Enter 或点击发送按钮

## 获取 API Key

### OpenAI
1. 访问 [OpenAI Platform](https://platform.openai.com/)
2. 注册/登录后进入 API Keys 页面
3. 创建新的 API Key

### DeepSeek
1. 访问 [DeepSeek Platform](https://platform.deepseek.com/)
2. 注册/登录后获取 API Key

### SiliconFlow (硅基流动)
1. 访问 [SiliconFlow](https://www.siliconflow.cn/)
2. 注册后获取 API Key（免费额度）

### Ollama (本地)
1. 安装 [Ollama](https://ollama.ai/)
2. 运行 `ollama serve`
3. 无需 API Key，选择 Ollama 提供商即可

## 自定义 API

如果你使用的是其他 OpenAI 兼容格式的 API：

1. 选择 **Provider** → **自定义 API**
2. 填写 **API Key**（如果需要）
3. 填写 **API 端点**，例如：
   - `https://your-custom-api.com/v1/chat/completions`
4. 在 **Model** 中手动输入模型名称

## 文件结构

```
ai-browser/
├── manifest.json      # 插件配置文件 (Manifest V3)
├── popup.html         # 弹出窗口界面
├── popup.js          # 弹出窗口逻辑
├── background.js     # 后台服务（API 调用）
├── content.js        # 内容脚本（提取页面内容）
├── icons/            # 图标文件
└── README.md         # 说明文档
```

## 技术说明

- **Manifest V3**: 使用最新的 Chrome 扩展 API
- **多提供商支持**: OpenAI 兼容格式 API
- **自动模型获取**: 支持各平台的标准 models API
- **本地存储**: 配置信息存储在 chrome.storage.local 中

## 注意事项

- 需要有效的 API Key 才能使用（Ollama 本地部署除外）
- 部分特殊页面（如 `chrome://` 或 `edge://` 页面）可能无法提取内容
- 页面内容会被截断至约 8000 字符以避免超出 token 限制
- 使用前请确保 API Key 有足够的额度
