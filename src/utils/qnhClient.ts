import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { QnhIsLoginedPath, QnhIsLoginedQuery } from '../common/constants';

export interface QnhSwimlaneItem {
    title: string;
    value: string;
    description?: string;
}

export interface QnhLoginInfo {
    uid?: string;
    tenantId?: number;
    accountId?: number;
    accountName?: string;
    tenantName?: string;
    bizMode?: string;
    logined?: boolean;
}

interface RequestOptions {
    method?: string;
    headers?: { [key: string]: string };
    body?: string;
    timeoutMs?: number;
    /** allow non-2xx responses to be parsed (used for isLogined error bodies) */
    tolerateStatus?: boolean;
}

function request(url: string, options: RequestOptions = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const reqOptions: http.RequestOptions = {
            method: options.method || 'GET',
            headers: options.headers,
            timeout: options.timeoutMs ?? 10000,
        };
        // intra-network test hosts may carry self-signed certs
        if (lib === https) {
            (reqOptions as any).rejectUnauthorized = false;
        }
        const req = lib.request(url, reqOptions, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

async function requestJson(url: string, options: RequestOptions = {}): Promise<any> {
    const { status, body } = await request(url, options);
    if (!options.tolerateStatus && (status < 200 || status >= 300)) {
        throw new Error(`HTTP ${status}`);
    }
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`Invalid JSON response: ${body.slice(0, 200)}`);
    }
}

/**
 * Thin HTTP client for the local alfred proxy-server and the QNH hosts themselves.
 *
 * Used by {@link QnhController} to:
 *  - query the swimlane dictionary: `GET {baseUrl}/dictionaries?categoryKey=swimlane`
 *  - grab Chrome cookies for a host:  `GET {baseUrl}/api/qnh/cookie?host={host}`
 *  - validate the cookie + fetch tenant/user info: `POST https://{host}/api/v1/isLogined`
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

    /**
     * Validate the grabbed cookie against the QNH host and return the current
     * tenant/user info. Throws when the cookie is invalid/expired or the response
     * does not indicate a logged-in session.
     */
    public async fetchLoginInfo(host: string, cookie: string): Promise<QnhLoginInfo> {
        const url = `https://${host}${QnhIsLoginedPath}?${QnhIsLoginedQuery}`;
        // tolerate non-2xx so we can surface the server's own error message
        const json = await requestJson(url, {
            method: 'POST',
            tolerateStatus: true,
            headers: {
                'cookie': cookie,
                'content-type': 'application/json',
                'content-length': '0',
            },
        });
        if (!json || json.code !== 0 || !json.data) {
            throw new Error(json?.msg || 'login info unavailable');
        }
        if (!json.data.logined) {
            throw new Error('not logined (cookie invalid or expired)');
        }
        return json.data as QnhLoginInfo;
    }
}
