import { TextDocument } from 'vscode';
import { VariableType } from "../models/variableType";
import { EnvironmentVariableProvider } from './httpVariableProviders/environmentVariableProvider';
import { FileVariableProvider } from './httpVariableProviders/fileVariableProvider';
import { HttpVariableProvider } from './httpVariableProviders/httpVariableProvider';
import { RequestVariableProvider } from './httpVariableProviders/requestVariableProvider';
import { SystemVariableProvider } from './httpVariableProviders/systemVariableProvider';
import { getCurrentTextDocument } from './workspaceUtility';

export class VariableProcessor {

    private static readonly providers: [HttpVariableProvider, boolean][] = [
        [SystemVariableProvider.Instance, false],
        [RequestVariableProvider.Instance, true],
        [FileVariableProvider.Instance, true],
        [EnvironmentVariableProvider.Instance, true],
    ];

    public static async processRawRequest(request: string, resolvedVariables: Map<string, string> = new Map<string, string>()) {
        const variableReferenceRegex = /\{{2}(.+?)\}{2}/g;
        let result = '';
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        variable:
        while (match = variableReferenceRegex.exec(request)) {
            result += request.substring(lastIndex, match.index);
            lastIndex = variableReferenceRegex.lastIndex;
            const rawName = match[1].trim();
            // {{@name}} — like `jq -R`: JSON.stringify the value (add quotes +
            // escape all special chars) so it can be embedded as a JSON string.
            const escapeQuotes = rawName[0] === '@';
            const name = escapeQuotes ? rawName.slice(1) : rawName;
            const escapeValue = (v: string) => JSON.stringify(v);
            const document = getCurrentTextDocument();
            const context = { rawRequest: request, parsedRequest: result };
            for (const [provider, cacheable] of this.providers) {
                if (resolvedVariables.has(name)) {
                    let value = resolvedVariables.get(name)!;
                    if (escapeQuotes) { value = escapeValue(value); }
                    result += value;
                    continue variable;
                }
                if (await provider.has(name, document, context)) {
                    const { value, error, warning } = await provider.get(name, document, context);
                    if (!error && !warning) {
                        let resolved = value as string;
                        if (escapeQuotes) { resolved = escapeValue(resolved); }
                        if (cacheable) {
                            resolvedVariables.set(name, value as string);
                        }
                        result += resolved;
                        continue variable;
                    } else {
                        break;
                    }
                }
            }

            result += `{{${rawName}}}`;
        }
        result += request.substring(lastIndex);
        return result;
    }

    public static async getAllVariablesDefinitions(document: TextDocument): Promise<Map<string, VariableType[]>> {
        const [, [requestProvider], [fileProvider], [environmentProvider]] = this.providers;
        const requestVariables = await (requestProvider as RequestVariableProvider).getAll(document);
        const fileVariables = await (fileProvider as FileVariableProvider).getAll(document);
        const environmentVariables = await (environmentProvider as EnvironmentVariableProvider).getAll();

        const variableDefinitions = new Map<string, VariableType[]>();

        // Request variables in file
        requestVariables.forEach(({ name }) => {
            if (variableDefinitions.has(name)) {
                variableDefinitions.get(name)!.push(VariableType.Request);
            } else {
                variableDefinitions.set(name, [VariableType.Request]);
            }
        });

        // Normal file variables
        fileVariables.forEach(({ name }) => {
            if (variableDefinitions.has(name)) {
                variableDefinitions.get(name)!.push(VariableType.File);
            } else {
                variableDefinitions.set(name, [VariableType.File]);
            }
        });

        // Environment variables
        environmentVariables.forEach(({ name }) => {
            if (variableDefinitions.has(name)) {
                variableDefinitions.get(name)!.push(VariableType.Environment);
            } else {
                variableDefinitions.set(name, [VariableType.Environment]);
            }
        });

        return variableDefinitions;
    }
}