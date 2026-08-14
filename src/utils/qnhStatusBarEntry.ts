import { languages, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { getCurrentTextDocument } from './workspaceUtility';

export class QnhStatusBarEntry {
    private readonly statusEntry: StatusBarItem;

    public constructor(environment: string) {
        this.statusEntry = window.createStatusBarItem('qnh-environment', StatusBarAlignment.Right, 99);
        this.statusEntry.command = 'rest-client.switch-qnh-environment';
        this.statusEntry.text = environment;
        this.statusEntry.tooltip = 'Switch QNH Environment (牵牛花)';
        this.statusEntry.name = 'REST Client QNH Environment';
        this.statusEntry.show();

        window.onDidChangeActiveTextEditor(this.showHideStatusBar, this);
    }

    public dispose() {
        this.statusEntry.dispose();
    }

    public update(environment: string) {
        this.statusEntry.text = environment;
    }

    public warn(environment: string) {
        this.statusEntry.text = `$(warning) ${environment}`;
    }

    private showHideStatusBar() {
        const document = getCurrentTextDocument();
        if (document && languages.match(['http', 'plaintext'], document)) {
            this.statusEntry.show();
        } else {
            this.statusEntry.hide();
        }
    }
}
