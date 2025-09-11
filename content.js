// Quick Select Tools - Content Script (MV3)
// - Injects UI via Shadow DOM to avoid CSS conflicts
// - Shows an action bubble near current selection with: character count, Translate (🌐), Search (🔎)
// - Translate tries on-device Translator API when available, else falls back to Google Translate in a new tab
// - Search always opens a Google search tab

(() => {
  'use strict';

  // Feature flags
  // If true and the on-device Translator API is available, show the inline translation bubble at the top.
  // If false (default), always open Google Translate in a new tab.
  const ENABLE_INLINE_TRANSLATION = false;
  // Disable any inline-style fallback writes to avoid hostile site patches
  const SAFE_INLINE_FALLBACK = false;

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

  // Safe style applier: hard no-op (never touches el.style nor attributes)
  const cssProp = (k) => k; // unused, keep for compatibility
  const applyStyle = () => {};

  const getDisplay = () => '';

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
    // Create with extra safety against sites that monkey‑patch DOM APIs
    try {
      host = document.createElement('div');
    } catch (_) {
      try {
        host = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      } catch (_) { /* ignore */ }
    }
    if (!host) return; // As a last resort, bail out silently

    host.id = HOST_ID;
    // fixed zero-size host; children use position:fixed
    // Do not touch style attributes directly; inject a document-level style instead
    try {
      const STY_ID = 'qst-host-css';
      if (!document.getElementById(STY_ID)) {
        const sty = document.createElement('style');
        sty.id = STY_ID;
        sty.textContent = '#qst-root-host{position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;pointer-events:none;}';
        (document.head || document.documentElement).appendChild(sty);
      }
    } catch (_) { /* ignore */ }

    const root = document.documentElement || document.body || document.head;
    try { if (root && root.appendChild) root.appendChild(host); } catch (_) { return; }
  }
  const shadow = (host && typeof host.attachShadow === 'function') ? host.attachShadow({ mode: 'open' }) : host;

  // Load styles into Shadow DOM (robust against page CSP):
  // 1) adoptedStyleSheets (preferred), 2) <style> with text, 3) <link rel="stylesheet"> as last resort.
  (async () => {
    const url = chrome.runtime.getURL('content.css');
    let cssText = '';
    try {
      cssText = await fetch(url).then((r) => r.text());
    } catch (_) {}

    // Try adoptedStyleSheets
    try {
      if ('adoptedStyleSheets' in Document.prototype || 'adoptedStyleSheets' in ShadowRoot.prototype) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        shadow.adoptedStyleSheets = (shadow.adoptedStyleSheets || []).concat(sheet);
        return;
      }
    } catch (_) { /* fall through */ }

    // Fallback: inline <style>
    if (cssText) {
      try {
        const style = document.createElement('style');
        style.textContent = cssText;
        shadow.appendChild(style);
        return;
      } catch (_) { /* fall through */ }
    }

    // Last resort: linked stylesheet (may be blocked by CSP)
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      shadow.appendChild(link);
    } catch (_) { /* give up */ }
  })();

  // Elements (inside shadow)
  const actionBubble = document.createElement('div');
  actionBubble.className = 'qst-action-bubble';
  applyStyle(actionBubble, {
    position: 'fixed',
    display: 'none',
    pointerEvents: 'auto', // re-enable for bubble
    // Inline base styles to guarantee capsule even if CSS fails to load
    background: '#f0ffff',
    color: '#000',
    padding: '6px 10px',
    borderRadius: '9999px',
    border: '1px solid #f0ffff',
    boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
    alignItems: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
  });

  const translationBubble = document.createElement('div');
  translationBubble.className = 'qst-translation-bubble';
  applyStyle(translationBubble, {
    position: 'fixed',
    display: 'none',
    pointerEvents: 'auto',
  });

  shadow.appendChild(actionBubble);
  shadow.appendChild(translationBubble);

  // Dynamic CSS inside shadow to avoid touching element.style or @style attributes
  const dynStyle = document.createElement('style');
  shadow.appendChild(dynStyle);
  const dyn = {
    action: { left: '0px', top: '0px', display: 'none' },
    tb: { left: '50%', top: '12px', transform: 'translateX(-50%)', display: 'none' },
    loadingDisplay: 'none'
  };
  const refreshDyn = () => {
    dynStyle.textContent = `
      .qst-action-bubble{position:fixed;pointer-events:auto;left:${dyn.action.left};top:${dyn.action.top};display:${dyn.action.display};}
      .qst-translation-bubble{position:fixed;left:${dyn.tb.left};top:${dyn.tb.top};transform:${dyn.tb.transform};display:${dyn.tb.display};}
      .qst-tb-loading{display:${dyn.loadingDisplay};}
    `;
  };
  refreshDyn();

  // Build action bubble content
  const countEl = document.createElement('span');
  countEl.className = 'qst-count';
  // Inline fallback
  applyStyle(countEl, { color: '#000', fontSize: '12px', fontWeight: '500' });

  const translateBtn = document.createElement('button');
  translateBtn.className = 'qst-btn qst-badge';
  translateBtn.type = 'button';
  translateBtn.title = 'Google翻訳';
  translateBtn.setAttribute('aria-label', 'Translate to Japanese');
  translateBtn.setAttribute('role', 'button');
  translateBtn.textContent = 'A⇄あ';
  // Inline fallback to avoid native button look
  applyStyle(translateBtn, {
    minWidth: '24px',
    minHeight: '24px',
    padding: '2px 8px',
    border: 'none',
    borderRadius: '4px',
    margin: '0',
    background: 'transparent',
    color: 'inherit',
    fontSize: '14px',
    fontWeight: '400',
    lineHeight: '20px',
    appearance: 'none',
    WebkitAppearance: 'none',
    boxShadow: 'none',
    cursor: 'pointer',
  });

  const searchBtn = document.createElement('button');
  searchBtn.className = 'qst-btn';
  searchBtn.type = 'button';
  searchBtn.title = 'Google検索';
  searchBtn.setAttribute('aria-label', 'Google検索');
  searchBtn.textContent = '🔎';
  applyStyle(searchBtn, {
    minWidth: '24px',
    minHeight: '24px',
    padding: '2px 3px',
    border: 'none',
    borderRadius: '4px',
    margin: '0',
    background: 'transparent',
    color: 'inherit',
    fontSize: '16px',
    lineHeight: '20px',
    appearance: 'none',
    WebkitAppearance: 'none',
    boxShadow: 'none',
    cursor: 'pointer',
  });

  const sep1 = document.createElement('span');
  sep1.className = 'qst-sep qst-sep1';
  // Inline fallback styles so separator is visible even if CSS fails
  applyStyle(sep1, {
    width: '1px',
    alignSelf: 'stretch',
    marginTop: '4px',
    marginBottom: '4px',
    marginLeft: '2px',
    marginRight: '0px',
    background: '#4682b4',
    borderRadius: '1px',
    display: 'block'
  });
  const sep2 = document.createElement('span');
  sep2.className = 'qst-sep qst-sep2';
  applyStyle(sep2, {
    width: '1px',
    alignSelf: 'stretch',
    marginTop: '4px',
    marginBottom: '4px',
    marginLeft: '0px',
    marginRight: '0px',
    background: '#4682b4',
    borderRadius: '1px',
    display: 'block'
  });
  actionBubble.appendChild(countEl);
  actionBubble.appendChild(sep1);
  actionBubble.appendChild(translateBtn);
  actionBubble.appendChild(sep2);
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
    countEl.textContent = len > 5000 ? '5000+字' : `${len}字`;
    // Position with small offset; clamp into viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    const approxW = 140; // rough width
    const approxH = 40;  // rough height
    const bx = clamp(x + 8, pad, vw - approxW - pad);
    const by = clamp(y + 8, pad, vh - approxH - pad);
    dyn.action.left = `${bx}px`;
    dyn.action.top = `${by}px`;
    dyn.action.display = 'flex';
    refreshDyn();
  };
  const hideActionBubble = () => {
    dyn.action.display = 'none';
    refreshDyn();
  };

  // Translation bubble control
  const openTranslationBubble = () => {
    dyn.tb.left = '50%';
    dyn.tb.top = '12px';
    dyn.tb.transform = 'translateX(-50%)';
    dyn.tb.display = 'block';
    dyn.loadingDisplay = 'flex';
    refreshDyn();
    tbText.textContent = '';
  };
  const closeTranslationBubble = () => {
    dyn.tb.display = 'none';
    tbText.textContent = '';
    dyn.loadingDisplay = 'none';
    refreshDyn();
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
      if (getDisplay(translationBubble) !== 'none') closeTranslationBubble();
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
  const activateTranslate = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const text = lastSelection.text || '';
    if (!text) {
      hideActionBubble();
      return;
    }
    // Decide whether inline translation is allowed (feature-flagged and environment-supported)
    const inlineAllowed = ENABLE_INLINE_TRANSLATION && !isCrossOriginFrame() && hasOnDeviceTranslator();
    if (!inlineAllowed) {
      // Unified behavior: open Google Translate in a new tab
      openGoogleTranslate(text);
      hideActionBubble();
      return;
    }

    // Inline translation path (only when feature is enabled and API is available)
    if (inlineAllowed) {
      openTranslationBubble();
      applyStyle(tbLoading, { display: 'flex' });
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
        applyStyle(tbLoading, { display: 'none' });
      }
    }
  };

  translateBtn.addEventListener('click', activateTranslate);
  translateBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      // Ensure Space doesn't scroll
      ev.preventDefault();
      activateTranslate(ev);
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
