import * as fs from 'fs-extra';
import * as os from 'os';
import { Clipboard, commands, env, ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import { SystemSettings } from '../models/configurationSettings';
import { HttpRequest } from '../models/httpRequest';
import { HttpResponse } from '../models/httpResponse';
import { PreviewOption } from '../models/previewOption';
import { trace } from '../utils/decorator';
import { disposeAll } from '../utils/dispose';
import { MimeUtility } from '../utils/mimeUtility';
import { base64, formatHeaders, getHeader, isJSONString } from '../utils/misc';
import { ResponseFormatUtility } from '../utils/responseFormatUtility';
import { UserDataManager } from '../utils/userDataManager';
import { BaseWebview } from './baseWebview';

const hljs = require('highlight.js');
const contentDisposition = require('content-disposition');
const { JSONPath } = require('jsonpath-plus');
const { pinyin } = require('pinyin-pro');

const OPEN = 'Open';
const COPYPATH = 'Copy Path';

type FoldingRange = [number, number];

export class HttpResponseWebview extends BaseWebview {

    private readonly urlRegex = /(https?:\/\/[^\s"'<>\]\)\\]+)/gi;

    private readonly panelResponses: Map<WebviewPanel, HttpResponse>;

    private readonly clipboard: Clipboard = env.clipboard;

    protected get viewType(): string {
        return 'rest-response';
    }

    protected get previewActiveContextKey(): string {
        return 'httpResponsePreviewFocus';
    }

    protected get isHTMLResponse(): string {
        return 'isHTMLResponse';
    }

    private get activeResponse(): HttpResponse | undefined {
        return this.activePanel ? this.panelResponses.get(this.activePanel) : undefined;
    }

    private setIsHTMLResponse(response: HttpResponse | undefined) {
        if (response?.headers['Content-Type']?.includes('text/html')) {
            commands.executeCommand('setContext', this.isHTMLResponse, true);
        } else {
            commands.executeCommand('setContext', this.isHTMLResponse, false);
        }
    }

    private setHasExtract(response: HttpResponse | undefined) {
        const has = !!response?.request?.responsePipeline
            && (MimeUtility.isJSON(response.contentType) || isJSONString(response.body));
        commands.executeCommand('setContext', 'qnhHasExtract', has);
    }

    public constructor(context: ExtensionContext) {
        super(context);

        // Init response webview map
        this.panelResponses = new Map<WebviewPanel, HttpResponse>();

        this.context.subscriptions.push(commands.registerCommand('rest-client.fold-response', this.foldResponseBody, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.unfold-response', this.unfoldResponseBody, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.preview-html-response-body', this.previewResponseBody, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.show-raw-response', this.showRawResponse, this));

        this.context.subscriptions.push(commands.registerCommand('rest-client.copy-response-body', this.copyBody, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.save-response', this.save, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.save-response-body', this.saveBody, this));
        this.context.subscriptions.push(commands.registerCommand('rest-client.toggle-response-extract', this.toggleExtract, this));
    }

    public async render(response: HttpResponse, column: ViewColumn) {
        let panel: WebviewPanel;
        if (this.settings.showResponseInDifferentTab || this.panels.length === 0) {
            panel = window.createWebviewPanel(
                this.viewType,
                this.getTitle(response),
                { viewColumn: column, preserveFocus: !this.settings.previewResponsePanelTakeFocus },
                {
                    enableFindWidget: true,
                    enableScripts: true,
                    retainContextWhenHidden: true
                });

            panel.onDidDispose(() => {
                if (panel === this.activePanel) {
                    this.setPreviewActiveContext(false);
                    this.activePanel = undefined;
                    this.setIsHTMLResponse(undefined);
                    this.setHasExtract(undefined);
                }

                const index = this.panels.findIndex(v => v === panel);
                if (index !== -1) {
                    this.panels.splice(index, 1);
                    this.panelResponses.delete(panel);
                }
                if (this.panels.length === 0) {
                    this._onDidCloseAllWebviewPanels.fire();
                }
            });

            panel.iconPath = this.iconFilePath;

            panel.onDidChangeViewState(({ webviewPanel }) => {
                const active = this.panels.some(p => p.active);
                this.setPreviewActiveContext(active);
                this.activePanel = webviewPanel.active ? webviewPanel : undefined;
                this.setIsHTMLResponse(this.activeResponse);
                this.setHasExtract(this.activeResponse);
            });

            this.panels.push(panel);
        } else {
            panel = this.panels[this.panels.length - 1];
            panel.title = this.getTitle(response);
        }

        panel.webview.html = this.getHtmlForWebview(panel, response);

        this.setPreviewActiveContext(this.settings.previewResponsePanelTakeFocus);

        panel.reveal(column, !this.settings.previewResponsePanelTakeFocus);

        this.panelResponses.set(panel, response);
        this.activePanel = panel;

        this.setIsHTMLResponse(this.activeResponse);
        this.setHasExtract(this.activeResponse);
    }

    public dispose() {
        disposeAll(this.panels);
    }

    @trace('Fold Response')
    private foldResponseBody() {
        this.activePanel?.webview.postMessage({ 'command': 'foldAll' });
    }

    @trace('Unfold Response')
    private unfoldResponseBody() {
        this.activePanel?.webview.postMessage({ 'command': 'unfoldAll' });
    }

    @trace('HTML Preview')
    private previewResponseBody() {
        if (this.activeResponse && this.activePanel) {
            this.activePanel.webview.html = this.activeResponse.body;
        }
    }

    @trace('Raw')
    private showRawResponse() {
        if (this.activeResponse && this.activePanel) {
            this.activePanel.webview.html = this.getHtmlForWebview(this.activePanel, this.activeResponse);
        }
    }

    @trace('Toggle Extract')
    private toggleExtract() {
        this.activePanel?.webview.postMessage({ command: 'toggleExtract' });
    }

    @trace('Copy Response Body')
    private async copyBody() {
        if (this.activeResponse) {
            await this.clipboard.writeText(this.activeResponse.body);
        }
    }

    @trace('Save Response')
    private async save() {
        if (this.activeResponse) {
            const fullResponse = this.getFullResponseString(this.activeResponse);
            const defaultFilePath = UserDataManager.getResponseSaveFilePath(`Response-${Date.now()}.http`);
            try {
                await this.openSaveDialog(defaultFilePath, fullResponse);
            } catch {
                window.showErrorMessage('Failed to save latest response to disk.');
            }
        }
    }

    @trace('Save Response Body')
    private async saveBody() {
        if (this.activeResponse) {
            const fileName = HttpResponseWebview.getResponseBodyOuptutFilename(this.activeResponse, this.settings);
            const defaultFilePath = UserDataManager.getResponseBodySaveFilePath(fileName);

            try {
                await this.openSaveDialog(defaultFilePath, this.activeResponse.bodyBuffer);
            } catch {
                window.showErrorMessage('Failed to save latest response body to disk');
            }
        }
    }

    private static getResponseBodyOuptutFilename(activeResponse: HttpResponse, settings: SystemSettings) {
        if (settings.useContentDispositionFilename) {
            const cdHeader = getHeader(activeResponse.headers, 'content-disposition');
            if (cdHeader) {
                const disposition = contentDisposition.parse(cdHeader);
                if ((disposition?.type === "attachment" || disposition?.type === "inline") && disposition?.parameters?.hasOwnProperty("filename")) {
                    const serverProvidedFilename = disposition.parameters.filename;
                    return serverProvidedFilename;
                }
            }
        }

        const extension = MimeUtility.getExtension(activeResponse.contentType, settings.mimeAndFileExtensionMapping);
        const defaultFileName = !extension ? `Response-${Date.now()}` : `Response-${Date.now()}.${extension}`;
        return defaultFileName;
    }

    private getTitle(response: HttpResponse): string {
        const prefix = (this.settings.requestNameAsResponseTabTitle && response.request.name) || 'Response';
        return `${prefix}(${response.timingPhases.total ?? 0}ms)`;
    }

    private getFullResponseString(response: HttpResponse): string {
        const statusLine = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}${os.EOL}`;
        const headerString = formatHeaders(response.headers);
        const body = response.body ? `${os.EOL}${response.body}` : '';
        return `${statusLine}${headerString}${body}`;
    }

    private async openSaveDialog(path: string, content: string | Buffer) {
        const uri = await window.showSaveDialog({ defaultUri: Uri.file(path) });
        if (!uri) {
            return;
        }

        const filePath = uri.fsPath;
        await fs.writeFile(filePath, content, { flag: 'w' });
        const btn = await window.showInformationMessage(`Saved to ${filePath}`, { title: OPEN }, { title: COPYPATH });
        if (btn?.title === OPEN) {
            workspace.openTextDocument(filePath).then(window.showTextDocument);
        } else if (btn?.title === COPYPATH) {
            await this.clipboard.writeText(filePath);
        }
    }

    private getHtmlForWebview(panel: WebviewPanel, response: HttpResponse): string {
        let innerHtml: string;
        let width = 2;
        let contentType = response.contentType;
        if (contentType) {
            contentType = contentType.trim();
        }
        const isJson = MimeUtility.isJSON(contentType) || isJSONString(response.body);
        const pipeline = response.request?.responsePipeline;
        let hasToggle = false;
        let extractedBodyScript = '';

        if (MimeUtility.isBrowserSupportedImageFormat(contentType) && !HttpResponseWebview.isHeadRequest(response)) {
            innerHtml = `<img src="data:${contentType};base64,${base64(response.bodyBuffer)}">`;
        } else {
            const fullCode = this.highlightResponse(response);
            let defaultCode = fullCode;
            let altCode = '';
            if (pipeline && isJson) {
                const extracted = this.executePipeline(response, pipeline);
                if (extracted !== undefined) {
                    altCode = fullCode;
                    defaultCode = this.highlightBodyString(extracted);
                    hasToggle = true;
                    extractedBodyScript = `<script type="application/json" id="extracted-body">${HttpResponseWebview.escapeForScript(extracted)}</script>`;
                }
            }
            width = (defaultCode.split(/\r\n|\r|\n/).length + 1).toString().length;
            const codeHtml = this.addLineNums(defaultCode);
            innerHtml = `<pre><code id="response-code">${codeHtml}</code></pre>`;
            if (hasToggle) {
                innerHtml += `<script type="text/html" id="html-default">${HttpResponseWebview.escapeForScript(codeHtml)}</script>`;
                innerHtml += `<script type="text/html" id="html-alt">${HttpResponseWebview.escapeForScript(this.addLineNums(altCode))}</script>`;
            }
        }

        const showToolbar = isJson && !MimeUtility.isBrowserSupportedImageFormat(contentType);
        const toolbar = showToolbar
            ? `<div id="json-toolbar" style="display:flex;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,#ccc);position:sticky;top:0;background:var(--vscode-editor-background,#fff);z-index:10;">
                 <input id="json-filter" type="text" placeholder="Filter (regex)..." style="flex:1;min-width:100px;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#fff);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;"/>
                 <input id="json-path" type="text" placeholder="JSONPath, e.g. $.data.list[0]" style="flex:1;min-width:100px;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#fff);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;"/>
                 <div id="search-mode-wrap" style="position:relative;">
                   <button id="search-mode-btn" type="button" title="Search mode (Alt+M)" style="background:var(--vscode-dropdown-background,#3c3c3c);color:var(--vscode-dropdown-foreground,#fff);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;cursor:pointer;padding:2px 8px;display:flex;align-items:center;gap:4px;font-size:12px;">
                     <span id="search-mode-label">Key</span><span style="opacity:0.7;font-size:9px;">▾</span>
                   </button>
                   <style>.search-mode-opt:hover{background:var(--vscode-list-hoverBackground,#2a2d2e);} .search-mode-opt{transition:background .08s;}</style>
                   <div id="search-mode-popup" style="display:none;position:absolute;top:calc(100% + 2px);right:0;background:var(--vscode-dropdown-background,#3c3c3c);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;z-index:20;min-width:90px;box-shadow:0 2px 8px rgba(0,0,0,0.3);overflow:hidden;">
                     <div class="search-mode-opt" data-value="key" style="padding:4px 12px;cursor:pointer;color:var(--vscode-dropdown-foreground,#fff);">Key</div>
                     <div class="search-mode-opt" data-value="value" style="padding:4px 12px;cursor:pointer;color:var(--vscode-dropdown-foreground,#fff);">Value</div>
                     <div class="search-mode-opt" data-value="mixed" style="padding:4px 12px;cursor:pointer;color:var(--vscode-dropdown-foreground,#fff);">Mixed</div>
                   </div>
                 </div>
               </div>`
            : '';

        const rawBodyScript = (isJson && response.body)
            ? `<script type="application/json" id="raw-body">${HttpResponseWebview.escapeForScript(response.body)}</script>`
            : '';

        // Content Security Policy
        const nonce = new Date().getTime() + '' + new Date().getMilliseconds();
        const csp = this.getCsp(nonce);
        return `
    <head>
        <link rel="stylesheet" type="text/css" href="${panel.webview.asWebviewUri(this.baseFilePath)}">
        <link rel="stylesheet" type="text/css" href="${panel.webview.asWebviewUri(this.vscodeStyleFilePath)}">
        <link rel="stylesheet" type="text/css" href="${panel.webview.asWebviewUri(this.customStyleFilePath)}">
        ${this.getSettingsOverrideStyles(width)}
        ${csp}
        <script nonce="${nonce}">
            document.addEventListener('DOMContentLoaded', function () {
                document.getElementById('scroll-to-top')
                        .addEventListener('click', function () { window.scrollTo(0,0); });
            });
        </script>
    </head>
    <body>
        ${toolbar}
        <div>
            ${this.settings.disableAddingHrefLinkForLargeResponse && response.bodySizeInBytes > this.settings.largeResponseBodySizeLimitInMB * 1024 * 1024
                ? innerHtml
                : this.addUrlLinks(innerHtml)}
            <a id="scroll-to-top" role="button" aria-label="scroll to top" title="Scroll To Top"><span class="icon"></span></a>
        </div>
        ${rawBodyScript}
        ${extractedBodyScript}
        <script type="text/javascript" src="${panel.webview.asWebviewUri(this.pinyinScriptFilePath)}" nonce="${nonce}" charset="UTF-8"></script>
        <script type="text/javascript" src="${panel.webview.asWebviewUri(this.scriptFilePath)}" nonce="${nonce}" charset="UTF-8"></script>
    </body>`;
    }

    /**
     * Execute a response pipeline: a `|`-separated list of steps evaluated left
     * to right against the response body. Each step is either a JSONPath (`$...`)
     * extraction or a `key:`/`value:`/`mixed:` filter (boolean expression with
     * `&&`/`||`/`!`/parentheses + pinyin fallback). `|` inside a filter must be
     * escaped as `\|` so it isn't treated as a step separator. Returns the
     * final value as a pretty-printed JSON string, or undefined if any step misses.
     */
    private executePipeline(response: HttpResponse, pipelineStr: string): string | undefined {
        let current: any;
        try {
            current = JSON.parse(response.body);
        } catch {
            return undefined;
        }
        // split on non-escaped `|` (so `\|` survives inside a filter expression),
        // then unescape `\|` -> `|`
        const steps = pipelineStr.split(/(?<!\\)\|/)
            .map(s => s.replace(/\\\|/g, '|').trim())
            .filter(s => s.length > 0);
        for (const step of steps) {
            if (step.startsWith('$')) {
                try {
                    const result = JSONPath({ path: step, json: current });
                    if (!result || result.length === 0) { return undefined; }
                    current = result.length === 1 ? result[0] : result;
                    // if the extracted value is a JSON-encoded string, parse it so
                    // downstream steps can operate on its structure
                    if (typeof current === 'string') {
                        try { current = JSON.parse(current); } catch { /* keep as raw string */ }
                    }
                } catch {
                    return undefined;
                }
            } else {
                const m = step.match(/^(key|value|mixed):\s*(.*)$/);
                if (!m) { continue; }
                const ast = HttpResponseWebview.parseFilterExpr(m[2].trim());
                const matchFn = HttpResponseWebview.makeMatchFn();
                current = HttpResponseWebview.filterJsonRecursive(current, ast, m[1], matchFn);
                if (current === undefined) { return undefined; }
            }
        }
        if (typeof current === 'string') {
            // the final value may be a string whose content is itself JSON
            try { return JSON.stringify(JSON.parse(current), null, 2); } catch { return JSON.stringify(current); }
        }
        return JSON.stringify(current, null, 2);
    }

    // boolean filter expression (&&, ||, !, parentheses). grammar:
    //   or := and ('||' and)* ; and := not ('&&' not)* ; not := '!' not | atom ; atom := '(' or ')' | word
    private static parseFilterExpr(expr: string): any {
        const tokens: any[] = [];
        let i = 0;
        while (i < expr.length) {
            const c = expr[i];
            if (c === ' ' || c === '\t') {
                const last = tokens[tokens.length - 1];
                if (last && (last.t === 'word' || last.t === 'rparen')) { tokens.push({ t: 'and' }); }
                i++; continue;
            }
            if (expr[i] === '&' && expr[i + 1] === '&') {
                const lastA = tokens[tokens.length - 1];
                if (lastA && (lastA.t === 'word' || lastA.t === 'rparen')) { tokens.push({ t: 'and' }); }
                i += 2; continue;
            }
            if (expr[i] === '|' && expr[i + 1] === '|') { tokens.push({ t: 'or' }); i += 2; continue; }
            if (c === '&' || c === '|') { i++; continue; } // lone operator char, skip
            if (c === '!') { tokens.push({ t: 'not' }); i++; continue; }
            if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
            if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
            let j = i;
            while (j < expr.length && !/[\s&|!()]/.test(expr[j])) { j++; }
            tokens.push({ t: 'word', v: expr.slice(i, j) }); i = j;
        }
        let pos = 0;
        const peek = () => tokens[pos];
        const parseOr = (): any => {
            let left = parseAnd();
            while (peek() && peek().t === 'or') { pos++; const right = parseAnd(); if (right.op === 'leaf' && !right.p) { break; } left = { op: 'or', l: left, r: right }; }
            return left;
        };
        const parseAnd = (): any => {
            let left = parseNot();
            while (peek() && peek().t === 'and') { pos++; const right = parseNot(); if (right.op === 'leaf' && !right.p) { break; } left = { op: 'and', l: left, r: right }; }
            return left;
        };
        const parseNot = (): any => {
            if (peek() && peek().t === 'not') { pos++; return { op: 'not', c: parseNot() }; }
            return parseAtom();
        };
        const parseAtom = (): any => {
            const tk = peek();
            if (tk && tk.t === 'lparen') { pos++; const e = parseOr(); if (peek() && peek().t === 'rparen') { pos++; } return e; }
            if (tk && tk.t === 'word') { pos++; return { op: 'leaf', p: tk.v }; }
            return { op: 'leaf', p: '' };
        };
        return parseOr();
    }

    private static evalFilter(ast: any, str: string, matchFn: (p: string, s: string) => boolean): boolean {
        if (!ast) { return false; }
        if (ast.op === 'leaf') { return matchFn(ast.p, str); }
        if (ast.op === 'not') { return !HttpResponseWebview.evalFilter(ast.c, str, matchFn); }
        if (ast.op === 'and') { return HttpResponseWebview.evalFilter(ast.l, str, matchFn) && HttpResponseWebview.evalFilter(ast.r, str, matchFn); }
        if (ast.op === 'or') { return HttpResponseWebview.evalFilter(ast.l, str, matchFn) || HttpResponseWebview.evalFilter(ast.r, str, matchFn); }
        return false;
    }

    // match a pattern against a string, falling back to pinyin (full + initials)
    // so that e.g. "zhang" matches "张", "zs" matches "张三".
    private static makeMatchFn(): (p: string, s: string) => boolean {
        return (pattern, str) => {
            if (!pattern || str === undefined || str === null) { return false; }
            let regex: RegExp;
            try { regex = new RegExp(pattern, 'i'); } catch { return false; }
            const s = String(str);
            if (regex.test(s)) { return true; }
            try {
                const arr = pinyin(s, { toneType: 'none', type: 'array' }) || [];
                const full = arr.join('');
                const initials = arr.map((x: string) => x ? x[0] : '').join('');
                if (regex.test(full) || regex.test(initials)) { return true; }
            } catch { /* ignore */ }
            return false;
        };
    }

    private static filterJsonRecursive(data: any, ast: any, mode: string, matchFn: (p: string, s: string) => boolean): any {
        // top-level NOT: exclude matches (key or value) instead of including
        if (ast && ast.op === 'not') {
            const inner = ast.c;
            if (typeof data !== 'object' || data === null) {
                if (mode === 'key') { return undefined; }
                return HttpResponseWebview.evalFilter(inner, String(data), matchFn) ? undefined : data;
            }
            if (Array.isArray(data)) {
                const af = data.map(item => HttpResponseWebview.filterJsonRecursive(item, ast, mode, matchFn)).filter(v => v !== undefined);
                return af.length > 0 ? af : undefined;
            }
            const ar: any = {};
            let ah = false;
            for (const k in data) {
                if (mode !== 'value' && HttpResponseWebview.evalFilter(inner, k, matchFn)) { continue; } // key matches excluded pattern -> drop
                const fv = HttpResponseWebview.filterJsonRecursive(data[k], ast, mode, matchFn);
                if (fv !== undefined) { ar[k] = fv; ah = true; }
            }
            return ah ? ar : undefined;
        }
        if (typeof data !== 'object' || data === null) {
            return (mode !== 'key' && HttpResponseWebview.evalFilter(ast, String(data), matchFn)) ? data : undefined;
        }
        if (Array.isArray(data)) {
            const filtered = data.map(item => HttpResponseWebview.filterJsonRecursive(item, ast, mode, matchFn)).filter(v => v !== undefined);
            return filtered.length > 0 ? filtered : undefined;
        }
        const result: any = {};
        let hasMatch = false;
        for (const key in data) {
            if (mode !== 'value' && HttpResponseWebview.evalFilter(ast, key, matchFn)) {
                result[key] = data[key];
                hasMatch = true;
            } else {
                const filteredVal = HttpResponseWebview.filterJsonRecursive(data[key], ast, mode, matchFn);
                if (filteredVal !== undefined) {
                    result[key] = filteredVal;
                    hasMatch = true;
                }
            }
        }
        return hasMatch ? result : undefined;
    }

    private highlightBodyString(body: string): string {
        try {
            return hljs.highlight('json', body).value;
        } catch {
            return body;
        }
    }

    private static escapeForScript(s: string): string {
        return s.replace(/<\/(script)/gi, '<\\/$1');
    }

    private highlightResponse(response: HttpResponse): string {
        let code = '';
        const previewOption = this.settings.previewOption;
        if (previewOption === PreviewOption.Exchange) {
            // for add request details
            const request = response.request;
            const requestNonBodyPart = `${request.method} ${request.url} HTTP/1.1
${formatHeaders(request.headers)}`;
            code += hljs.highlight('http', requestNonBodyPart + '\r\n').value;
            if (request.body) {
                if (typeof request.body !== 'string') {
                    request.body = 'NOTE: Request Body From File Is Not Shown';
                }
                const requestBodyPart = `${ResponseFormatUtility.formatBody(request.body, request.contentType, true)}`;
                const bodyLanguageAlias = HttpResponseWebview.getHighlightLanguageAlias(request.contentType, request.body);
                if (bodyLanguageAlias) {
                    code += hljs.highlight(bodyLanguageAlias, requestBodyPart).value;
                } else {
                    code += hljs.highlightAuto(requestBodyPart).value;
                }
                code += '\r\n';
            }

            code += '\r\n'.repeat(2);
        }

        if (previewOption !== PreviewOption.Body) {
            const responseNonBodyPart = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}
${formatHeaders(response.headers)}`;
            code += hljs.highlight('http', responseNonBodyPart + (previewOption !== PreviewOption.Headers ? '\r\n' : '')).value;
        }

        if (previewOption !== PreviewOption.Headers) {
            const responseBodyPart = `${ResponseFormatUtility.formatBody(response.body, response.contentType, this.settings.suppressResponseBodyContentTypeValidationWarning)}`;
            if (this.settings.disableHighlightResponseBodyForLargeResponse &&
                response.bodySizeInBytes > this.settings.largeResponseBodySizeLimitInMB * 1024 * 1024) {
                code += responseBodyPart;
            } else {
                const bodyLanguageAlias = HttpResponseWebview.getHighlightLanguageAlias(response.contentType, responseBodyPart);
                if (bodyLanguageAlias) {
                    code += hljs.highlight(bodyLanguageAlias, responseBodyPart).value;
                } else {
                    code += hljs.highlightAuto(responseBodyPart).value;
                }
            }
        }

        return code;
    }

    private getSettingsOverrideStyles(width: number): string {
        return [
            '<style>',
            (this.settings.fontFamily || this.settings.fontSize || this.settings.fontWeight ? [
                'code {',
                this.settings.fontFamily ? `font-family: ${this.settings.fontFamily};` : '',
                this.settings.fontSize ? `font-size: ${this.settings.fontSize}px;` : '',
                this.settings.fontWeight ? `font-weight: ${this.settings.fontWeight};` : '',
                '}',
            ] : []).join('\n'),
            'code .line {',
            `padding-left: calc(${width}ch + 20px );`,
            '}',
            'code .line:before {',
            `width: ${width}ch;`,
            `margin-left: calc(-${width}ch + -30px );`,
            '}',
            '.line .icon {',
            `left: calc(${width}ch + 3px)`,
            '}',
            '.line.collapsed .icon {',
            `left: calc(${width}ch + 3px)`,
            '}',
            '</style>'].join('\n');
    }

    private getCsp(nonce: string): string {
        return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' http: https: data: vscode-resource:; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' http: https: data: vscode-resource:;">`;
    }

    private addLineNums(code): string {
        code = code.replace(/([\r\n]\s*)(<\/span>)/ig, '$2$1');

        code = this.cleanLineBreaks(code);

        code = code.split(/\r\n|\r|\n/);
        const max = (1 + code.length).toString().length;

        const foldingRanges = this.getFoldingRange(code);

        code = code
            .map(function (line, i) {
                const lineNum = i + 1;
                const range = foldingRanges.has(lineNum)
                    ? ` range-start="${foldingRanges.get(lineNum)![0]}" range-end="${foldingRanges.get(lineNum)![1]}"`
                    : '';
                const folding = foldingRanges.has(lineNum) ? '<span class="icon"></span>' : '';
                return `<span class="line width-${max}" start="${lineNum}"${range}>${line}${folding}</span>`;
            })
            .join('\n');
        return code;
    }

    private cleanLineBreaks(code: string): string {
        const openSpans: string[] = [],
            matcher = /<\/?span[^>]*>|\r\n|\r|\n/ig,
            newline = /\r\n|\r|\n/,
            closingTag = /^<\//;

        return code.replace(matcher, function (match: string) {
            if (newline.test(match)) {
                if (openSpans.length) {
                    return openSpans.map(() => '</span>').join('') + match + openSpans.join('');
                } else {
                    return match;
                }
            } else if (closingTag.test(match)) {
                openSpans.pop();
                return match;
            } else {
                openSpans.push(match);
                return match;
            }
        });
    }

    private addUrlLinks(innerHtml: string) {
        return innerHtml.replace(this.urlRegex, (match: string): string => {
            const encodedEndCharacters = ["&lt;", "&gt;", "&quot;", "&apos;"];
            let urlEndPosition = match.length;

            encodedEndCharacters.forEach((char) => {
                const index = match.indexOf(char);
                if (index > -1 && index < urlEndPosition) {
                    urlEndPosition = index;
                }
            });

            const url = match.substr(0, urlEndPosition);
            const extraCharacters = match.substr(urlEndPosition);

            return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>' + extraCharacters;
        });
    }

    private getFoldingRange(lines: string[]): Map<number, FoldingRange> {
        const result = new Map<number, FoldingRange>();
        const stack: [number, number][] = [];

        const leadingSpaceCount = lines
            .map((line, index) => [index, line.search(/\S/)])
            .filter(([, num]) => num !== -1);
        for (const [index, [lineIndex, count]] of leadingSpaceCount.entries()) {
            if (index === 0) {
                continue;
            }

            const [prevLineIndex, prevCount] = leadingSpaceCount[index - 1];
            if (prevCount < count) {
                stack.push([prevLineIndex, prevCount]);
            } else if (prevCount > count) {
                let prev;
                while ((prev = stack.slice(-1)[0]) && (prev[1] >= count)) {
                    stack.pop();
                    result.set(prev[0] + 1, [prev[0] + 1, lineIndex]);
                }
            }
        }
        return result;
    }

    private static getHighlightLanguageAlias(contentType: string | undefined, content: string | null = null): string | null {
        if (MimeUtility.isJSON(contentType)) {
            return 'json';
        } else if (MimeUtility.isJavaScript(contentType)) {
            return 'javascript';
        } else if (MimeUtility.isXml(contentType)) {
            return 'xml';
        } else if (MimeUtility.isHtml(contentType)) {
            return 'html';
        } else if (MimeUtility.isCSS(contentType)) {
            return 'css';
        } else {
            // If content is provided, guess from content if not content type is matched
            if (content && isJSONString(content)) {
                return 'json';
            }
            return null;
        }
    }

    private static isHeadRequest({ request: { method } }: { request: HttpRequest }): boolean {
        return method.toLowerCase() === 'head';
    }
}
