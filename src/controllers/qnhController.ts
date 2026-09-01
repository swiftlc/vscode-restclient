import { ConfigurationTarget, ExtensionContext, QuickPickItem, window, workspace } from 'vscode';
import * as Constants from '../common/constants';
import { SystemSettings } from '../models/configurationSettings';
import { QnhClient, QnhLoginInfo, QnhSwimlaneItem } from '../utils/qnhClient';
import { QnhStatusBarEntry } from '../utils/qnhStatusBarEntry';
import { trace } from '../utils/decorator';

type EnvPickItem = QuickPickItem & { key: Constants.QnhEnvKey };
type SwimlanePickItem = QuickPickItem & { value: string; manual: boolean };

interface LastQnhEnvironment {
    key: Constants.QnhEnvKey;
    swimlaneValue?: string;
}

/**
 * Switches the QNH (牵牛花) environment for REST Client.
 *
 * Picking an environment resolves the target host (fixed for prod/staging/default,
 * or composed from a swimlane value), grabs the matching Chrome cookie via the
 * local alfred proxy-server, validates it with isLogined, then writes
 * `qnh-host` / `qnh-cookie` / `qnh-tenant-id` / `qnh-account-id` into the `$shared`
 * environment of `rest-client.environmentVariables` so `{{qnh-host}}` etc. resolve
 * in `.http` files through the existing variable processor.
 *
 * The last choice is persisted in globalState and restored (cookie re-fetch +
 * isLogined) on activation, so the variables are ready without a manual switch.
 */
export class QnhController {
    private readonly context: ExtensionContext;
    private readonly settings: SystemSettings = SystemSettings.Instance;
    private readonly statusEntry: QnhStatusBarEntry;
    private readonly client: QnhClient;

    public constructor(context: ExtensionContext) {
        this.context = context;
        this.client = new QnhClient(this.settings.qnhAlfredBaseUrl);
        this.statusEntry = new QnhStatusBarEntry('QNH: (none)');
    }

    @trace('Switch QNH Environment')
    public async switchEnvironment(): Promise<void> {
        const envs: EnvPickItem[] = (['prod', 'staging', 'default', 'swimlane'] as Constants.QnhEnvKey[]).map(key => ({
            key,
            label: `$(server) ${key}`,
            description: key === 'swimlane' ? 'dynamic query' : Constants.QnhFixedHosts[key],
        }));

        const envPick = await window.showQuickPick(envs, { placeHolder: 'Select QNH (牵牛花) Environment' });
        if (!envPick) {
            return;
        }

        let swimlaneValue: string | undefined;
        if (envPick.key === 'swimlane') {
            const swimlane = await this.pickSwimlane();
            if (!swimlane) {
                return;     // user cancelled swimlane selection
            }
            swimlaneValue = swimlane.value;
        }

        await this.applyEnvironment(envPick.key, swimlaneValue);
        await this.context.globalState.update(Constants.QnhLastEnvironmentStateKey, {
            key: envPick.key,
            swimlaneValue,
        } as LastQnhEnvironment);
    }

    /**
     * Restore the last chosen QNH environment on activation — re-grabs the cookie
     * and re-validates the login so the variables are ready without a manual switch.
     * Runs quietly (no success toast); failures still surface as warnings.
     */
    public async restoreLastEnvironment(): Promise<void> {
        const last = this.context.globalState.get<LastQnhEnvironment>(Constants.QnhLastEnvironmentStateKey);
        if (!last) {
            return;
        }
        try {
            await this.applyEnvironment(last.key, last.swimlaneValue, true);
        } catch (e) {
            window.showWarningMessage(`QNH: failed to restore last environment (${(e as Error).message}). Switch manually via the status bar.`);
        }
    }

    /**
     * Reload the current QNH environment's variables (re-grab cookie + isLogined)
     * without changing the selected environment.
     */
    public async reloadEnvironment(): Promise<void> {
        await this.restoreLastEnvironment();
    }

