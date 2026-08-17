import * as url from 'url';
import { CancellationToken, DocumentSymbolProvider, Location, Range, SymbolInformation, SymbolKind, TextDocument } from 'vscode';
import * as Constants from '../common/constants';
import { RequestParserFactory } from '../models/requestParserFactory';
import { Selector } from '../utils/selector';
import { VariableProcessor } from '../utils/variableProcessor';
import { getCurrentHttpFileName } from '../utils/workspaceUtility';

export class HttpDocumentSymbolProvider implements DocumentSymbolProvider {
    public async provideDocumentSymbols(document: TextDocument, token: CancellationToken): Promise<SymbolInformation[]> {
        const symbols: SymbolInformation[] = [];
        const lines: string[] = document.getText().split(Constants.LineSplitterRegex);
        const requestRange: [number, number][] = Selector.getRequestRanges(
            lines,
            { ignoreCommentLine: false , ignoreFileVariableDefinitionLine: false });

        for (let [blockStart, blockEnd] of requestRange) {
            // get real start for current requestRange
            let requestName: string | undefined;
            while (blockStart <= blockEnd) {
                const line = lines[blockStart];
                if (Selector.isEmptyLine(line) ||
                    Selector.isCommentLine(line)) {
                    if (Selector.isRequestVariableDefinitionLine(line)) {
                        requestName = Selector.getRequestVariableDefinitionName(line);
                    }
                    blockStart++;
                } else if (Selector.isFileVariableDefinitionLine(line)) {
                    const [name, container] = this.getFileVariableSymbolInfo(line);
                    symbols.push(
                        new SymbolInformation(
                            name,
                            SymbolKind.Variable,
                            container,
                            new Location(
                                document.uri,
                                new Range(blockStart, 0, blockStart, line.length))));
                    blockStart++;
                } else {
                    break;
                }
            }

            if (Selector.isResponseStatusLine(lines[blockStart])) {
                continue;
            }

            if (blockStart <= blockEnd) {
                // find the `### <title>` delimiter text preceding this block, if any
                let delimiterTitle: string | undefined;
                for (let i = blockStart - 1; i >= 0; i--) {
                    const prev = lines[i];
                    if (/^\s*#{3,}\s+.+/.test(prev)) {
                        delimiterTitle = prev.replace(/^\s*#{3,}\s+/, '').trim();
                        break;
                    }
                    if (!Selector.isCommentLine(prev) && !Selector.isEmptyLine(prev)) {
                        break;
                    }
                }
                const [name, container] = await this.getRequestSymbolInfo(lines[blockStart], requestName, delimiterTitle);
                symbols.push(
                    new SymbolInformation(
                        name,
                        SymbolKind.Method,
                        container,
                        new Location(
                            document.uri,
                            new Range(blockStart, 0, blockEnd, lines[blockEnd].length))));
            }
        }
        return symbols;
    }

    private getFileVariableSymbolInfo(line: string): [string, string] {
        const fileName = getCurrentHttpFileName();
        line = line.trim();
        return [line.substring(1, line.indexOf('=')).trim(), fileName!];
    }

    private async getRequestSymbolInfo(rawText: string, name: string | undefined, delimiterTitle?: string): Promise<[string, string]> {
        // For request with name, return the request name and file name instead
        if (name) {
            return [name, getCurrentHttpFileName()!];
        }

        const text = await VariableProcessor.processRawRequest(rawText);
        const parser = RequestParserFactory.createRequestParser(text);
        const request = await parser.parseHttpRequest();
        const parsedUrl = url.parse(request.url);
        const methodPath = `${request.method} ${parsedUrl.path || '/'}`;
        // show the `### <title>` as the container when present, else the host
        return [methodPath, delimiterTitle || parsedUrl.host || ''];
    }
}