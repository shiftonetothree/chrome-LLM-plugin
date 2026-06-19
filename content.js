// Content script to extract ALL visible webpage text content
(function() {
  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_PAGE_CONTENT') {
      const content = extractPageContent();
      sendResponse({ content });
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

  // ========== Bilibili Comment Extraction ==========

  function extractBilibiliComments() {
    const comments = [];

    // Method 1: Find all comment thread renderers and extract properly
    const threadRenderers = document.querySelectorAll('bili-comment-thread-renderer');

    for (const thread of threadRenderers) {
      if (!thread.shadowRoot) continue;

      // Extract main comment
      const commentRenderer = thread.shadowRoot.querySelector('bili-comment-renderer');
      if (commentRenderer && commentRenderer.shadowRoot) {
        const comment = extractMainComment(commentRenderer);
        if (comment) comments.push(comment);
      }

      // Extract replies
      const repliesRenderer = thread.shadowRoot.querySelector('bili-comment-replies-renderer');
      if (repliesRenderer && repliesRenderer.shadowRoot) {
        const replyRenderers = repliesRenderer.shadowRoot.querySelectorAll('bili-comment-reply-renderer');
        for (const reply of replyRenderers) {
          if (reply.shadowRoot) {
            const replyComment = extractReplyComment(reply);
            if (replyComment) comments.push(replyComment);
          }
        }
      }
    }

    // Method 2: Walk all shadow hosts and look for comment content patterns
    // This catches comments that might be in different component structures
    const allShadowHosts = document.querySelectorAll('*');
    for (const host of allShadowHosts) {
      if (!host.shadowRoot || host.shadowRoot.mode !== 'open') continue;

      // Look for the comment content pattern: #contents inside a rich-text component
      const richTextComponents = host.shadowRoot.querySelectorAll('bili-rich-text');
      for (const richText of richTextComponents) {
        if (!richText.shadowRoot) continue;

        // Get #contents or the actual paragraph content
        const contents = richText.shadowRoot.querySelector('#contents');
        if (contents) {
          const text = contents.textContent?.trim() || '';
          if (text && text.length > 5 && !text.includes('animation') && !text.includes('@font-face')) {
            // Try to find associated user name
            let user = '';
            let time = '';

            // Look for user-info in parent hierarchy
            const parentRoot = richText.getRootNode();
            if (parentRoot) {
              const userInfo = parentRoot.querySelector('#user-name');
              if (userInfo) {
                user = userInfo.textContent?.trim() || '';
              }
              const actions = parentRoot.querySelector('bili-comment-action-buttons-renderer');
              if (actions && actions.shadowRoot) {
                const pubdate = actions.shadowRoot.querySelector('#pubdate');
                if (pubdate) {
                  time = pubdate.textContent?.trim() || '';
                }
              }
            }

            // Avoid duplicates
            const exists = comments.some(c => c.text === text);
            if (!exists) {
              comments.push({ user, text, time, isReply: false });
            }
          }
        }
      }
    }

    return comments;
  }

  // Extract main comment from bili-comment-renderer
  function extractMainComment(renderer) {
    if (!renderer.shadowRoot) return null;

    let user = '';
    let text = '';
    let time = '';

    // User name: #main > #header > bili-comment-user-info > shadowRoot > #user-name > a
    const userInfo = renderer.shadowRoot.querySelector('bili-comment-user-info');
    if (userInfo && userInfo.shadowRoot) {
      const userName = userInfo.shadowRoot.querySelector('#user-name');
      if (userName) {
        user = userName.textContent?.trim() || '';
        // Also check for link inside
        const link = userName.querySelector('a');
        if (link) {
          user = link.textContent?.trim() || user;
        }
      }
    }

    // Comment text: #content > bili-rich-text > shadowRoot > #contents > p
    const contentDiv = renderer.shadowRoot.querySelector('#content');
    if (contentDiv) {
      const richText = contentDiv.querySelector('bili-rich-text');
      if (richText && richText.shadowRoot) {
        // Get #contents specifically
        const contents = richText.shadowRoot.querySelector('#contents');
        if (contents) {
          text = contents.textContent?.trim() || '';
        } else {
          // Fallback: get all text but filter out CSS
          const allText = richText.shadowRoot.textContent || '';
          // Filter out CSS-like content
          text = allText.split(/[{}]/)[0]?.trim() || allText;
          text = text.replace(/@[a-z-]+ \{[^}]*\}/gi, '').trim();
        }
      }
      if (!text) {
        text = contentDiv.textContent?.trim() || '';
      }
    }

    // Time: bili-comment-action-buttons-renderer > shadowRoot > #pubdate
    const actions = renderer.shadowRoot.querySelector('bili-comment-action-buttons-renderer');
    if (actions && actions.shadowRoot) {
      const pubdate = actions.shadowRoot.querySelector('#pubdate');
      if (pubdate) {
        time = pubdate.textContent?.trim() || '';
      }
    }

    // Clean text - remove emoji alt text and excessive whitespace
    if (text) {
      text = text.replace(/\s+/g, ' ').trim();
    }

    if (text && text.length > 2) {
      return { user, text, time, isReply: false };
    }
    return null;
  }

  // Extract reply comment from bili-comment-reply-renderer
  function extractReplyComment(reply) {
    if (!reply.shadowRoot) return null;

    let user = '';
    let text = '';
    let time = '';

    // User name
    const userInfo = reply.shadowRoot.querySelector('bili-comment-user-info');
    if (userInfo && userInfo.shadowRoot) {
      const userName = userInfo.shadowRoot.querySelector('#user-name');
      if (userName) {
        user = userName.textContent?.trim() || '';
        const link = userName.querySelector('a');
        if (link) {
          user = link.textContent?.trim() || user;
        }
      }
    }

    // Reply text
    const richText = reply.shadowRoot.querySelector('bili-rich-text');
    if (richText && richText.shadowRoot) {
      const contents = richText.shadowRoot.querySelector('#contents');
      if (contents) {
        text = contents.textContent?.trim() || '';
      } else {
        text = richText.shadowRoot.textContent?.trim() || '';
      }
    }

    // Time
    const actions = reply.shadowRoot.querySelector('bili-comment-action-buttons-renderer');
    if (actions && actions.shadowRoot) {
      const pubdate = actions.shadowRoot.querySelector('#pubdate');
      if (pubdate) {
        time = pubdate.textContent?.trim() || '';
      }
    }

    if (text) {
      text = text.replace(/\s+/g, ' ').trim();
    }

    if (text && text.length > 2) {
      return { user, text, time, isReply: true };
    }
    return null;
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

  function extractPageContent() {
    const result = {
      title: document.title || '',
      url: window.location.href || '',
      text: '',
      comments: []
    };

    // Check if on Bilibili
    const isBilibili = result.url.includes('bilibili.com');

    // Extract all visible text (generic)
    result.text = extractAllVisibleText();

    // Extract Bilibili comments specifically
    if (isBilibili) {
      const comments = extractBilibiliComments();
      result.comments = comments;

      // Append comments to main text for context
      if (comments.length > 0) {
        const commentsStr = comments
          .map(c => {
            const prefix = c.isReply ? '[回复] ' : '[评论] ';
            const userPart = c.user ? c.user + ': ' : '';
            const timePart = c.time ? ` (${c.time})` : '';
            return prefix + userPart + c.text + timePart;
          })
          .join('\n');

        result.text += '\n\n=== 评论区 (Comments) ===\n' + commentsStr;
      }
    }

    // Limit to avoid token limits
    if (result.text.length > 10000) {
      result.text = result.text.substring(0, 10000) + '\n...[content truncated]';
    }

    return result;
  }

  // Expose function
  window.getPageContent = extractPageContent;
})();
