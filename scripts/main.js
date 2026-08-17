// @ts-check
'use strict';

(function () {

  // ---- state for JSON search / raw-extracted toggle ----
  var originalCodeHTML = '';        // initial <code> innerHTML, restored when search is emptied
  var rawParsed = null;            // parsed JSON of #raw-body, null when not a JSON response
  var extractedParsed = null;      // parsed JSON of #extracted-body (jsonpath result), null when none
  var showingAlt = false;          // toggle state: true = showing the alt (raw full) view
  var currentMode = 'mixed';       // 'key' | 'value' | 'mixed'
  var modePopupOpen = false;

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

  // ---- boolean filter expression (&&, ||, !, parentheses) + pinyin matching ----
  // grammar: or := and ('||' and)* ; and := not ('&&' not)* ;
  //          not := '!' not | atom ; atom := '(' or ')' | word
  function parseFilterExpr(expr) {
    var tokens = [];
    var i = 0;
    while (i < expr.length) {
      var c = expr[i];
      if (c === ' ' || c === '\t') {
        var last = tokens[tokens.length - 1];
        if (last && (last.t === 'word' || last.t === 'rparen')) { tokens.push({ t: 'and' }); }
        i++; continue;
      }
      if (expr[i] === '&' && expr[i + 1] === '&') {
        var lastA = tokens[tokens.length - 1];
        if (lastA && (lastA.t === 'word' || lastA.t === 'rparen')) { tokens.push({ t: 'and' }); }
        i += 2; continue;
      }
      if (expr[i] === '|' && expr[i + 1] === '|') { tokens.push({ t: 'or' }); i += 2; continue; }
      if (c === '&' || c === '|') { i++; continue; } // lone operator char, skip
      if (c === '!') { tokens.push({ t: 'not' }); i++; continue; }
      if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
      if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
      var j = i;
      while (j < expr.length && !/[\s&|!()]/.test(expr[j])) { j++; }
      tokens.push({ t: 'word', v: expr.slice(i, j) }); i = j;
    }
    var pos = 0;
    function peek() { return tokens[pos]; }
    function parseOr() {
      var left = parseAnd();
      while (peek() && peek().t === 'or') { pos++; var right = parseAnd(); if (right.op === 'leaf' && !right.p) { break; } left = { op: 'or', l: left, r: right }; }
      return left;
    }
    function parseAnd() {
      var left = parseNot();
      while (peek() && peek().t === 'and') { pos++; var right = parseNot(); if (right.op === 'leaf' && !right.p) { break; } left = { op: 'and', l: left, r: right }; }
      return left;
    }
    function parseNot() {
      if (peek() && peek().t === 'not') { pos++; return { op: 'not', c: parseNot() }; }
      return parseAtom();
    }
    function parseAtom() {
      var tk = peek();
      if (tk && tk.t === 'lparen') { pos++; var e = parseOr(); if (peek() && peek().t === 'rparen') { pos++; } return e; }
      if (tk && tk.t === 'word') { pos++; return { op: 'leaf', p: tk.v }; }
      return { op: 'leaf', p: '' };
    }
    return parseOr();
  }

  function evalFilter(ast, str, matchFn) {
    if (!ast) { return false; }
    if (ast.op === 'leaf') { return matchFn(ast.p, str); }
    if (ast.op === 'not') { return !evalFilter(ast.c, str, matchFn); }
    if (ast.op === 'and') { return evalFilter(ast.l, str, matchFn) && evalFilter(ast.r, str, matchFn); }
    if (ast.op === 'or') { return evalFilter(ast.l, str, matchFn) || evalFilter(ast.r, str, matchFn); }
    return false;
  }

  // match a pattern against a string, falling back to pinyin (full + initials)
  // so that e.g. "zhang" matches "张", "zs" matches "张三".
  function makeMatchFn() {
    return function (pattern, str) {
      if (!pattern || str === undefined || str === null) { return false; }
      var regex;
      try { regex = new RegExp(pattern, 'i'); } catch (e) { return false; }
      var s = String(str);
      if (regex.test(s)) { return true; }
      if (typeof pinyinPro !== 'undefined' && s) {
        try {
          var arr = pinyinPro.pinyin(s, { toneType: 'none', type: 'array' }) || [];
          var full = arr.join('');
          var initials = arr.map(function (x) { return x ? x[0] : ''; }).join('');
          if (regex.test(full) || regex.test(initials)) { return true; }
        } catch (e) { /* ignore */ }
      }
      return false;
    };
  }

  // recursive JSON filter; `ast` is a parsed boolean expression, `matchFn`
  // decides whether a leaf pattern matches a given string (with pinyin fallback).
  function filterJsonRecursive(data, ast, mode, matchFn) {
    // top-level NOT: exclude matches (key or value) instead of including
    if (ast && ast.op === 'not') {
      var inner = ast.c;
      if (typeof data !== 'object' || data === null) {
        if (mode === 'key') { return undefined; }
        return evalFilter(inner, String(data), matchFn) ? undefined : data;
      }
      if (Array.isArray(data)) {
        var af = data.map(function (item) { return filterJsonRecursive(item, ast, mode, matchFn); }).filter(function (v) { return v !== undefined; });
        return af.length > 0 ? af : undefined;
      }
      var ar = {};
      var ah = false;
      for (var k in data) {
        if (mode !== 'value' && evalFilter(inner, k, matchFn)) { continue; } // key matches excluded pattern -> drop
        var fv = filterJsonRecursive(data[k], ast, mode, matchFn);
        if (fv !== undefined) { ar[k] = fv; ah = true; }
      }
      return ah ? ar : undefined;
    }
    if (typeof data !== 'object' || data === null) {
      if (mode !== 'key' && evalFilter(ast, String(data), matchFn)) {
        return data;
      }
      return undefined;
    }
    if (Array.isArray(data)) {
      var filtered = data
        .map(function (item) { return filterJsonRecursive(item, ast, mode, matchFn); })
        .filter(function (v) { return v !== undefined; });
      return filtered.length > 0 ? filtered : undefined;
    }
    var result = {};
    var hasMatch = false;
    for (var key in data) {
      if (mode !== 'value' && evalFilter(ast, key, matchFn)) {
        result[key] = data[key];
        hasMatch = true;
      } else {
        var filteredVal = filterJsonRecursive(data[key], ast, mode, matchFn);
        if (filteredVal !== undefined) {
          result[key] = filteredVal;
          hasMatch = true;
        }
      }
    }
    return hasMatch ? result : undefined;
  }

  // lightweight JSONPath evaluator — supports $, .key, ['key'], [n], [*],
  // ..key, ..[n], .*  (subset of RFC 9535 covering most day-to-day cases).
  function evalJsonPath(path, data) {
    if (!path || path[0] !== '$') { return undefined; }
    var tokens = [];
    var i = 1;
    while (i < path.length) {
      var c = path[i];
      if (c === '.') {
        if (path[i + 1] === '.') {
          i += 2;
          if (path[i] === '*') { tokens.push({ desc: true, all: true }); i++; }
          else if (path[i] === '[') {
            var close = path.indexOf(']', i);
            if (close === -1) { return undefined; }
            var inside = path.slice(i + 1, close);
            if (/^\d+$/.test(inside)) { tokens.push({ desc: true, index: parseInt(inside, 10) }); }
            else { tokens.push({ desc: true, key: inside.replace(/^['"]|['"]$/g, '') }); }
            i = close + 1;
          } else {
            var m = /^([A-Za-z_$][\w$]*)/.exec(path.slice(i));
            if (!m) { return undefined; }
            tokens.push({ desc: true, key: m[1] }); i += m[1].length;
          }
        } else if (path[i + 1] === '*') {
          tokens.push({ all: true }); i += 2;
        } else {
          var m2 = /^([A-Za-z_$][\w$]*)/.exec(path.slice(i + 1));
          if (!m2) { return undefined; }
          tokens.push({ key: m2[1] }); i += 1 + m2[1].length;
        }
      } else if (c === '[') {
        var close2 = path.indexOf(']', i);
        if (close2 === -1) { return undefined; }
        var inside2 = path.slice(i + 1, close2);
        if (inside2 === '*') { tokens.push({ all: true }); }
        else if (/^\d+$/.test(inside2)) { tokens.push({ index: parseInt(inside2, 10) }); }
        else { tokens.push({ key: inside2.replace(/^['"]|['"]$/g, '') }); }
        i = close2 + 1;
      } else {
        break;
      }
    }
    var current = [data];
    for (var ti = 0; ti < tokens.length; ti++) {
      var t = tokens[ti];
      var next = [];
      if (t.desc) {
        for (var ni = 0; ni < current.length; ni++) { next = next.concat(descendantCollect(current[ni], t)); }
      } else if (t.all) {
        for (var ai = 0; ai < current.length; ai++) {
          var node = current[ai];
          if (Array.isArray(node)) { next = next.concat(node); }
          else if (node && typeof node === 'object') {
            for (var k in node) { next.push(node[k]); }
          }
        }
      } else if (t.index !== undefined) {
        for (var ii = 0; ii < current.length; ii++) {
          var arr = current[ii];
          if (Array.isArray(arr) && arr[t.index] !== undefined) { next.push(arr[t.index]); }
        }
      } else if (t.key) {
        for (var ki = 0; ki < current.length; ki++) {
          var obj = current[ki];
          if (obj && typeof obj === 'object' && obj[t.key] !== undefined) { next.push(obj[t.key]); }
        }
      }
      current = next;
    }
    return current;
  }

  function descendantCollect(node, t) {
    var found = [];
    function walk(n) {
      if (!n || typeof n !== 'object') { return; }
      if (Array.isArray(n)) {
        if (t.all) { found = found.concat(n); }
        for (var a = 0; a < n.length; a++) { walk(n[a]); }
      } else {
        if (t.all) { for (var k in n) { found.push(n[k]); } }
        for (var k2 in n) {
          if (!t.all && t.key && k2 === t.key) { found.push(n[k2]); }
          if (t.index !== undefined && Array.isArray(n[k2]) && n[k2][t.index] !== undefined) { found.push(n[k2][t.index]); }
          walk(n[k2]);
        }
      }
    }
    walk(node);
    return found;
  }

  // while typing a path, an incomplete/last token may yield no match;
  // fall back to the longest matching prefix so the view doesn't flash empty.
  function evalPathFallback(path, data) {
    var r = evalJsonPath(path, data);
    if (r && r.length > 0) { return r; }
    var p = path;
    while (p.length > 1) {
      var dot = p.lastIndexOf('.');
      var br = p.lastIndexOf('[');
      var cut = Math.max(dot, br);
      if (cut <= 0) { break; }
      p = p.slice(0, cut);
      var r2 = evalJsonPath(p, data);
      if (r2 && r2.length > 0) { return r2; }
    }
    return undefined;
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

  function stringifyResult(value) {
    // if the extracted value is a string that is itself JSON, pretty-print it as JSON
    if (typeof value === 'string') {
      try { return JSON.stringify(JSON.parse(value), null, 2); } catch (e) { return JSON.stringify(value); }
    }
    return JSON.stringify(value, null, 2);
  }

  // Two independent inputs that compose:
  //   JSONPath  ->  extract from the current view (source)
  //   Filter    ->  filter the (possibly extracted) result by key/value/mixed regex
  function applySearch() {
    var code = getCode();
    if (!code || !rawParsed) { return; }
    var pathInput = document.getElementById('json-path');
    var filterInput = document.getElementById('json-filter');
    var pq = pathInput ? pathInput.value.trim() : '';
    var fq = filterInput ? filterInput.value : '';

    if (!pq && !fq) {
      code.innerHTML = currentDefaultHTML();
      bindFolding();
      return;
    }

    var source = (showingAlt || !extractedParsed) ? rawParsed : extractedParsed;

    // step 1 — key/value/mixed boolean filter (&&, ||, !, parentheses) + pinyin
    var value;
    if (fq) {
      try {
        var ast = parseFilterExpr(fq);
        var matchFn = makeMatchFn();
        var filtered = filterJsonRecursive(source, ast, currentMode, matchFn);
        value = filtered !== undefined ? filtered : {};
      } catch (e) {
        value = source; // invalid: skip filtering
      }
    } else {
      value = source;
    }

    // step 2 — JSONPath extraction on the filtered result (with typing-friendly fallback)
    var display;
    if (pq) {
      var result = evalPathFallback(pq, value);
      if (!result) {
        code.textContent = '(no match)';
        return;
      }
      display = result.length === 1 ? result[0] : result;
    } else {
      display = value;
    }

    code.innerHTML = highlightJson(stringifyResult(display));
  }

  // ---- custom mode dropdown (replaces native <select>) ----

  function setModeLabel() {
    var label = document.getElementById('search-mode-label');
    if (label) {
      label.textContent = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
    }
  }

  function openModePopup() {
    var popup = document.getElementById('search-mode-popup');
    if (!popup) { return; }
    var opts = popup.querySelectorAll('.search-mode-opt');
    opts.forEach(function (o) {
      o.style.fontWeight = (o.dataset.value === currentMode) ? 'bold' : 'normal';
    });
    popup.style.display = 'block';
    modePopupOpen = true;
  }

  function closeModePopup() {
    var popup = document.getElementById('search-mode-popup');
    if (popup) { popup.style.display = 'none'; }
    modePopupOpen = false;
  }

  function toggleModePopup() {
    if (modePopupOpen) { closeModePopup(); } else { openModePopup(); }
  }

  function setMode(m) {
    currentMode = m;
    setModeLabel();
    closeModePopup();
    applySearch();
  }

  function cycleMode() {
    var modes = ['key', 'value', 'mixed'];
    currentMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];
    setModeLabel();
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

    var pathInput = document.getElementById('json-path');
    if (pathInput) {
      pathInput.addEventListener('input', applySearch);
    }
    var filterInput = document.getElementById('json-filter');
    if (filterInput) {
      filterInput.addEventListener('input', applySearch);
      filterInput.addEventListener('keydown', function (e) {
        if (e.altKey && (e.key === 'm' || e.key === 'M')) {
          cycleMode();
          e.preventDefault();
        }
      });
    }

    var modeBtn = document.getElementById('search-mode-btn');
    if (modeBtn) {
      modeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleModePopup();
      });
    }
    var opts = document.querySelectorAll('.search-mode-opt');
    opts.forEach(function (o) {
      o.addEventListener('click', function (e) {
        e.stopPropagation();
        setMode(o.dataset.value);
      });
    });
    document.addEventListener('click', function () {
      if (modePopupOpen) { closeModePopup(); }
    });

    setModeLabel();
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
