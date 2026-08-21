(function(global) {
  const STYLE_ID = 'ai-page-highlight-style';
  const MARK_CLASS = 'ai-page-highlight';
  const SKIP_SELECTOR = 'script, style, noscript, textarea, input, select, [contenteditable="true"]';

  function normalizeText(text) {
    return String(text || '')
      .replace(/[“”„‟«»「」『』]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanPassage(text) {
    return String(text || '')
      .replace(/^\s*(?:原文|引用|摘录|passage|quote)\s*[:：]\s*/i, '')
      .replace(/^\s*[`"“”「『]+|[`"“”」』]+\s*$/g, '')
      .replace(/^\s*(?:\.\.\.|……)+\s*|\s*(?:\.\.\.|……)+\s*$/g, '')
      .trim();
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_SELECTOR) || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function clearHighlights(root = document) {
    root.querySelectorAll('.' + MARK_CLASS).forEach(mark => {
      mark.replaceWith(document.createTextNode(mark.textContent));
    });
    root.normalize();
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.' + MARK_CLASS + '{background:#ffeb3b!important;color:inherit!important;border-radius:2px;box-shadow:0 0 0 2px rgba(255,193,7,.25);}' +
      '@media (prefers-reduced-motion:no-preference){.' + MARK_CLASS + '{transition:background-color .2s;}}';
    (document.head || document.documentElement).appendChild(style);
  }

  function buildTextIndex(nodes) {
    let text = '';
    const positions = [];
    let pendingSpace = null;

    nodes.forEach(node => {
      for (let offset = 0; offset < node.nodeValue.length; offset++) {
        const char = node.nodeValue[offset];
        if (/\s/.test(char)) {
          if (text && !text.endsWith(' ') && !pendingSpace) {
            pendingSpace = { node, offset };
          }
          continue;
        }
        if (pendingSpace) {
          text += ' ';
          positions.push(pendingSpace);
          pendingSpace = null;
        }
        text += char;
        positions.push({ node, offset });
      }
    });
    return { text, positions };
  }

  function findPassage(index, passage) {
    const query = normalizeText(passage).toLocaleLowerCase();
    if (query.length < 8) return null;
    const start = index.text.toLocaleLowerCase().indexOf(query);
    if (start >= 0) return { start, end: start + query.length };

    // LLM 往往会带省略号或回答中的前后说明，退化为匹配较长的连续片段。
    const fallback = query.replace(/^([.…]+\s*)|([.…]+\s*)$/g, '').slice(0, 160).trim();
    if (fallback.length >= 12) {
      const fallbackStart = index.text.toLocaleLowerCase().indexOf(fallback);
      if (fallbackStart >= 0) return { start: fallbackStart, end: fallbackStart + fallback.length };
    }
    return null;
  }

  function wrapMatch(nodes, index, match) {
    const first = index.positions[match.start];
    const last = index.positions[Math.max(match.start, match.end - 1)];
    if (!first || !last) return false;

    const startNodeIndex = nodes.indexOf(first.node);
    const endNodeIndex = nodes.indexOf(last.node);
    if (startNodeIndex < 0 || endNodeIndex < 0) return false;

    for (let i = startNodeIndex; i <= endNodeIndex; i++) {
      const node = nodes[i];
      let from = i === startNodeIndex ? first.offset : 0;
      let to = i === endNodeIndex ? last.offset + 1 : node.nodeValue.length;
      if (to <= from || !node.parentNode) continue;
      const selected = node.splitText(from);
      const remainder = selected.splitText(to - from);
      const mark = document.createElement('mark');
      mark.className = MARK_CLASS;
      selected.parentNode.insertBefore(mark, selected);
      mark.appendChild(selected);
      // Keep the reference stable when subsequent nodes are processed.
      nodes[i] = remainder;
    }
    const firstMark = document.querySelector('.' + MARK_CLASS + ':last-of-type') || document.querySelector('.' + MARK_CLASS);
    if (firstMark) firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  function highlightText(passages, options = {}) {
    const wanted = (Array.isArray(passages) ? passages : [passages])
      .map(cleanPassage)
      .map(normalizeText)
      .filter(text => text.length >= (options.minLength || 8));
    if (!wanted.length || !document.body) return { success: false, matches: 0, passages: [] };

    clearHighlights(document);
    ensureStyles();
    let nodes = collectTextNodes(document.body);
    const matched = [];
    const maxMatches = options.maxMatches || 3;

    for (const passage of wanted) {
      if (matched.length >= maxMatches) break;
      // 每次包裹后重新建立索引，避免 splitText 使旧节点引用失效。
      nodes = collectTextNodes(document.body);
      const index = buildTextIndex(nodes);
      const match = findPassage(index, passage);
      if (!match || !wrapMatch(nodes, index, match)) continue;
      matched.push(passage);
    }
    return { success: matched.length > 0, matches: matched.length, passages: matched };
  }

  global.AIPageHighlighter = { normalizeText, collectTextNodes, highlightText, clearHighlights };
})(window);
