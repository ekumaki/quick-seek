// Quick Select Tools - Content Script (MV3)
// - Injects UI via Shadow DOM to avoid CSS conflicts
// - Shows an action bubble near current selection with: character count, Translate (🌐), Search (🔎)
// - Translate tries on-device Translator API when available, else falls back to Google Translate in a new tab
// - Search always opens a Google search tab

(() => {
  'use strict';

  // Guard: do nothing on restricted pages (defensive; Chrome also blocks content_scripts there)
  const isRestrictedPage = () => {
    const p = location.protocol;
    const h = location.hostname;
    if (p === 'chrome:' || p === 'chrome-extension:') return true;
    // Chrome Web Store
    if (h === 'chrome.google.com') return true;
    return false;
  };
  if (isRestrictedPage()) return;

  // Cross-origin frame detection (used to decide Translator fallback)
  const isCrossOriginFrame = () => {
    if (window.top === window) return false;
    try {
      // Accessing top.document throws if cross-origin
      // eslint-disable-next-line no-unused-expressions
      void window.top.document;
      return false; // same-origin iframe
    } catch (_) {
      return true; // cross-origin iframe
    }
  };

  // Unicode codepoint length
  const codePointLength = (str) => Array.from(str).length;

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  // Selected text state we keep in-memory only (privacy)
  let lastSelection = {
    text: '',
    rect: null, // DOMRect
    ts: 0,
  };

  // Root Shadow DOM host for all UI
  const HOST_ID = 'qst-root-host';
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    // fixed zero-size host; children use position:fixed
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    // Make sure host never interferes with page layout
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);
  }
  const shadow = host.attachShadow({ mode: 'open' });

  // Load styles into Shadow DOM from content.css
  (async () => {
    try {
      const url = chrome.runtime.getURL('content.css');
      const cssText = await fetch(url).then((r) => r.text());
      const style = document.createElement('style');
      style.textContent = cssText;
      shadow.appendChild(style);
    } catch (err) {
      // Silent failure; UI still renders with minimal inline styles
    }
  })();

  // Elements (inside shadow)
  const actionBubble = document.createElement('div');
  actionBubble.className = 'qst-action-bubble';
  actionBubble.style.position = 'fixed';
  actionBubble.style.display = 'none';
  actionBubble.style.pointerEvents = 'auto'; // re-enable for bubble

  const translationBubble = document.createElement('div');
  translationBubble.className = 'qst-translation-bubble';
  translationBubble.style.position = 'fixed';
  translationBubble.style.display = 'none';
  translationBubble.style.pointerEvents = 'auto';

  shadow.appendChild(actionBubble);
  shadow.appendChild(translationBubble);

  // Build action bubble content
  const countEl = document.createElement('span');
  countEl.className = 'qst-count';

  const translateBtn = document.createElement('button');
  translateBtn.className = 'qst-btn';
  translateBtn.type = 'button';
  translateBtn.title = '翻訳 (日本語)';
  translateBtn.setAttribute('aria-label', '翻訳 (日本語)');
  translateBtn.textContent = '🌐';

  const searchBtn = document.createElement('button');
  searchBtn.className = 'qst-btn';
  searchBtn.type = 'button';
  searchBtn.title = 'Google検索';
  searchBtn.setAttribute('aria-label', 'Google検索');
  searchBtn.textContent = '🔎';

  actionBubble.appendChild(countEl);
  actionBubble.appendChild(translateBtn);
  actionBubble.appendChild(searchBtn);

  // Build translation bubble structure
  const tbHeader = document.createElement('div');
  tbHeader.className = 'qst-tb-header';
  const tbTitle = document.createElement('div');
  tbTitle.className = 'qst-tb-title';
  tbTitle.textContent = '翻訳 (→ 日本語)';
  const tbClose = document.createElement('button');
  tbClose.className = 'qst-tb-close';
  tbClose.type = 'button';
  tbClose.setAttribute('aria-label', '閉じる');
  tbClose.textContent = '×';
  tbHeader.appendChild(tbTitle);
  tbHeader.appendChild(tbClose);

  const tbBody = document.createElement('div');
  tbBody.className = 'qst-tb-body';

  const tbLoading = document.createElement('div');
  tbLoading.className = 'qst-tb-loading';
  tbLoading.textContent = '読み込み中…';

  const tbText = document.createElement('div');
  tbText.className = 'qst-tb-text';

  tbBody.appendChild(tbLoading);
  tbBody.appendChild(tbText);

  translationBubble.appendChild(tbHeader);
  translationBubble.appendChild(tbBody);

  // Utility to show/hide action bubble at a screen position
  const showActionBubble = (x, y, text) => {
    const len = codePointLength(text);
    countEl.textContent = len > 5000 ? '5,000+' : String(len);
    // Position with small offset; clamp into viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    const approxW = 140; // rough width
    const approxH = 40;  // rough height
    const bx = clamp(x + 8, pad, vw - approxW - pad);
    const by = clamp(y + 8, pad, vh - approxH - pad);
    actionBubble.style.left = `${bx}px`;
    actionBubble.style.top = `${by}px`;
    actionBubble.style.display = 'flex';
  };
  const hideActionBubble = () => {
    actionBubble.style.display = 'none';
  };

  // Translation bubble control
  const openTranslationBubble = () => {
    translationBubble.style.left = '50%';
    translationBubble.style.top = '12px';
    translationBubble.style.transform = 'translateX(-50%)';
    translationBubble.style.display = 'block';
    tbLoading.style.display = 'flex';
    tbText.textContent = '';
  };
  const closeTranslationBubble = () => {
    translationBubble.style.display = 'none';
    tbText.textContent = '';
    tbLoading.style.display = 'none';
  };

  tbClose.addEventListener('click', (e) => {
    e.preventDefault();
    closeTranslationBubble();
  });

  // Outside click handling for closing bubbles
  const onDocMouseDown = (ev) => {
    const path = ev.composedPath ? ev.composedPath() : [];
    if (!path.includes(actionBubble) && !path.includes(translationBubble)) {
      hideActionBubble();
      if (translationBubble.style.display !== 'none') closeTranslationBubble();
    }
  };
  document.addEventListener('mousedown', onDocMouseDown, true);

  // ESC handling
  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') {
      hideActionBubble();
      closeTranslationBubble();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  // Scroll handling: hide action bubble to avoid jitter; leave translation bubble
  const onScroll = () => hideActionBubble();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Selection handling
  let selectTimer = null;
  const SELECTION_DELAY_MS = 150;

  const getSelectionInfo = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().replace(/^\s+|\s+$/g, '');
    if (!text) return null;
    let range;
    try {
      range = sel.getRangeAt(0).cloneRange();
    } catch (_) {
      return null;
    }
    let rect = range.getBoundingClientRect();
    // Fallback to first client rect if bounding rect is empty
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const rects = range.getClientRects();
      if (rects && rects.length > 0) rect = rects[rects.length - 1];
    }
    if (!rect) return null;
    return { text, rect };
  };

  const onSelectionChange = () => {
    if (selectTimer) clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const info = getSelectionInfo();
      if (!info) {
        hideActionBubble();
        return;
      }
      lastSelection.text = info.text;
      lastSelection.rect = info.rect;
      lastSelection.ts = Date.now();
      // Place bubble near lower-right corner of selection rect
      showActionBubble(info.rect.right, info.rect.bottom, info.text);
    }, SELECTION_DELAY_MS);
  };

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mouseup', onSelectionChange, true);

  // Open new tab helpers (no tab permission required)
  const openGoogleSearch = (text) => {
    const url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
  };
  const openGoogleTranslate = (text) => {
    const url = `https://translate.google.com/?sl=auto&tl=ja&text=${encodeURIComponent(text)}&op=translate`;
    window.open(url, '_blank', 'noopener');
  };

  // Translator adapter (best-effort, safe feature detection)
  const hasOnDeviceTranslator = () => {
    try {
      const t = (self).translation;
      return !!(t && (typeof t.createTranslator === 'function' || typeof t.canTranslate === 'function'));
    } catch (_) {
      return false;
    }
  };

  const tryCreateTranslator = async () => {
    const t = (self).translation;
    if (!t) throw new Error('translation API missing');
    // Try a few option shapes to be resilient across potential API variants
    const candidates = [
      { sourceLanguage: 'auto', targetLanguage: 'ja', format: 'plaintext' },
      { sourceLanguage: 'auto', targetLanguage: 'ja', format: 'text' },
      { source: 'auto', target: 'ja', format: 'text' }
    ];
    let lastErr = null;
    for (const opts of candidates) {
      try {
        const tr = await t.createTranslator(opts);
        if (tr) return tr;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('createTranslator failed');
  };

  const translateOnDevice = async (text, onPartial) => {
    const tr = await tryCreateTranslator();
    try {
      // Streaming support if available
      if (typeof tr.translateStreaming === 'function') {
        const stream = await tr.translateStreaming(text);
        const reader = stream.getReader();
        let acc = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            acc += value;
            if (onPartial) onPartial(acc);
          }
        }
        return acc;
      }
      // Non-streaming translate()
      if (typeof tr.translate === 'function') {
        const result = await tr.translate(text);
        if (onPartial) onPartial(result);
        return result;
      }
      throw new Error('No translate method');
    } finally {
      // Best-effort cleanup if API provides a destroy/close
      try { if (typeof tr.destroy === 'function') tr.destroy(); } catch (_) {}
      try { if (typeof tr.close === 'function') tr.close(); } catch (_) {}
    }
  };

  // Actions
  translateBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const text = lastSelection.text || '';
    if (!text) {
      hideActionBubble();
      return;
    }

    const cross = isCrossOriginFrame();
    if (cross) {
      // Fallback for cross-origin iframes
      openGoogleTranslate(text);
      hideActionBubble();
      return;
    }

    // Try on-device translator
    if (hasOnDeviceTranslator()) {
      openTranslationBubble();
      tbLoading.style.display = 'flex';
      tbText.textContent = '';
      hideActionBubble();
      try {
        const finalText = await translateOnDevice(text, (partial) => {
          // Progressive render
          tbText.textContent = partial;
        });
        tbText.textContent = finalText || '';
      } catch (err) {
        // On any failure, gracefully fallback to Google Translate
        closeTranslationBubble();
        openGoogleTranslate(text);
      } finally {
        tbLoading.style.display = 'none';
      }
    } else {
      // No API: fallback
      openGoogleTranslate(text);
      hideActionBubble();
    }
  });

  searchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = lastSelection.text || '';
    if (!text) {
      hideActionBubble();
      return;
    }
    openGoogleSearch(text);
    hideActionBubble();
  });
})();