    /**
     * Core switching logic shared by manual switch and auto-restore.
     *
     * @param quiet when true (auto-restore), suppress the success information toast;
     *              warnings about invalid cookies are still shown.
     */
    private async applyEnvironment(envKey: Constants.QnhEnvKey, swimlaneValue?: string, quiet = false): Promise<void> {
        let host: string;
        let label: string;
        if (envKey === 'swimlane') {
            if (!swimlaneValue) {
                return;     // cannot resolve a swimlane host without a value
            }
            host = Constants.QnhSwimlaneHostTpl(swimlaneValue);
            label = `QNH: swimlane(${swimlaneValue})`;
        } else {
            host = Constants.QnhFixedHosts[envKey];
            label = `QNH: ${envKey}`;
        }

        // Always grab cookie from the actual target host (not a shared
        // domain), since users may only be logged into some environments.
        const cookieDomain = new URL(host).host;

        // grab the Chrome cookie for the target host (non-fatal)
        let cookie = '';
        let warned = false;
        try {
            cookie = await this.client.fetchCookie(cookieDomain);
        } catch (e) {
            warned = true;
            window.showWarningMessage(`QNH: failed to fetch cookie from alfred (${(e as Error).message}). Host switched, cookie left empty.`);
        }

        // validate the cookie via isLogined against the target host; surface tenant/user
        // info on success, warn about invalid/expired cookie on failure
        let loginInfo: QnhLoginInfo | undefined;
        if (cookie) {
            try {
                loginInfo = await this.client.fetchLoginInfo(cookieDomain, cookie);
            } catch (e) {
                warned = true;
                cookie = '';  // drop invalid cookie so it isn't written
                window.showWarningMessage(`QNH: cookie for ${cookieDomain} is invalid or expired (${(e as Error).message}). Please log in to ${cookieDomain} in Chrome first. Host switched, but cookie/tenant info unavailable.`);
            }
        }

        // write qnh-host / qnh-cookie / qnh-tenant-id / qnh-account-id into $shared
        const newVars: { [key: string]: string } = {
            [Constants.QnhHostVariableName]: host,
            [Constants.QnhCookieVariableName]: cookie,
            [Constants.QnhTenantIdVariableName]: loginInfo?.tenantId != null ? String(loginInfo.tenantId) : '',
            [Constants.QnhAccountIdVariableName]: loginInfo?.accountId != null ? String(loginInfo.accountId) : '',
        };
        const config = workspace.getConfiguration('rest-client');
        const inspect = config.inspect<{ [env: string]: { [key: string]: string } }>('environmentVariables');
        // default to Workspace (local) scope so the switch only affects the
        // current workspace; fall back to Global only when there's no workspace
        const target = workspace.workspaceFolders
            ? ConfigurationTarget.Workspace
            : ConfigurationTarget.Global;
        const base = (inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue ?? {}) as { [env: string]: { [key: string]: string } };
        // merge into $shared, preserving any other variables the user already keeps there
        const existingShared = base[Constants.QnhEnvironmentName] ?? {};
        const merged = {
            ...base,
            [Constants.QnhEnvironmentName]: { ...existingShared, ...newVars },
        };
        await config.update('environmentVariables', merged, target);

        if (loginInfo) {
            const who = loginInfo.accountName ?? loginInfo.uid ?? '?';
            const tenant = loginInfo.tenantName ?? String(loginInfo.tenantId ?? '');
            label = `${label} | ${who}@${tenant}`;
            if (!quiet) {
                window.showInformationMessage(`QNH: switched to ${envKey} — user ${who}, tenant ${tenant} (id=${loginInfo.tenantId})`);
            }
        }
        if (warned) {
            this.statusEntry.warn(label);
        } else {
            this.statusEntry.update(label);
        }
    }

    private async pickSwimlane(): Promise<{ value: string } | undefined> {
        const manualItem: SwimlanePickItem = {
            label: '$(pencil) Manual swimlane input',
            value: Constants.QnhManualInputPickValue,
            manual: true,
        };

        let items: SwimlanePickItem[] = [manualItem];
        try {
            const lanes: QnhSwimlaneItem[] = await this.client.fetchSwimlanes();
            items = [
                ...lanes.map(l => ({
                    label: l.title,
                    description: l.value,
                    value: l.value,
                    manual: false,
                })),
                manualItem,
            ];
        } catch (e) {
            window.showWarningMessage(`QNH: swimlane list query failed (${(e as Error).message}), manual input only.`);
        }

        const pick = await window.showQuickPick(items, { placeHolder: 'Select swimlane' });
        if (!pick) {
            return undefined;
        }
        if (pick.manual) {
            const input = await window.showInputBox({
                prompt: 'Enter swimlane value',
                placeHolder: 'e.g. selftest-260730-162012-877',
            });
            if (!input) {
                return undefined;
            }
            const value = input.trim();
            return value ? { value } : undefined;
        }
        return { value: pick.value };
    }

    public dispose() {
        this.statusEntry.dispose();
    }
}
