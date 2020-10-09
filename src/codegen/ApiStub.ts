/**
 * DO NOT MODIFY - This file has been generated using oazapfts.
 * See https://www.npmjs.com/package/oazapfts
 */

import * as Oazapfts from "oazapfts/lib/runtime";

import * as codec from 'purify-ts/Codec';
import { Right } from 'purify-ts/Either';

const isObject = (obj: unknown) => {
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
};

export const intersect = <T, U>(t: codec.Codec<T>, u: codec.Codec<U>): codec.Codec<T & U> =>
    codec.Codec.custom({
        decode: (input) => {
            const et = t.decode(input)
            if (et.isLeft()) {
                return et
            }

            const eu = u.decode(input)

            if (eu.isLeft()) {
                return eu
            }

            const valuet = et.extract() as T
            const valueu = eu.extract() as U

            return isObject(valuet) && isObject(valueu)
                ? Right(Object.assign(valuet, valueu))
                : Right(valueu as T & U)
        },
        encode: (x) => {
            const valuet = t.encode(x)
            const valueu = u.encode(x)

            return isObject(valuet) && isObject(valueu)
                ? Object.assign(valuet, valueu)
                : valueu
        },
    });

export const defaults: Oazapfts.RequestOpts = {
    baseUrl: "/",
};

const oazapfts = Oazapfts.runtime(defaults);

export function coerceToString(obj: Object | null | undefined): string {
    if (obj == null) return '';
    else if (typeof obj === 'string') return obj;
    return `${obj}`;
}

function maybeAddQuery(base: string, query: undefined | Record<string, number | boolean | string>) {
    const queryEntries = Object.entries({
        extended: true,
        no_role_name: true,
        no_course_in_assignment: true,
        ...query,
    });

    if (queryEntries.length > 0) {
        const params = queryEntries
            .reduce((acc, [key, value]) => {
                acc.append(key, coerceToString(value));
                return acc;
            }, new URLSearchParams())
            .toString();
        return `${base}?${params}`;
    }
    return base;
}
