import { languages, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { getCurrentTextDocument } from './workspaceUtility';

export class EnvironmentStatusEntry {
    private readonly environmentEntry: StatusBarItem;

    public constructor(environment: string) {
        this.environmentEntry = window.createStatusBarItem('environment', StatusBarAlignment.Right, 100);
        this.environmentEntry.command = 'rest-client.switch-environment';
        this.environmentEntry.text = environment;
        this.environmentEntry.tooltip = 'Switch REST Client Environment';
        this.environmentEntry.name = 'REST Client Environment';
        // start hidden; only show once a real environment is loaded
        this.environmentEntry.hide();

        window.onDidChangeActiveTextEditor(this.showHideStatusBar, this);
    }

    public dispose() {
        this.environmentEntry.dispose();
    }

    public update(environment: string) {
        this.environmentEntry.text = environment;
        // only show when a real environment is selected; stays hidden for
        // "No Environment" so the status bar doesn't flash on startup
        if (!environment || environment === 'No Environment') {
            this.environmentEntry.hide();
        } else {
            this.showHideStatusBar();
        }
    }

    private showHideStatusBar() {
        const document = getCurrentTextDocument();
        if (document && languages.match(['http', 'plaintext'], document)) {
            this.environmentEntry.show();
        } else {
            this.environmentEntry.hide();
        }
    }
}