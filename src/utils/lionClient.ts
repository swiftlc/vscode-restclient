import * as http from 'http';
import { URL } from 'url';

export type LionEnv = 'prod' | 'staging' | 'test';

export interface LionConfigItem {
    name: string;
    key: string;
    value: string;
    desc?: string;
    type?: string;
    rank?: string;
    modifyUser?: string;
    modifyTime?: number;
}

const LionHosts: { [env in LionEnv]: string } = {
    prod: 'https://lion.mws.sankuai.com',
    staging: 'https://lion.mws.sankuai.com',
    test: 'https://lion.mws-test.sankuai.com',
};

function postJson(proxyUrl: string, dest: string, body: any, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const u = new URL(proxyUrl);
        const req = http.request(u, {
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                'x-proxy-dest': dest,
            },
        }, res => {
            let text = '';
            res.on('data', chunk => text += chunk);
            res.on('end', () => {
                if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(text));
                } catch {
                    reject(new Error(`Invalid JSON: ${text.slice(0, 120)}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Request timeout')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/** Lion config lookup through the swiftlc proxy-server (see ~/.claude/skills/lion). */
export class LionClient {
    public constructor(private readonly proxyUrl: string) {
    }

    /** Exact lookup of a config by short name or full key; resolves undefined when not found. */
    public async findConfig(env: LionEnv, appKey: string, text: string): Promise<LionConfigItem | undefined> {
        const dest = `${LionHosts[env]}/mwsapi/v1/env/${env}/appKey/${appKey}/group/default/defaultConfigInstance/type/key/get`;
        const json = await postJson(this.proxyUrl, dest, {
            key: text, set: '', swimlane: '', grouptags: '', region: '', pageNum: 1, pageSize: 20,
            orderBy: '-modifyTime', tagIds: [], value: '', desc: '', createUser: '', modifyUser: '',
            rank: '', usage: null, modifyByVirtualUser: '', bizType: '',
        });
        if (json?.code !== 0) {
            throw new Error(json?.msg || json?.message || 'lion query failed');
        }
        const list: any[] = json?.data?.list ?? [];
        const hit = list.find(i => i?.name === text || i?.key === text);
        if (!hit) {
            return undefined;
        }
        return {
            name: String(hit.name ?? ''),
            key: String(hit.key ?? ''),
            value: hit.value === null || hit.value === undefined ? '' : String(hit.value),
            desc: hit.desc ? String(hit.desc) : undefined,
            type: hit.type ? String(hit.type) : undefined,
            rank: hit.rank ? String(hit.rank) : undefined,
            modifyUser: hit.modifyUser ? String(hit.modifyUser) : undefined,
            modifyTime: typeof hit.modifyTime === 'number' ? hit.modifyTime : undefined,
        };
    }
}
