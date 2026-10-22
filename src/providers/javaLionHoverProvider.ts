import { CancellationToken, Hover, HoverProvider, MarkdownString, Position, Range, TextDocument } from 'vscode';
import { LionController } from '../controllers/lionController';
import { LionConfigItem } from '../utils/lionClient';

const StringLiteral = /"((?:[^"\\\n]|\\.)*)"/g;
const LionKeyLike = /^[A-Za-z0-9_.\-]{3,160}$/;
const MaxValueChars = 2000;

export class JavaLionHoverProvider implements HoverProvider {
    public constructor(private readonly controller: LionController) {
    }

    public async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        const literal = this.literalAt(document, position);
        this.controller.log(`hover ${document.uri.fsPath}:${position.line + 1} literal=${literal ? literal.text : '(none)'}`);
        if (!literal || !LionKeyLike.test(literal.text)) {
            return undefined;
        }
        const appKey = await this.controller.resolveAppKey(document.uri.fsPath);
        if (!appKey || token.isCancellationRequested) {
            return undefined;
        }
        let item: LionConfigItem | undefined;
        try {
            item = await this.controller.lookup(appKey, literal.text);
        } catch {
            return undefined;
        }
        if (!item || token.isCancellationRequested) {
            return undefined;
        }
        return new Hover(this.render(item, appKey), literal.range);
    }

    private literalAt(document: TextDocument, position: Position): { text: string, range: Range } | undefined {
        const line = document.lineAt(position.line).text;
        StringLiteral.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = StringLiteral.exec(line))) {
            const start = m.index;
            const end = start + m[0].length;
            if (position.character >= start && position.character <= end) {
                return { text: m[1], range: new Range(position.line, start, position.line, end) };
            }
        }
        return undefined;
    }

    private render(item: LionConfigItem, appKey: string): MarkdownString {
        const md = new MarkdownString();
        md.appendMarkdown(`**Lion** · \`${this.controller.currentEnv}\` · \`${appKey}\`\n\n`);
        md.appendMarkdown(`\`${item.name}\``);
        const meta = [item.type, item.rank].filter(Boolean).join(' · ');
        if (meta) {
            md.appendMarkdown(` — ${meta}`);
        }
        md.appendMarkdown('\n\n');

        let value = item.value;
        let lang = '';
        if (item.type === 'json') {
            try {
                value = JSON.stringify(JSON.parse(value), null, 2);
                lang = 'json';
            } catch {
                // keep raw
            }
        }
        const truncated = value.length > MaxValueChars;
        md.appendCodeblock(truncated ? value.slice(0, MaxValueChars) + '\n…' : (value || '(empty)'), lang);

        if (item.desc) {
            md.appendMarkdown('\n' + item.desc.split('\n').map(l => `> ${l}`).join('\n\n') + '\n');
        }
        if (item.modifyUser) {
            const when = item.modifyTime ? ` · ${new Date(item.modifyTime).toLocaleString()}` : '';
            md.appendMarkdown(`\n_modified by ${item.modifyUser}${when}_`);
        }
        return md;
    }
}
