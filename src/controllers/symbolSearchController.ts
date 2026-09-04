import { CancellationTokenSource, Location, QuickPickItem, Selection, SymbolInformation, SymbolKind, TextEditorRevealType, window } from 'vscode';
import { HttpDocumentSymbolProvider } from '../providers/httpDocumentSymbolProvider';
import { trace } from '../utils/decorator';

export class SymbolSearchController {
    private readonly symbolProvider = new HttpDocumentSymbolProvider();

    @trace('Search Symbols')
    public async search() {
        const editor = window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'http') {
            return;
        }

        // reuse the outline provider so title/subtitle stay in one place
        const symbols = await this.symbolProvider.provideDocumentSymbols(editor.document, new CancellationTokenSource().token);
        const itemPickList = symbols.map(symbol => this.toQuickPickItem(symbol));
        if (itemPickList.length === 0) {
            window.showInformationMessage('No symbols are found in current file!');
            return;
        }

        const item = await window.showQuickPick(itemPickList, {
            placeHolder: 'Search by API path'
        });
        if (!item) {
            return;
        }

        const range = item.location.range;
        editor.selection = new Selection(range.start, range.start);
        editor.revealRange(range, TextEditorRevealType.InCenter);
    }

    private toQuickPickItem(symbol: SymbolInformation): QuickPickItem & { location: Location } {
        // variable symbols would only repeat the file name — no subtitle for them
        if (symbol.kind !== SymbolKind.Method) {
            return { label: symbol.name, description: '', location: symbol.location };
        }
        // swap the provider order: API path as the label, request title as the description;
        // when no `###`/`@name` exists the title falls back to the path — show it only once
        const { name: title, containerName: apiPath } = symbol;
        return {
            label: apiPath,
            description: title === apiPath ? '' : title,
            location: symbol.location
        };
    }

    public dispose() {
    }
}
