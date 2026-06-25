// Content script to extract ALL visible webpage text content
(function() {
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
    return true;
  });

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

  // ========== Generic Content Extraction ==========

  function extractAllVisibleText() {
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

    // Check if on Bilibili
    const isBilibili = result.url.includes('bilibili.com');

    // Extract all visible text (generic)
    result.text = extractAllVisibleText();

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
