// Content script to extract ALL visible webpage text content
(function () {
  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_PAGE_CONTENT') {
      // extractPageContent is async, so we need to handle it properly
      extractPageContent().then(content => {
        sendResponse({ content });
      }).catch(error => {
        console.error('[AI Browser] Error extracting page content:', error);
        sendResponse({ content: null, error: error.message });
      });
      return true; // Keep message channel open for async response
    }

    if (request.type === 'GET_CLICKED_ELEMENT_TEXT') {
      const result = getClickedElementText();
      sendResponse(result);
      return true;
    }

    /* 
      When LLM decide use Highlightor, the background script will send a message to content script to highlight the text.
    */
    if (request.type === 'HIGHLIGHT_PAGE_TEXT') {
      const result = window.AIPageHighlighter
        ? window.AIPageHighlighter.highlightText(request.passages, request.options)
        : { success: false, matches: 0, passages: [] };
      sendResponse(result);
      return true;
    }

    if (request.type === 'CLEAR_PAGE_HIGHLIGHTS') {
      if (window.AIPageHighlighter) window.AIPageHighlighter.clearHighlights();
      sendResponse({ success: true });
      return true;
    }

    if (request.type === 'INSERT_TRANSLATION_PLACEHOLDER') {
      const placeholderId = insertTranslationPlaceholder();
      sendResponse({ placeholderId });
      return true;
    }

    if (request.type === 'UPDATE_TRANSLATION') {
      updateTranslationContent(request.placeholderId, request.translatedText, request.error);
      sendResponse({ success: true });
      return true;
    }

    if (request.type === 'EXTRACT_BING_RESULTS') {
      const results = extractBingSearchResults();
      sendResponse({ results });
      return true;
    }

    if (request.type === 'EXTRACT_GOOGLE_RESULTS') {
      const results = extractGoogleSearchResults();
      sendResponse({ results });
      return true;
    }

    if (request.type === 'EXTRACT_BAIDU_RESULTS') {
      const results = extractBaiduSearchResults();
      sendResponse({ results });
      return true;
    }

    if (request.type === 'EXTRACT_WIKIPEDIA_RESULTS') {
      const results = extractWikipediaSearchResults();
      sendResponse({ results });
      return true;
    }

    return true;
  });

  // ========== Bing Search Result Extraction ==========

  function extractBingSearchResults() {
    const results = [];

    // Bing search result selectors (Bing's structure as of 2024-2026)
    // Main search results are in <li class="b_algo"> elements
    const algoItems = document.querySelectorAll('li.b_algo');

    algoItems.forEach((item, index) => {
      // Title and link are in the h2 > a element
      const titleEl = item.querySelector('h2 a, h2');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const url = titleEl && titleEl.href ? titleEl.href : '';

      // Description/snippet is in various possible elements
      let snippet = '';
      const snippetEl = item.querySelector('.b_caption p, .b_lineclamp2, .b_algoSlug, p');
      if (snippetEl) {
        snippet = snippetEl.textContent.trim();
      }

      // If no snippet found, try getting any text content excluding the title
      if (!snippet) {
        const clone = item.cloneNode(true);
        const h2 = clone.querySelector('h2');
        if (h2) h2.remove();
        snippet = clone.textContent.trim().substring(0, 500);
      }

      if (title && url) {
        results.push({
          index: index + 1,
          title: title,
          url: url,
          snippet: snippet
        });
      }
    });

    // If no b_algo items found, try alternative selectors
    if (results.length === 0) {
      // Try the newer Bing result structure
      const resultElements = document.querySelectorAll('#b_results .b_algo, #b_results > li');
      resultElements.forEach((item, index) => {
        const titleEl = item.querySelector('h2 a, a[href] h2');
        if (!titleEl) return;
        const title = titleEl.textContent.trim();
        const url = titleEl.href || titleEl.closest('a')?.href || '';
        const snippetEl = item.querySelector('.b_caption p, p');
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';

        if (title) {
          results.push({
            index: index + 1,
            title: title,
            url: url,
            snippet: snippet
          });
        }
      });
    }

    // Also check for news/answer cards at the top
    const answerCards = document.querySelectorAll('.b_ans, .b_entity, .b_rich');
    answerCards.forEach((card, index) => {
      const titleEl = card.querySelector('h2, h3, .b_entityTitle');
      const textEl = card.querySelector('.b_factrow, p, .b_paractl');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const text = textEl ? textEl.textContent.trim().substring(0, 500) : '';

      if (title || text) {
        results.unshift({
          index: 0,
          title: title || 'Featured Result',
          url: window.location.href,
          snippet: text || title
        });
      }
    });

    console.log('[AI Browser] Extracted', results.length, 'Bing search results');
    return results.slice(0, 10); // Limit to top 10 results
  }

  // ========== Google Search Result Extraction ==========

  function extractGoogleSearchResults() {
    const results = [];

    // Google's SERP DOM structure (2024-2026)
    // Main organic results are in various div wrappers
    // Try multiple selectors to handle A/B testing variants

    // Primary selector: div.g (traditional Google result wrapper)
    let resultElements = document.querySelectorAll('div.g');

    // If no results, try alternative selectors
    if (resultElements.length === 0) {
      resultElements = document.querySelectorAll('div#search .g, div.MjjYud, div[data-sokoban-container]');
    }

    // If still no results, try the newer structure
    if (resultElements.length === 0) {
      resultElements = document.querySelectorAll('#search div[data-hveid]');
    }

    // Check for CAPTCHA / bot detection
    const captchaEl = document.querySelector('form#captcha-form, div#recaptcha, div.g-recaptcha');
    if (captchaEl) {
      console.log('[AI Browser] Google CAPTCHA detected');
      return [{ index: 0, title: 'Google CAPTCHA Detected', url: '', snippet: 'Google requires CAPTCHA verification. Please try Bing or another search engine instead.' }];
    }

    resultElements.forEach((item, index) => {
      // Skip items that are too small or likely non-result elements
      const rect = item.getBoundingClientRect();
      if (rect.height < 20) return;

      // Try to find the title link (h3 element)
      const titleEl = item.querySelector('h3');
      const linkEl = titleEl ? titleEl.closest('a') : item.querySelector('a[href]');
      const title = titleEl ? titleEl.textContent.trim() : '';
      let url = '';

      if (linkEl && linkEl.href) {
        // Google wraps URLs in /url?q=... redirects
        const href = linkEl.href;
        if (href.includes('/url?') && href.includes('&q=')) {
          // Extract the actual URL from the redirect
          const qMatch = href.match(/[?&]q=([^&]+)/);
          if (qMatch) {
            url = decodeURIComponent(qMatch[1]);
          }
        } else if (href.includes('/url?q=')) {
          const qMatch = href.match(/\/url\?q=([^&]+)/);
          if (qMatch) {
            url = decodeURIComponent(qMatch[1]);
          }
        }
        // Fallback: use the raw href if it doesn't look like a redirect
        if (!url && !href.startsWith('/url?')) {
          url = href;
        }
      }

      // Find the snippet
      let snippet = '';
      const snippetEls = item.querySelectorAll('div.VwiC3b, span.aCOpRe, div[data-sncf], span.st, div.IsZvec');
      for (const el of snippetEls) {
        const t = el.textContent.trim();
        if (t.length > 10) {
          snippet = t;
          break;
        }
      }
      // Fallback snippet extraction
      if (!snippet) {
        const allText = item.textContent.trim();
        if (title && allText.startsWith(title)) {
          snippet = allText.substring(title.length).trim().substring(0, 500);
        }
      }

      if (title) {
        results.push({
          index: results.length + 1,
          title: title,
          url: url || ('https://www.google.com/search?q=' + encodeURIComponent(title)),
          snippet: snippet
        });
      }
    });

    // Check for featured snippets / knowledge panels / answer boxes
    const featuredSelectors = [
      'div.ifM9O',           // Featured snippet
      'div[data-attrid]',    // Knowledge panel
      'div.kp-wholepage',    // Knowledge graph
      'div.hsjuVe',          // Answer box
      'div.g.kno-kp',        // Knowledge panel card
      'div.g.kno-fb-ctx'     // Knowledge panel context
    ];
    for (const sel of featuredSelectors) {
      const featured = document.querySelector(sel);
      if (featured) {
        const titleEl = featured.querySelector('h2, h3, [data-attrid="title"]');
        const textEl = featured.querySelector('span, div[data-attrid]');
        const title = titleEl ? titleEl.textContent.trim().substring(0, 200) : 'Featured Result';
        const text = textEl ? textEl.textContent.trim().substring(0, 500) : '';
        if (text && !results.some(r => r.snippet === text)) {
          results.unshift({
            index: 0,
            title: title || 'Featured Result',
            url: window.location.href,
            snippet: text || title
          });
        }
        break;
      }
    }

    console.log('[AI Browser] Extracted', results.length, 'Google search results');
    return results.slice(0, 10);
  }

  // ========== Baidu Search Result Extraction ==========

  function extractBaiduSearchResults() {
    const results = [];

    // Baidu's SERP DOM structure (2024-2026)
    // Primary: div.result.c-container
    // Alternative: #content_left .result

    let resultElements = document.querySelectorAll('div.result.c-container');

    if (resultElements.length === 0) {
      resultElements = document.querySelectorAll('#content_left .result, #content_left > div.result');
    }

    if (resultElements.length === 0) {
      resultElements = document.querySelectorAll('.c-container');
    }

    resultElements.forEach((item, index) => {
      // Filter out ad results (Baidu ads use specific attributes)
      if (item.hasAttribute('ec-wise') || item.hasAttribute('data-ec-wise')) return;
      if (item.querySelector('[ec-wise]')) return;
      // Check for ad markers in the class
      if (item.className && (item.className.includes('ec_') || item.className.includes('fw_bg'))) return;

      // Title: h3 > a, or .t > a
      const titleEl = item.querySelector('h3 a, h3, .t a');
      const title = titleEl ? titleEl.textContent.trim() : '';

      // URL: from the link or display URL element
      let url = '';
      const linkEl = item.querySelector('h3 a[href], .t a[href]');
      if (linkEl && linkEl.href && !linkEl.href.startsWith('javascript:')) {
        url = linkEl.href;
      }
      // Fallback: Baidu sometimes shows the URL in a separate element
      if (!url) {
        const urlEl = item.querySelector('.c-showurl, .c-showurl span, .f13');
        if (urlEl) {
          const rawUrl = urlEl.textContent.trim();
          if (rawUrl) {
            url = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;
          }
        }
      }

      // Snippet: .c-abstract, .c-span-last, or general text
      let snippet = '';
      const snippetEls = item.querySelectorAll('.c-abstract, .c-span-last, .content-right_8Zs40, .c-row');
      for (const el of snippetEls) {
        const t = el.textContent.trim();
        if (t.length > 5) {
          snippet = t;
          break;
        }
      }

      // Fallback: try getting text from the result excluding the title area
      if (!snippet) {
        const clone = item.cloneNode(true);
        const h3 = clone.querySelector('h3');
        if (h3) h3.remove();
        const tDiv = clone.querySelector('.t');
        if (tDiv) tDiv.remove();
        snippet = clone.textContent.trim().substring(0, 500);
      }

      if (title) {
        results.push({
          index: results.length + 1,
          title: title,
          url: url || ('https://www.baidu.com/s?wd=' + encodeURIComponent(title)),
          snippet: snippet
        });
      }
    });

    console.log('[AI Browser] Extracted', results.length, 'Baidu search results');
    return results.slice(0, 10);
  }

  // ========== Wikipedia Search Result Extraction ==========

  function extractWikipediaSearchResults() {
    const results = [];

    // Wikipedia search results page DOM structure
    // Primary: li.mw-search-result
    // The search results page is at /w/index.php?search=QUERY

    // Check if we're on a search results page
    const searchResults = document.querySelectorAll('li.mw-search-result');

    if (searchResults.length > 0) {
      searchResults.forEach((item, index) => {
        const headingEl = item.querySelector('.mw-search-result-heading a');
        const title = headingEl ? headingEl.textContent.trim() : '';
        let url = '';
        if (headingEl && headingEl.href) {
          // Make sure URL is absolute
          if (headingEl.href.startsWith('/')) {
            url = 'https://en.wikipedia.org' + headingEl.href;
          } else {
            url = headingEl.href;
          }
        }

        const snippetEl = item.querySelector('.searchresult');
        const snippet = snippetEl ? snippetEl.textContent.trim() : '';

        if (title) {
          results.push({
            index: results.length + 1,
            title: title,
            url: url || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'))),
            snippet: snippet
          });
        }
      });
    }

    // Check if we landed directly on an article (not search results page)
    if (results.length === 0 && document.querySelector('#content, #mw-content-text')) {
      // We might have been redirected to the article directly
      const titleEl = document.querySelector('#firstHeading, h1#firstHeading');
      const title = titleEl ? titleEl.textContent.trim() : document.title.replace(' - Wikipedia', '').trim();

      if (title) {
        // Extract the first paragraph as the snippet
        const introPs = document.querySelectorAll('#mw-content-text .mw-parser-output > p:not(.mw-empty-elt)');
        let snippet = '';
        for (const p of introPs) {
          const text = p.textContent.trim();
          if (text.length > 20) {
            snippet = text.substring(0, 500);
            break;
          }
        }

        results.push({
          index: 0,
          title: title,
          url: window.location.href,
          snippet: snippet || 'Wikipedia article about "' + title + '"'
        });
      }
    }

    console.log('[AI Browser] Extracted', results.length, 'Wikipedia search results');
    return results.slice(0, 10);
  }

  // ========== Deep Shadow DOM Text Extraction ==========

  // Get text content from an element, handling nested Shadow DOM
  // IMPORTANT: Skip style/script content inside shadow roots
  function getDeepText(element, options = {}) {
    if (!element) return '';

    const { skipStyle = true } = options;

    // If it's a text node, return its content
    if (element.nodeType === Node.TEXT_NODE) {
      return element.textContent || '';
    }

    // If it's a style or script element inside shadow DOM, skip it
    if (element.nodeType === Node.ELEMENT_NODE) {
      const tag = element.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK') {
        return '';
      }
    }

    // If it has a shadow root, traverse into it
    if (element.shadowRoot && element.shadowRoot.mode === 'open') {
      let shadowText = '';
      for (const child of element.shadowRoot.childNodes) {
        shadowText += getDeepText(child, options);
      }
      return shadowText;
    }

    // Otherwise recurse into children
    let text = '';
    if (element.childNodes) {
      for (const child of element.childNodes) {
        text += getDeepText(child, options);
      }
    }
    return text;
  }

  // ========== Bilibili AI Subtitle Extraction ==========

  // Extract bvid from URL
  function extractBvidFromUrl(url) {
    const match = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
  }

  // Get video info (including cid) from Bilibili API
  async function getVideoInfo(bvid) {
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include', // Include cookies from the page context
      });

      if (!response.ok) {
        console.error('[AI Browser] Failed to get video info:', response.status);
        return null;
      }

      const data = await response.json();
      if (data.code === 0 && data.data) {
        return data.data;
      }
      console.error('[AI Browser] Video info API error:', data.message);
      return null;
    } catch (error) {
      console.error('[AI Browser] Error getting video info:', error);
      return null;
    }
  }

  // Get subtitle info from Bilibili player API
  async function getSubtitleInfo(bvid, cid) {
    // Try the Wbi API endpoint
    const apiUrl = `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&isGaiaAvoided=false`;

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include', // Include cookies from the page context
      });

      if (!response.ok) {
        console.error('[AI Browser] Failed to get subtitle info:', response.status);
        return null;
      }

      const data = await response.json();
      if (data.code === 0 && data.data) {
        return data.data.subtitle;
      }
      console.error('[AI Browser] Subtitle info API error:', data.message);
      return null;
    } catch (error) {
      console.error('[AI Browser] Error getting subtitle info:', error);
      return null;
    }
  }

  // Download and parse subtitle content
  async function downloadSubtitle(subtitleUrl) {
    // Handle relative URLs
    if (subtitleUrl.startsWith('//')) {
      subtitleUrl = 'https:' + subtitleUrl;
    }

    try {
      const response = await fetch(subtitleUrl, {
        method: 'GET',
      });

      if (!response.ok) {
        console.error('[AI Browser] Failed to download subtitle:', response.status);
        return null;
      }

      const data = await response.json();
      // Subtitle body is in data.body array
      const body = data.body || [];

      if (body.length === 0) {
        console.log('[AI Browser] Subtitle body is empty');
        return null;
      }

      return body;
    } catch (error) {
      console.error('[AI Browser] Error downloading subtitle:', error);
      return null;
    }
  }

  // Main function to extract Bilibili AI subtitles
  async function extractBilibiliSubtitle() {
    const url = window.location.href;

    // Extract bvid from URL
    const bvid = extractBvidFromUrl(url);
    if (!bvid) {
      console.log('[AI Browser] Could not extract bvid from URL:', url);
      return null;
    }
    console.log('[AI Browser] Extracted bvid:', bvid);

    // Get video info to find cid
    const videoInfo = await getVideoInfo(bvid);
    if (!videoInfo) {
      console.error('[AI Browser] Could not get video info');
      return null;
    }

    // Get first cid (for multi-part videos, get the current part)
    const pages = videoInfo.pages || [];
    let cid = videoInfo.cid;

    // If URL has p parameter, try to find the matching cid
    const pMatch = url.match(/[?&]p=(\d+)/);
    if (pMatch && pages.length > 0) {
      const targetPage = parseInt(pMatch[1], 10) - 1;
      if (pages[targetPage]) {
        cid = pages[targetPage].cid;
      }
    } else if (pages.length > 0) {
      cid = pages[0].cid;
    }

    if (!cid) {
      console.error('[AI Browser] Could not find cid');
      return null;
    }
    console.log('[AI Browser] Using cid:', cid);

    // Get subtitle info from player API
    const subtitleInfo = await getSubtitleInfo(bvid, cid);
    if (!subtitleInfo) {
      console.log('[AI Browser] No subtitle info returned');
      return null;
    }

    // Look for any available subtitle (prefer AI subtitles, fall back to first subtitle)
    const subtitles = subtitleInfo.subtitles || [];
    let targetSubtitle = null;

    // Prefer AI subtitle (lan === 'ai-zh')
    for (const sub of subtitles) {
      if (sub.lan === 'ai-zh' && sub.subtitle_url) {
        targetSubtitle = sub;
        break;
      }
    }

    // Fallback: use the first available subtitle
    if (!targetSubtitle && subtitles.length > 0 && subtitles[0].subtitle_url) {
      targetSubtitle = subtitles[0];
    }

    // Fallback: check if ai_subtitle exists directly (some API versions)
    if (!targetSubtitle && subtitleInfo.ai_subtitle && subtitleInfo.ai_subtitle.subtitle_url) {
      targetSubtitle = subtitleInfo.ai_subtitle;
    }

    if (!targetSubtitle || !targetSubtitle.subtitle_url) {
      console.log('[AI Browser] No subtitle available for this video');
      return null;
    }

    console.log('[AI Browser] Found subtitle URL:', targetSubtitle.subtitle_url, '(', targetSubtitle.lan_doc || targetSubtitle.lan, ')');

    // Download and parse subtitle
    const subtitleBody = await downloadSubtitle(targetSubtitle.subtitle_url);
    if (!subtitleBody || subtitleBody.length === 0) {
      console.error('[AI Browser] Failed to download subtitle content');
      return null;
    }

    console.log('[AI Browser] Extracted', subtitleBody.length, 'subtitle lines');

    return {
      raw: subtitleBody,
      count: subtitleBody.length
    };
  }

  // ========== Bilibili Comment Extraction ==========

  // Fetch comments from Bilibili reply API
  async function fetchBilibiliComments(aid) {
    if (!aid) {
      console.log('[AI Browser] Could not get aid for comments');
      return null;
    }

    const wts = Math.floor(Date.now() / 1000);
    const apiUrl = `https://api.bilibili.com/x/v2/reply/wbi/main?oid=${aid}&type=1&mode=3&pagination_str=%7B%22offset%22:%22%22%7D&plat=1`;

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        console.error('[AI Browser] Failed to fetch comments:', response.status);
        return null;
      }

      const data = await response.json();
      if (data.code !== 0 || !data.data) {
        console.error('[AI Browser] Comment API error:', data.message);
        return null;
      }

      return data.data;
    } catch (error) {
      console.error('[AI Browser] Error fetching comments:', error);
      return null;
    }
  }

  // Parse comment item to extract user, text, time
  function parseCommentItem(item) {
    const user = item.member?.uname || '';
    const text = item.content?.message || '';
    const ctime = item.ctime ? new Date(item.ctime * 1000).toLocaleString('zh-CN') : '';

    return {
      user,
      text,
      time: ctime,
      like: item.like || 0,
      isReply: item.root !== 0
    };
  }

  // Extract Bilibili comments via API
  async function extractBilibiliComments() {
    const url = window.location.href;
    const bvid = extractBvidFromUrl(url);
    if (!bvid) {
      console.log('[AI Browser] Could not extract bvid from URL:', url);
      return [];
    }

    // Get video info to get aid
    const videoInfo = await getVideoInfo(bvid);
    if (!videoInfo || !videoInfo.aid) {
      console.log('[AI Browser] Could not get video info or aid');
      return [];
    }

    const aid = videoInfo.aid;
    console.log('[AI Browser] Got aid:', aid);

    const data = await fetchBilibiliComments(aid);
    if (!data || !data.replies) {
      console.log('[AI Browser] No comments returned');
      return [];
    }

    const comments = [];

    // Process main comments and their replies
    for (const reply of data.replies) {
      if (reply.member && reply.content) {
        comments.push(parseCommentItem(reply));

        // Process nested replies
        if (reply.replies && Array.isArray(reply.replies)) {
          for (const nestedReply of reply.replies) {
            if (nestedReply.member && nestedReply.content) {
              comments.push(parseCommentItem(nestedReply));
            }
          }
        }
      }
    }

    console.log('[AI Browser] Extracted', comments.length, 'comments');
    return comments;
  }

  // ========== Immersive Translation ==========

  // State for translation tracking
  let translationStyleElement = null;
  let rightClickedElement = null; // Track right-clicked element for context menu
  let translationIdCounter = 0; // Unique ID for each translation block

  // Track right-clicked element for context menu translation
  document.addEventListener('contextmenu', function (e) {
    rightClickedElement = e.target;
  }, true);

  // Find the nearest block-level text-containing ancestor
  function findNearestBlockElement(el) {
    const BLOCK_TAGS = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION',
      'DD', 'DT', 'PRE', 'DIV', 'ARTICLE', 'SECTION',
      'MAIN', 'ASIDE', 'SUMMARY', 'DETAILS'
    ]);

    // First try: walk up to find a block-level tag with enough text
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (BLOCK_TAGS.has(current.tagName)) {
        const text = current.textContent.trim();
        if (text.length >= 5) {
          return current;
        }
      }
      current = current.parentElement;
    }

    // Fallback: return the original target if nothing better found
    return el;
  }

  // Get text from the right-clicked element's nearest block ancestor
  function getClickedElementText() {
    if (!rightClickedElement) {
      return { text: '' };
    }

    const blockEl = findNearestBlockElement(rightClickedElement);
    if (!blockEl) {
      return { text: '' };
    }

    // Store for later insertion (overwrite previous)
    rightClickedElement = blockEl;

    const text = blockEl.textContent.trim();
    console.log('[AI Browser] Right-clicked element text:', text.substring(0, 100) + '...');
    return { text: text };
  }

  // Insert a loading placeholder after the right-clicked element (returns placeholderId)
  function insertTranslationPlaceholder() {
    if (!rightClickedElement || !rightClickedElement.isConnected) return -1;

    injectTranslationStyles();

    const originalEl = rightClickedElement;
    const id = ++translationIdCounter;

    // Remove any existing translation block right after this element
    const nextSibling = originalEl.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('ai-translation-block')) {
      nextSibling.remove();
    }

    const translationBlock = document.createElement('div');
    translationBlock.className = 'ai-translation-block ai-translation-loading';
    translationBlock.dataset.aiTransId = id;
    translationBlock.innerHTML =
      '<div class="ai-translation-header">' +
      '<span class="ai-translation-label">🌐 中文翻译</span>' +
      '<button class="ai-translation-delete-btn">✕ 删除</button>' +
      '</div>' +
      '<div class="ai-translation-content">' +
      '<span class="ai-loading-spinner"></span> 翻译中，请稍候...' +
      '</div>';

    const deleteBtn = translationBlock.querySelector('.ai-translation-delete-btn');
    if (deleteBtn) deleteBtn.dataset.aiTransId = id;
    originalEl.insertAdjacentElement('afterend', translationBlock);
    console.log('[AI Browser] Inserted translation placeholder, id:', id);
    return id;
  }

  // Update a translation placeholder with real content (or error state)
  // Supports streaming: removes loading spinner on first update, appends text progressively
  function updateTranslationContent(placeholderId, translatedText, isError) {
    const block = document.querySelector('.ai-translation-block[data-ai-trans-id="' + placeholderId + '"]');
    if (!block) return;

    const contentEl = block.querySelector('.ai-translation-content');
    if (!contentEl) return;

    if (isError || !translatedText || !translatedText.trim()) {
      // Show error state only on explicit error
      if (isError) {
        block.classList.remove('ai-translation-loading');
        contentEl.textContent = '⚠️ 翻译失败，请重试';
        contentEl.style.color = '#c0392b';
      }
    } else {
      // Remove loading spinner on first text chunk (streaming)
      block.classList.remove('ai-translation-loading');
      // Use textContent for streaming — fast and safe (no HTML injection)
      contentEl.textContent = translatedText;
    }

    console.log('[AI Browser] Updated translation, id:', placeholderId, 'error:', !!isError, 'length:', (translatedText || '').length);
  }

  // Event delegation for delete button clicks on translation blocks
  document.addEventListener('click', function (e) {
    const deleteBtn = e.target.closest('.ai-translation-delete-btn');
    if (!deleteBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const translationBlock = deleteBtn.closest('.ai-translation-block');
    if (translationBlock) {
      translationBlock.style.transition = 'opacity 0.2s, max-height 0.3s';
      translationBlock.style.opacity = '0';
      translationBlock.style.maxHeight = '0';
      translationBlock.style.margin = '0';
      translationBlock.style.padding = '0';
      translationBlock.style.overflow = 'hidden';
      setTimeout(() => {
        translationBlock.remove();
        console.log('[AI Browser] Removed translation block');
      }, 300);
    }
  }, true);

  // Inject CSS styles for translation blocks
  function injectTranslationStyles() {
    if (translationStyleElement) return;
    translationStyleElement = document.createElement('style');
    translationStyleElement.id = 'ai-immersive-translation-styles';
    translationStyleElement.textContent = `
      .ai-translation-block {
        display: block;
        margin: 4px 0 14px 0;
        padding: 10px 14px;
        background: linear-gradient(135deg, #f0f7ff 0%, #f5f0ff 100%);
        border-left: 3px solid #6b8fd4;
        border-radius: 0 6px 6px 0;
        font-size: 0.92em;
        line-height: 1.7;
        color: #444;
        transition: opacity 0.2s, max-height 0.3s, margin 0.3s, padding 0.3s;
      }
      .ai-translation-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 5px;
      }
      .ai-translation-block .ai-translation-label {
        font-size: 0.7em;
        color: #6b8fd4;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .ai-translation-delete-btn {
        padding: 2px 8px;
        background: transparent;
        border: 1px solid #ccc;
        border-radius: 3px;
        color: #999;
        font-size: 0.7em;
        cursor: pointer;
        transition: all 0.15s;
        line-height: 1.4;
      }
      .ai-translation-delete-btn:hover {
        background: #e74c3c;
        border-color: #e74c3c;
        color: white;
      }
      .ai-translation-block .ai-translation-content {
        display: block;
      }
      .ai-loading-spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid #c8d6e5;
        border-top-color: #6b8fd4;
        border-radius: 50%;
        animation: ai-spin 0.7s linear infinite;
        vertical-align: middle;
        margin-right: 6px;
      }
      @keyframes ai-spin {
        to { transform: rotate(360deg); }
      }
      .ai-translation-loading .ai-translation-content {
        color: #888;
        font-style: italic;
      }
    `;
    document.head.appendChild(translationStyleElement);
  }

  // HTML escape utility
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function tryExtractMarkdown() {
    if (typeof TurndownService !== 'function' || !document.body) {
      return null;
    }

    try {
      const turndownService = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced'
      });

      const clone = document.body.cloneNode(true);

      clone.querySelectorAll(
        'script, style, noscript, iframe'
      ).forEach(element => element.remove());

      const markdown = turndownService.turndown(clone)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return markdown || null;
    } catch (error) {
      console.debug(
        '[AI Browser] Turndown 转换失败，将使用原有纯文本提取:',
        error
      );
      return null;
    }
  }


  // Walk the DOM and find translatable paragraph-level elements
  // ========== Generic Content Extraction ==========

  function extractAllVisibleText() {
    /* 
      Let's try to extract markdown first
      However The total length of Markdown extraction 
      is Far long than the plain text extraction.
      TODO Also Need to filter Sensitive information like password
    */
    const markdown = tryExtractMarkdown();

    if (markdown) {
      return markdown;
    }

    // If extracting markdown failed, try to extract plain text
    const texts = [];

    // Method 1: body.innerText (most websites work with this)
    if (document.body) {
      const bodyText = document.body.innerText || document.body.textContent || '';
      if (bodyText.trim()) {
        texts.push(bodyText.trim());
      }
    }

    // Method 2: Walk all elements with shadow roots (skipping styles)
    const shadowHosts = document.querySelectorAll('*');
    for (const host of shadowHosts) {
      if (host.shadowRoot && host.shadowRoot.mode === 'open') {
        // Skip style elements - getDeepText already does this
        const shadowText = getDeepText(host.shadowRoot, { skipStyle: true });
        if (shadowText.trim()) {
          // Filter out content that looks like CSS
          const lines = shadowText.split('\n');
          const cleanLines = lines.filter(line => {
            const trimmed = line.trim();
            // Skip lines that look like CSS
            if (trimmed.startsWith(':host') || trimmed.startsWith('@font-face') ||
              trimmed.startsWith('@keyframes') || trimmed.startsWith('.layer') ||
              trimmed.startsWith('#canvas') || trimmed.startsWith('animation') ||
              trimmed.includes('display:') || trimmed.includes('position:') ||
              trimmed.includes('width:') || trimmed.includes('height:') ||
              trimmed.startsWith('/*') || trimmed.startsWith('*')) {
              return false;
            }
            return trimmed.length > 0;
          });
          if (cleanLines.length > 0) {
            texts.push(cleanLines.join('\n'));
          }
        }
      }
    }

    // Combine and clean up
    let combined = texts.join('\n\n');

    // Final cleanup - remove CSS-like blocks
    combined = combined
      .replace(/@[a-z-]+\s*\{[^}]*\}/gi, '')
      .replace(/\/\*[^*]*\*+\//g, '')
      .replace(/\s*\{\s*[^}]*\s*\}\s*/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .replace(/\t+/g, ' ')
      .trim();

    return combined;
  }

  async function extractPageContent() {
    const result = {
      title: document.title || '',
      url: window.location.href || '',
      text: '',
      comments: [],
      subtitles: null
    };

    // Extract all visible text (generic) 
    result.text = extractAllVisibleText();

    // Check if on Bilibili
    const isBilibili = result.url.includes('bilibili.com');

    // Extract Bilibili comments (returned separately, not appended to text)
    if (isBilibili) {
      const comments = await extractBilibiliComments();
      result.comments = comments;

      // Extract Bilibili subtitles
      const subtitleData = await extractBilibiliSubtitle();
      if (subtitleData) {
        result.subtitles = subtitleData;
        console.log('[AI Browser] Extracted', subtitleData.count, 'subtitles');
      }
    }

    const lengthLimit = 1000 * 500;

    // Limit to avoid token limits
    if (result.text.length > lengthLimit) {
      result.text = result.text.substring(0, lengthLimit) + '\n...[content truncated]';
    }

    return result;
  }

  // Expose function
  window.getPageContent = extractPageContent;
})();
