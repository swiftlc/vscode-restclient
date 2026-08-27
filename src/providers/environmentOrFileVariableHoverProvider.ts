import { CancellationToken, Hover, HoverProvider, MarkdownString, Position, TextDocument } from 'vscode';
import { EnvironmentVariableProvider } from '../utils/httpVariableProviders/environmentVariableProvider';
import { FileVariableProvider } from '../utils/httpVariableProviders/fileVariableProvider';
import { VariableUtility } from '../utils/variableUtility';

export class EnvironmentOrFileVariableHoverProvider implements HoverProvider {

    public async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        const wordRange = VariableUtility.getEnvironmentOrFileVariableReferenceNameRange(document, position);
        if (!wordRange) {
            return undefined;
        }

        const selectedVariableName = document.getText(wordRange);
        // {{@name}} is the jq -R escape syntax — strip the @ prefix to look up
        // the underlying file/environment variable for hover display.
        const lookupName = selectedVariableName.startsWith('@')
            ? selectedVariableName.slice(1)
            : selectedVariableName;

        if (await FileVariableProvider.Instance.has(lookupName, document)) {
            const { name, value, error, warning } = await FileVariableProvider.Instance.get(lookupName, document);
            if (!warning && !error) {
                const contents: MarkdownString[] = [new MarkdownString(value as string), new MarkdownString(`*File Variable* \`${name}\``)];
                return new Hover(contents, wordRange);
            }

            return undefined;
        }

        if (await EnvironmentVariableProvider.Instance.has(lookupName)) {
            const { name, value, error, warning } = await EnvironmentVariableProvider.Instance.get(lookupName);
            if (!warning && !error) {
                const contents: MarkdownString[] = [new MarkdownString(value as string), new MarkdownString(`*Environment Variable* \`${name}\``)];
                return new Hover(contents, wordRange);
            }
        }

        return undefined;
    }
}