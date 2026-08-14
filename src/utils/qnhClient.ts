import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface QnhSwimlaneItem {
    title: string;
    value: string;
    description?: string;
}

function requestJson(url: string, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.on('error', reject);
    });
}

/**
 * Thin HTTP client for the local alfred proxy-server.
 *
 * Used by {@link QnhController} to:
 *  - query the swimlane dictionary: `GET {baseUrl}/dictionaries?categoryKey=swimlane`
 *  - grab Chrome cookies for a host:  `GET {baseUrl}/api/qnh/cookie?host={host}`
 */
export class QnhClient {
    constructor(private readonly baseUrl: string) {
    }

    public async fetchSwimlanes(): Promise<QnhSwimlaneItem[]> {
        const url = `${this.baseUrl}/dictionaries?categoryKey=swimlane`;
        const json = await requestJson(url);
        // alfred returns { code, msg, data: [...] } or { data: { list, total } }
        const rows: any[] = Array.isArray(json?.data)
            ? json.data
            : (json?.data?.list ?? []);
        return rows
            .map(r => ({
                title: String(r?.title ?? r?.value ?? ''),
                value: String(r?.value ?? ''),
                description: r?.description ? String(r.description) : undefined,
            }))
            .filter((item: QnhSwimlaneItem) => item.value);
    }

    public async fetchCookie(host: string): Promise<string> {
        const url = `${this.baseUrl}/api/qnh/cookie?host=${encodeURIComponent(host)}`;
        const json = await requestJson(url);
        return json?.cookie ? String(json.cookie) : '';
    }
}
