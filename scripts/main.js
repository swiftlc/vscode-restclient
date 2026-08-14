// @ts-check
'use strict';

(function () {

  // ---- state for JSON search / raw-extracted toggle ----
  var originalCodeHTML = '';   // initial <code> innerHTML, restored when search is emptied
  var rawParsed = null;        // parsed JSON of #raw-body, null when not a JSON response
  var extractedParsed = null;  // parsed JSON of #extracted-body (jsonpath result), null when none
  var showingAlt = false;      // toggle state: true = showing the alt (raw full) view

  function getCode() {
    return document.getElementById('response-code');
  }

  function bindFolding() {
    var code = getCode();
    if (!code) { return; }
    var childs = Array.prototype.slice.call(code.childNodes);
    childs
      .filter(function (n) { return n.nodeType === 1 && n.hasAttribute('range-start'); })
      .forEach(function (n) { n.addEventListener('click', toggleLines); });
  }

  function onLoad() {
    bindFolding();
    initSearch();
  }

  // ---- recursive JSON filter (ported from whistle.http-handle chrome-plugin) ----
  // mode: 'key' | 'value' | 'mixed'
  function filterJsonRecursive(data, regex, mode) {
    if (typeof data !== 'object' || data === null) {
      if (mode !== 'key' && regex.test(String(data))) {
        return data;
      }
      return undefined;
    }
    if (Array.isArray(data)) {
      var filtered = data
        .map(function (item) { return filterJsonRecursive(item, regex, mode); })
        .filter(function (v) { return v !== undefined; });
      return filtered.length > 0 ? filtered : undefined;
    }
    var result = {};
    var hasMatch = false;
    for (var key in data) {
      if (mode !== 'value' && regex.test(key)) {
        // key matches: keep the whole subtree
        result[key] = data[key];
        hasMatch = true;
      } else {
        var filteredVal = filterJsonRecursive(data[key], regex, mode);
        if (filteredVal !== undefined) {
          result[key] = filteredVal;
          hasMatch = true;
        }
      }
    }
    return hasMatch ? result : undefined;
  }

  // current default HTML (depends on toggle state)
  function currentDefaultHTML() {
    if (showingAlt) {
      var alt = document.getElementById('html-alt');
      if (alt) { return alt.textContent; }
    }
    var def = document.getElementById('html-default');
    return def ? def.textContent : originalCodeHTML;
  }

  // lightweight JSON syntax highlighter — emits hljs class names so the
  // existing rest-client.css hljs theme colors (light/dark/hc) apply.
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightJson(jsonStr) {
    var esc = escapeHtml(jsonStr);
    return esc.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = 'hljs-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'hljs-attr' : 'hljs-string';
        } else if (/^(true|false|null)$/.test(match)) {
          cls = 'hljs-literal';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  function applySearch() {
    var code = getCode();
    if (!code || !rawParsed) { return; }
    var input = document.getElementById('json-search');
    var mode = document.getElementById('search-mode');
    var q = input ? input.value : '';
    if (!q) {
      code.innerHTML = currentDefaultHTML();
      bindFolding();
      return;
    }
    try {
      var regex = new RegExp(q, 'i');
      // search the currently displayed view: extracted when toggled to it, else raw full
      var source = (showingAlt || !extractedParsed) ? rawParsed : extractedParsed;
      var filtered = filterJsonRecursive(source, regex, mode ? mode.value : 'key');
      var filteredStr = filtered !== undefined ? JSON.stringify(filtered, null, 2) : '{}';
      code.innerHTML = highlightJson(filteredStr);
    } catch (e) {
      // invalid regex: fall back to the current default view
      code.innerHTML = currentDefaultHTML();
      bindFolding();
    }
  }

  function cycleMode() {
    var mode = document.getElementById('search-mode');
    if (!mode) { return; }
    var modes = ['key', 'value', 'mixed'];
    mode.value = modes[(modes.indexOf(mode.value) + 1) % modes.length];
    applySearch();
  }

  function initSearch() {
    var raw = document.getElementById('raw-body');
    var code = getCode();
    if (!raw || !code) { return; }
    try {
      rawParsed = JSON.parse(raw.textContent);
    } catch (e) {
      return; // not JSON: no search
    }
    var extracted = document.getElementById('extracted-body');
    if (extracted) {
      try { extractedParsed = JSON.parse(extracted.textContent); } catch (e2) { extractedParsed = null; }
    }
    originalCodeHTML = code.innerHTML;

    var input = document.getElementById('json-search');
    if (input) {
      input.addEventListener('input', applySearch);
      input.addEventListener('keydown', function (e) {
        if (e.altKey && (e.key === 'm' || e.key === 'M')) {
          cycleMode();
          e.preventDefault();
        }
      });
    }
  }

  // ---- folding (unchanged) ----

  function toggleLines(e, collapse) {
    var lineSpan, recursive, isExpandAction;
    if (arguments.length === 2) {
      lineSpan = e;
      recursive = true;
      isExpandAction = !collapse;
      if (isExpandAction) {
        lineSpan.classList.remove('collapsed');
      } else {
        lineSpan.classList.add('collapsed');
      }
    } else {
      lineSpan = e.target.parentNode;
      recursive = e.shiftKey;
      isExpandAction = isCollapspedLine(lineSpan);
      lineSpan.classList.toggle('collapsed');
    }
    var blockEndNum = getFoldingRangeEnd(lineSpan);

    var span = lineSpan;
    var currentLineNum = getLineNum(lineSpan);
    var skipLineEndNum = -1;
    while ((span = span.nextElementSibling) && ++currentLineNum <= blockEndNum) {
      if (isExpandAction) {
        if (currentLineNum > skipLineEndNum || recursive) {
          span.classList.remove('hidden-line');
          span.nextSibling.textContent = '\n';

          if (isCollapspedLine(span)) {
            skipLineEndNum = getFoldingRangeEnd(span);
            if (recursive) {
              span.classList.remove('collapsed');
            }
          }
        }
      } else {
        if (isRangeStartLine(span) && recursive) {
          span.classList.add('collapsed');
        }

        span.classList.add('hidden-line');
        span.nextSibling.textContent = '';
      }
    }
  }

  function getLineNum(element) {
    return parseInt(element.attributes.getNamedItem('start').value);
  }

  function isRangeStartLine(element) {
    return element.hasAttribute('range-start');
  }

  function isCollapspedLine(element) {
    return element.classList.contains('collapsed');
  }

  function getFoldingRangeEnd(element) {
    return parseInt(element.attributes.getNamedItem('range-end').value);
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message.command === 'toggleExtract') {
      showingAlt = !showingAlt;
      applySearch();
      return;
    }
    var code = getCode();
    if (!code) { return; }
    var childs = Array.prototype.slice.call(code.childNodes);
    var lineSpan = childs.find(function (n) { return n.nodeType === 1 && n.hasAttribute('range-start'); });
    toggleLines(lineSpan, message.command === 'foldAll');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onLoad);
  } else {
    onLoad();
  }
})();
