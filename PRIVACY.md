# Privacy Policy

**AI Browser Assistant** operates locally on your device and does not collect, store, or transmit any user data on its own servers.

## Data Access

This extension accesses the following on your device:

- **Current webpage content**: The extension extracts the title, URL, and visible text content of the webpage you are viewing to provide context for AI conversations. For Bilibili pages, it also extracts comment content.
- **User input**: Any text you type into the extension's chat interface.

## Data Transmission

**You control where data is sent.**

This extension transmits the following data to an **AI API endpoint of your choosing**:

- The current webpage's title, URL, and text content
- Your chat messages
- Your conversation history (for context)

The supported API providers are:
- OpenAI (api.openai.com)
- DeepSeek (api.deepseek.com)
- SiliconFlow (api.siliconflow.cn)
- Ollama (localhost:11434, for local AI)
- Custom API endpoints you configure

**You must provide your own API key.** This extension does not include or manage API keys — they are stored exclusively in your browser's local storage and are transmitted directly to your chosen API provider.

The extension also fetches available model lists from your configured API provider to enable model selection.

## Data Storage

This extension stores the following data **locally in your browser** (chrome.storage.local):

- Your selected API provider and API key
- Your selected model
- Your custom API endpoint (if configured)
- Conversation history per tab (to preserve your chat across page reloads)
- UI preferences (such as font size)

**None of this data is transmitted to any external server by this extension.**

## Third-Party Services

This extension relies entirely on third-party AI API services configured by you. Your use of those services (including their data collection practices) is governed by the privacy policies of those respective service providers.

## Permissions

- `storage`: Store your configuration and conversation history locally
- `sidePanel`: Enable the side panel interface
- Host permissions (`https://*/`, `http://*/`): Required to extract content from and communicate with the webpages you visit, as well as to reach your configured API endpoints

## Changes

If this privacy policy changes, the updated version will be posted with an updated version number in the Chrome Web Store listing.
