import * as fs from 'fs';
import * as path from 'path';
import { Disposable, ExtensionContext, OutputChannel, StatusBarAlignment, StatusBarItem, window, workspace } from 'vscode';
import { LionClient, LionConfigItem, LionEnv } from '../utils/lionClient';

const EnvStateKey = 'rest-client.lion.env';
const Envs: LionEnv[] = ['prod', 'staging', 'test'];
const CacheTtlMs = 60 * 1000;
const PlusBootFiles = ['plusboot.yaml', 'plusboot.yml'];
const AppKeyPattern = /^\s*-?\s*appkey:\s*([\w.\-]+)/m;

interface CacheEntry {
    at: number;
    item: Promise<LionConfigItem | undefined>;
}

export class LionController implements Disposable {
    private readonly statusEntry: StatusBarItem;
    private readonly output: OutputChannel = window.createOutputChannel('REST Client Lion');
    private readonly cache = new Map<string, CacheEntry>();
    private readonly appKeyByDir = new Map<string, string | undefined>();
    private env: LionEnv;

    public constructor(private readonly context: ExtensionContext) {
        const saved = context.globalState.get<LionEnv>(EnvStateKey);
        this.env = saved && Envs.includes(saved) ? saved : 'prod';
        this.statusEntry = window.createStatusBarItem('lion-environment', StatusBarAlignment.Right, 98);
        this.statusEntry.command = 'rest-client.switch-lion-environment';
        this.statusEntry.name = 'REST Client Lion Environment';
        this.statusEntry.tooltip = 'Switch Lion environment used for Java string hover';
        this.refreshStatusBar();
        this.updateVisibility();
        context.subscriptions.push(window.onDidChangeActiveTextEditor(() => this.updateVisibility()));
    }

    public get currentEnv(): LionEnv {
        return this.env;
    }

    public async switchEnvironment(): Promise<void> {
        const picked = await window.showQuickPick(
            Envs.map(e => ({ label: e, description: e === this.env ? 'current' : undefined })),
            { placeHolder: 'Select Lion environment for Java string hover' });
        if (!picked || picked.label === this.env) {
            return;
        }
        this.env = picked.label as LionEnv;
        this.cache.clear();
        await this.context.globalState.update(EnvStateKey, this.env);
        this.refreshStatusBar();
    }

    /** Resolves the Lion item for a string literal, or undefined when the string is not a known config. */
    public lookup(appKey: string, text: string): Promise<LionConfigItem | undefined> {
        const cacheKey = `${this.env}|${appKey}|${text}`;
        const hit = this.cache.get(cacheKey);
        if (hit && Date.now() - hit.at < CacheTtlMs) {
            return hit.item;
        }
        this.log(`lookup env=${this.env} appKey=${appKey} text=${text}`);
        const proxyUrl = workspace.getConfiguration('rest-client').get<string>('lion.proxyUrl', 'http://www.swiftlc.com/api/sso');
        const item = new LionClient(proxyUrl).findConfig(this.env, appKey, text);
        this.cache.set(cacheKey, { at: Date.now(), item });
        item.then(i => this.log(`  -> ${i ? 'hit' : 'not found'}`), e => {
            this.log(`  -> error: ${e?.message}`);
            this.cache.delete(cacheKey);
        });
        return item;
    }

    public async resolveAppKey(filePath: string): Promise<string | undefined> {
        const override = workspace.getConfiguration('rest-client').get<string>('lion.appKey');
        if (override) {
            return override;
        }
        const visited: string[] = [];
        let dir = path.dirname(filePath);
        let found: string | undefined;
        while (true) {
            if (this.appKeyByDir.has(dir)) {
                found = this.appKeyByDir.get(dir);
                break;
            }
            visited.push(dir);
            found = await this.readAppKey(dir);
            if (found) {
                break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        if (!found) {
            found = await this.findAppKeyInWorkspace();
        }
        visited.forEach(d => this.appKeyByDir.set(d, found));
        this.log(`resolveAppKey ${filePath} -> ${found ?? 'NOT FOUND'}`);
        return found;
    }

    public log(message: string) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    public dispose() {
        this.statusEntry.dispose();
        this.output.dispose();
    }

    private async findAppKeyInWorkspace(): Promise<string | undefined> {
        const files = await workspace.findFiles('**/plusboot.{yaml,yml}', '**/{node_modules,target,build}/**', 5);
        for (const f of files) {
            const m = AppKeyPattern.exec(await fs.promises.readFile(f.fsPath, 'utf8'));
            if (m) {
                return m[1];
            }
        }
        return undefined;
    }

    private async readAppKey(dir: string): Promise<string | undefined> {
        for (const name of PlusBootFiles) {
            try {
                const m = AppKeyPattern.exec(await fs.promises.readFile(path.join(dir, name), 'utf8'));
                if (m) {
                    return m[1];
                }
            } catch {
                // not present in this directory
            }
        }
        return undefined;
    }

    private refreshStatusBar() {
        this.statusEntry.text = `$(symbol-key) Lion: ${this.env}`;
    }

    private updateVisibility() {
        if (window.activeTextEditor?.document.languageId === 'java') {
            this.statusEntry.show();
        } else {
            this.statusEntry.hide();
        }
    }
}
