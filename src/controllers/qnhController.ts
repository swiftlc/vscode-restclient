import { ConfigurationTarget, QuickPickItem, window, workspace } from 'vscode';
import * as Constants from '../common/constants';
import { SystemSettings } from '../models/configurationSettings';
import { QnhClient, QnhSwimlaneItem } from '../utils/qnhClient';
import { QnhStatusBarEntry } from '../utils/qnhStatusBarEntry';
import { trace } from '../utils/decorator';

type EnvPickItem = QuickPickItem & { key: Constants.QnhEnvKey };
type SwimlanePickItem = QuickPickItem & { value: string; manual: boolean };

/**
 * Switches the QNH (牵牛花) environment for REST Client.
 *
 * Picking an environment resolves the target host (fixed for prod/staging/default,
 * or composed from a swimlane value), grabs the matching Chrome cookie via the
 * local alfred proxy-server, then writes `qnh-host` and `qnh-cookie` into the
 * `qnh` environment of `rest-client.environmentVariables` so that `{{qnh-host}}`
 * and `{{qnh-cookie}}` resolve in `.http` files through the existing variable
 * processor — no changes to the variable resolution layer.
 */
export class QnhController {
    private readonly settings: SystemSettings = SystemSettings.Instance;
    private readonly statusEntry: QnhStatusBarEntry;
    private readonly client: QnhClient;

    public constructor() {
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

        let host: string;
        let label: string;
        if (envPick.key === 'swimlane') {
            const swimlane = await this.pickSwimlane();
            if (!swimlane) {
                return;     // user cancelled swimlane selection
            }
            host = Constants.QnhSwimlaneHostTpl(swimlane.value);
            label = `QNH: swimlane(${swimlane.value})`;
        } else {
            host = Constants.QnhFixedHosts[envPick.key];
            label = `QNH: ${envPick.key}`;
        }

        // grab the Chrome cookie for the resolved host (non-fatal)
        let cookie = '';
        let warned = false;
        try {
            cookie = await this.client.fetchCookie(new URL(host).host);
        } catch (e) {
            warned = true;
            window.showWarningMessage(`QNH: failed to fetch cookie from alfred (${(e as Error).message}). Host switched, cookie left empty.`);
        }

        // write qnh-host / qnh-cookie into the `qnh` environment (visible & editable in settings.json).
        // VSCode requires updating the whole registered `environmentVariables` object — the dotted
        // `environmentVariables.qnh` sub-key is not a registered setting and cannot be written directly.
        const newVars: { [key: string]: string } = {
            [Constants.QnhHostVariableName]: host,
            [Constants.QnhCookieVariableName]: cookie,
        };
        const config = workspace.getConfiguration('rest-client');
        const inspect = config.inspect<{ [env: string]: { [key: string]: string } }>('environmentVariables');
        // write to the layer where environmentVariables is already configured, else Global
        const target = inspect?.workspaceValue !== undefined
            ? ConfigurationTarget.Workspace
            : ConfigurationTarget.Global;
        const base = (inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue ?? {}) as { [env: string]: { [key: string]: string } };
        const merged = { ...base, [Constants.QnhEnvironmentName]: newVars };
        await config.update('environmentVariables', merged, target);

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
