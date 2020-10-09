import * as qs from "./query";
import { joinUrl, stripUndefined } from "./util";
import * as codec from 'purify-ts/Codec';
import { EitherAsync } from 'purify-ts/EitherAsync';
import { Left, Right, Either } from 'purify-ts/Either';

const OK_CODES = <const>[200, 201, 202, 203, 204];

export type RequestOpts = {
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string | undefined>;
} & Omit<RequestInit, "body" | "headers">;

type FetchRequestOpts = RequestOpts & {
    body?: string | FormData;
};

type JsonRequestOpts = RequestOpts & {
    body: object;
};

type BaseResponse = { headers: Headers };

export type ApiError<Y> = BaseResponse & { status: number; data: Y | undefined, error: true };

export type ApiResponse<T> = BaseResponse & { status: typeof OK_CODES[number]; data: T, error: false };

type MultipartRequestOpts = RequestOpts & {
    body: Record<string, string | Blob | undefined | any>;
};

export function runtime(defaults: RequestOpts) {
    async function fetchText(url: string, req?: FetchRequestOpts) {
        const { baseUrl, headers, fetch: customFetch, ...init } = {
            ...defaults,
            ...req,
        };
        const href = joinUrl(baseUrl, url);
        const res = await (customFetch || fetch)(href, {
            ...init,
            headers: stripUndefined({ ...defaults.headers, ...headers }),
        });
        let data;
        try {
            data = await res.text();
        } catch (err) {}

        return {
            status: res.status,
            contentType: res.headers.get("content-type"),
            headers: res.headers,
            data,
        };
    }

    function fetchJson<T, Y>(
        url: string,
        okParser: codec.Codec<T>,
        errParser: codec.Codec<Y>,
        req: FetchRequestOpts = {},
    ): EitherAsync<Error | ApiError<Y> | string, ApiResponse<T>> {
        return EitherAsync(async ({ liftEither, throwE }) => {
            let contentType, data, headers: Headers, status: number;

            try {
                ({ contentType, data, status, headers } = await fetchText(url, {
                    ...req,
                    headers: {
                        ...req.headers,
                        Accept: "application/json",
                    },
                }));
            } catch (e) {
                return throwE(e);
            }

            const okStatus = OK_CODES.find(s => s === status);
            if (okStatus == null) {
                const parsed: Either<string, Y | undefined> = errParser.decode(data);
                return liftEither(
                    Left({ status, data: parsed.orDefault(undefined), error: true, headers }),
                );
            }

            if (contentType && contentType.includes("application/json")) {
                const parsed = okParser.decode(data && JSON.parse(data));
                return liftEither(parsed.map(data => ({ status: okStatus, data, error: false, headers })));
            }
            return liftEither(okParser.decode(data).map(data => ({ status: okStatus, data, error: false, headers })));
        });
    }

    return {
        fetchText,
        fetchJson,

        json({ body, headers, ...req }: JsonRequestOpts) {
            return {
                ...req,
                body: JSON.stringify(body),
                headers: {
                    ...headers,
                    "Content-Type": "application/json",
                },
            };
        },

        form({ body, headers, ...req }: JsonRequestOpts) {
            return {
                ...req,
                body: qs.form(body),
                headers: {
                    ...headers,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            };
        },

        multipart({ body, ...req }: MultipartRequestOpts) {
            const data = new FormData();
            Object.entries(body).forEach(([name, value]) => {
                data.append(name, value);
            });
            return {
                ...req,
                body: data,
            };
        },
    };
}
