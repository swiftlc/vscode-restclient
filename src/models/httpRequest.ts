import { CancelableRequest, Response } from 'got';
import { Stream } from 'stream';
import { getContentType } from '../utils/misc';
import { RequestHeaders } from './base';

export class HttpRequest {
    public isCancelled: boolean;
    /**
     * Optional JSONPath configured via `# @response-jsonpath` to extract a part
     * of the response body for display. Set from request metadata by the
     * request controller; read by the response webview.
     */
    public responseJsonPath?: string;
    private _underlyingRequest: CancelableRequest<Response<Buffer>>;
    public constructor(
        public method: string,
        public url: string,
        public headers: RequestHeaders,
        public body?: string | Stream,
        public rawBody?: string,
        public name?: string) {
            this.method = method.toLocaleUpperCase();
            this.isCancelled = false;
    }

    public get contentType(): string | undefined {
        return getContentType(this.headers);
    }

    public setUnderlyingRequest(request: CancelableRequest<Response<Buffer>>): void {
        this._underlyingRequest = request;
    }

    public cancel(): void {
        if (!this.isCancelled) {
            this._underlyingRequest?.cancel();
            this.isCancelled = true;
        }
    }
}

export class HistoricalHttpRequest {
    public constructor(
        public method: string,
        public url: string,
        public headers: RequestHeaders,
        public body: string | undefined,
        public startTime: number) {
    }

    public static convertFromHttpRequest(httpRequest: HttpRequest, startTime: number = Date.now()): HistoricalHttpRequest {
        return new HistoricalHttpRequest(
            httpRequest.method,
            httpRequest.url,
            httpRequest.headers,
            httpRequest.rawBody,
            startTime
        );
    }
}