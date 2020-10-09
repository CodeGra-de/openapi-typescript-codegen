import _ from "lodash";
import ts from "typescript";
import path from "path";
import { OpenAPIV3 } from "openapi-types";
import * as cg from "./tscodegen";
import generateServers, { defaultBaseUrl } from "./generateServers";
import { Opts } from ".";

const verbs = [
    "GET",
    "PUT",
    "POST",
    "DELETE",
    "OPTIONS",
    "HEAD",
    "PATCH",
    "TRACE",
];

const contentTypes = {
    "*/*": "json",
    "application/json": "json",
    "application/x-www-form-urlencoded": "form",
    "multipart/form-data": "multipart",
};

/**
 * Get the name of a formatter function for a given parameter.
 */
function getFormatter({ style, explode }: OpenAPIV3.ParameterObject) {
    if (style === "spaceDelimited") return "space";
    if (style === "pipeDelimited") return "pipe";
    if (style === "deepObject") return "deep";
    return explode ? "explode" : "form";
}

function getOperationIdentifier(id?: string) {
    if (!id) return;
    if (id.match(/[^\w\s]/)) return;
    id = id.replace(/[^_]+_/, '');
    id = _.camelCase(id);
    if (cg.isValidIdentifier(id)) return id;
}

/**
 * Create a method name for a given operation, either from its operationId or
 * the HTTP verb and path.
 */
export function getOperationName(
    verb: string,
    path: string,
    operationId?: string
) {
    const id = getOperationIdentifier(operationId);
    if (id) return id;
    path = path.replace(/\{(.+?)\}/, "by $1").replace(/\{(.+?)\}/, "and $1");
    return _.camelCase(`${verb} ${path}`);
}

function isNullable(schema: any) {
    return !!(schema && schema.nullable);
}

function isReference(obj: any): obj is OpenAPIV3.ReferenceObject {
    return obj && "$ref" in obj;
}

//See https://swagger.io/docs/specification/using-ref/
function getReference(spec: any, ref: string) {
    const path = ref
        .slice(2)
        .split("/")
        .map((s) => unescape(s.replace(/~1/g, "/").replace(/~0/g, "~")));

    const ret = _.get(spec, path);
    if (typeof ret === "undefined") {
        throw new Error(`Can't find ${path}`);
    }
    return ret;
}
/**
 * If the given object is a ReferenceObject, return the last part of its path.
 */
function getReferenceName(obj: any) {
    if (isReference(obj)) {
        return _.camelCase(obj.$ref.split("/").slice(-1)[0]);
    }
}

/**
 * Create a template string literal from the given OpenAPI urlTemplate.
 * Curly braces in the path are turned into identifier expressions,
 * which are read from the local scope during runtime.
 */
function createUrlExpression(path: string, qs?: ts.Expression) {
    const spans: Array<{ expression: ts.Expression; literal: string }> = [];
    // Use a replacer function to collect spans as a side effect:
    const head = path.replace(
        /(.*?)\{(.+?)\}(.*?)(?=\{|$)/g,
        (_substr, head, name, literal) => {
            const expression = _.camelCase(name);
            spans.push({
                expression: cg.createCall(
                    cg.toExpression('encodeURIComponent'), {
                    args: [
                        cg.createCall(cg.toExpression('coerceToString'), {
                            args: [ts.createIdentifier(expression)]
                        }),
                    ],
                }),
                literal,
            })
            return head;
        }
    );
    if (qs) {
        // add the query string as last span
        spans.push({ expression: qs, literal: "" });
    }
    return cg.createCall(cg.toExpression('maybeAddQuery'), {
        args: [cg.createTemplateString(head, spans), cg.toExpression('query')]
    });
}

/**
 * Create a call expression for one of the QS runtime functions.
 */
function callQsFunction(name: string, args: ts.Expression[]) {
    return cg.createCall(
        ts.createPropertyAccess(ts.createIdentifier("QS"), name),
        { args }
    );
}

/**
 * Create a call expression for one of the oazapfts runtime functions.
 */
function callOazapftsFunction(
    name: string,
    args: ts.Expression[],
    typeArgs?: ts.TypeNode[]
) {
    return cg.createCall(
        ts.createPropertyAccess(ts.createIdentifier("oazapfts"), name),
        { args, typeArgs }
    );
}

/**
 * Despite its name, OpenApi's `deepObject` serialization does not support
 * deeply nested objects. As a workaround we detect parameters that contain
 * square brackets and merge them into a single object.
 */
function supportDeepObjects(params: OpenAPIV3.ParameterObject[]) {
    const res: OpenAPIV3.ParameterObject[] = [];
    const merged: any = {};
    params.forEach((p) => {
        const m = /^(.+?)\[(.*?)\]/.exec(p.name);
        if (!m) {
            res.push(p);
            return;
        }
        const [, name, prop] = m;
        let obj = merged[name];
        if (!obj) {
            obj = merged[name] = {
                name,
                in: p.in,
                style: "deepObject",
                schema: {
                    type: "object",
                    properties: {},
                },
            };
            res.push(obj);
        }
        obj.schema.properties[prop] = p.schema;
    });
    return res;
}

/**
 * Main entry point that generates TypeScript code from a given API spec.
 */
export default function generateApi(spec: OpenAPIV3.Document, opts?: Opts) {
    const aliases: ts.TypeAliasDeclaration[] = [];

    function resolve<T>(obj: T | OpenAPIV3.ReferenceObject) {
        if (!isReference(obj)) return obj;
        const ref = obj.$ref;
        if (!ref.startsWith("#/")) {
            throw new Error(
                `External refs are not supported (${ref}). Make sure to call SwaggerParser.bundle() first.`
            );
        }
        return getReference(spec, ref) as T;
    }

    function resolveArray<T>(array?: Array<T | OpenAPIV3.ReferenceObject>) {
        return array ? array.map(resolve) : [];
    }

    function skip(tags?: string[]) {
        const excluded = tags && tags.some((t) => opts?.exclude?.includes(t));
        if (excluded) {
            return true;
        }
        if (opts?.include) {
            const included = tags && tags.some((t) => opts.include?.includes(t));
            return !included;
        }
        return false;
    }

    // Collect the types of all referenced schemas so we can expor them later
    const refs: Record<string, ts.Identifier> = {};

    // Keep track of already used type aliases
    const typeAliases: Record<string, boolean> = {};

    /**
     * Create a type alias for the schema referenced by the given ReferenceObject
     */
    function getRefAlias(obj: OpenAPIV3.ReferenceObject) {
        const { $ref } = obj;
        let ref = refs[$ref];
        const schema = resolve<OpenAPIV3.SchemaObject>(obj);
        const name = _.upperFirst(schema.title || $ref.replace(/.+\//, "")).replace(/\./g, '')

        if (!ref) {
            if (typeAliases[name]) {
                throw new Error(`Duplicate name detected: ${name}`)
            }

            ref = refs[$ref] = ts.createIdentifier(`Models.${name}`);

            const type = getTypeFromSchema(schema);
            aliases.push(
                ts.createVariableStatement(
                    [cg.modifier.export],
                    ts.createVariableDeclarationList([
                        ts.createVariableDeclaration(
                            name,
                            undefined,
                            type as any,
                        ),
                    ], ts.NodeFlags.Const),
                ) as any,
            );
            // aliases.push(
            //     ts.createTypeAliasDeclaration(
            //         undefined,
            //         [cg.modifier.export],
            //         ts.createIdentifier(name),
            //         undefined,
            //         ts.createTypeReferenceNode(
            //             ts.createIdentifier('codec.GetInterface'),
            //             [ts.createTypeQueryNode(ts.createIdentifier(name))],
            //         ),
            //     ),
            // );

            typeAliases[name] = true;

        } else if (!typeAliases[name]) {
            return cg.toExpression('codec.unknown');
        }

        return ref;
    }

    /**
     * Creates a type node from a given schema.
     * Delegates to getBaseTypeFromSchema internally and
     * optionally adds a union with null.
     */
    function getTypeFromSchema(
        schema?: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    ): any {
        const type = getBaseTypeFromSchema(schema);
        return isNullable(schema)
            ? cg.createCall('codec.maybe', { args: [type] })
            : type;
    }

    function getTSTypefromSchema(schema: any) {
        if (schema.type in cg.keywordType) return cg.keywordType[schema.type];
        if (schema.type === "integer") return cg.keywordType.number;
    }

    /**
     * This is the very core of the OpenAPI to TS conversion - it takes a
     * schema and returns the appropriate type.
     */
    function getBaseTypeFromSchema(
        schema?: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
    ): any {
        if (!schema) return cg.keywordType.any;
        if (isReference(schema)) {
            return getRefAlias(schema);
        }

        if (schema.oneOf) {
            // oneOf -> union
            return cg.createCall(
                'codec.oneOf',
                { args: [ts.createArrayLiteral(schema.oneOf.map(getTypeFromSchema), true)] },
            );
        }
        if (schema.anyOf) {
            // anyOf -> union
            return cg.createCall(
                'codec.oneOf',
                { args: [ts.createArrayLiteral(schema.anyOf.map(getTypeFromSchema), true)] },
            );
        }
        if (schema.allOf) {
            // allOf -> intersection
            if (schema.allOf.length === 0) {
                throw new Error('allOf of length 1 encountered');
            }
            let res = getTypeFromSchema(schema.allOf[0]);
            for (let i = 1; i < schema.allOf.length; i++) {
                res = cg.createCall(
                    'intersect',
                    { args: [res, getTypeFromSchema(schema.allOf[i])] },
                );
            }
            return res;
        }
        if ("items" in schema) {
            // items -> array
            // return ts.createArrayTypeNode(getTypeFromSchema(schema.items));
            return cg.createCall(
                'codec.array',
                { args: [getTypeFromSchema(schema.items)] },
            );
        }
        if (schema.properties || schema.additionalProperties) {
            // properties -> literal type
            return getTypeFromProperties(
                schema.properties || {},
                schema.required,
                schema.additionalProperties
            );
        }
        if (schema.enum) {
            // enum -> union of literal types
            let hasNull = false;
            const types = schema.enum.reduce((acc, s) => {
                if (s == null) {
                    hasNull = true;
                } else if (typeof s === 'boolean') {
                    acc.push(cg.createCall(
                        'codec.exactly',
                        { args: [s ? ts.createTrue() : ts.createFalse()] },
                    ));
                } else {
                    console.log(s);
                    acc.push(cg.createCall(
                        'codec.exactly',
                        { args: [ts.createStringLiteral(s)] }
                    ));
                }
                return acc;
            }, []);
            if (!types.length) {
                if (!hasNull) {
                    throw new Error('found empty enum');
                }
                return cg.toExpression('codec.nullType');
            }
            const inner = types.length > 1 ? cg.createCall('codec.oneOf', { args: [ts.createArrayLiteral(types, true)] }) : types[0];
            if (hasNull) {
                return cg.createCall(
                    'codec.maybe',
                    { args: [inner] },
                );
            }
            return inner;
        }
        if (schema.format == "binary") {
            // TODO
            return cg.toExpression('codec.string');
        }
        if (schema.type) {
            switch (schema.type) {
                case "integer":
                case "number": return cg.toExpression('codec.number');
                case "string": {
                    switch (schema.format) {
                        case 'date-time':
                            return cg.toExpression('codec.date');
                        default:
                            return cg.toExpression('codec.string');
                    }
                }
                case "null": return cg.toExpression('codec.nullType');
                case "boolean": return cg.toExpression('codec.boolean');
            }
        }

        return cg.toExpression('codec.unknown');
    }

    /**
     * Recursively creates a type literal with the given props.
     */
    function getTypeFromProperties(
        props: {
            [prop: string]: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
        },
        required?: string[],
        additionalProperties?:
            | boolean
            | OpenAPIV3.SchemaObject
            | OpenAPIV3.ReferenceObject
    ) {
        const members = Object.keys(props).map((name) => {
            const schema = props[name];
            const isRequired = required && required.includes(name);
            let val = getTypeFromSchema(schema);
            if (!isRequired) {
                val = cg.createCall('codec.optional', { args: [val] });
            }
            return ts.createPropertyAssignment(name, val);
        });
        let additional;
        if (additionalProperties) {
            additional = cg.createCall('codec.record', {
                args: [
                    cg.toExpression('codec.string'),
                    additionalProperties === true
                        ? cg.toExpression('codec.unknown')
                        : getTypeFromSchema(additionalProperties),
                ],
            });
        }
        if (members.length && additional) {
            return cg.createCall('intersection', {
                args: [
                    cg.createCall('codec.Codec.interface', {
                        args: [ts.createObjectLiteral(members)],
                    }),
                    additional,
                ],
            });
        }
        return additional || cg.createCall('codec.Codec.interface', {
            args: [ts.createObjectLiteral(members)],
        });
    }

    function getTypeFromResponses(responses: OpenAPIV3.ResponsesObject) {
        const all = Object.entries(responses).reduce((acc, [code, res]) => {
            const isOk = code === "default" || code.startsWith("2");

            const dataType = getTypeFromResponse(res);
            if (parseInt(code, 10) != 204) {
                const obj = (isOk ? acc.oks : acc.errs);
                if (obj.find(x => x === dataType) == null) {
                    obj.push(dataType);
                    obj.sort((a, b) => a.toString().length - b.toString().length);
                }
            }
            return acc;
        }, { oks: [] as any[], errs: [] as any[] });

        const transform = (opts: any[]) => {
            if (opts.length === 0) {
                return cg.createCall('codec.optional', { args: [cg.toExpression('codec.nullType')] });
            } else if (opts.length === 1) {
                return opts[0];
            } else {
                return cg.createCall('codec.oneOf', { args: [ts.createArrayLiteral(opts)] });
            }
        }

        return { oks: transform(all.oks), errs: transform(all.errs) };
    }

    function getTypeFromResponse(
        resOrRef: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject
    ) {
        const res = resolve(resOrRef);
        if (!res || !res.content) return cg.keywordType.void;
        return getTypeFromSchema(getSchemaFromContent(res.content));
    }

    function hasJsonContent(responses?: OpenAPIV3.ResponsesObject) {
        if (!responses) return false;
        return Object.values(responses)
            .map(resolve)
            .some(
                (res) =>
                    !!_.get(res, ["content", "application/json"]) ||
                    !!_.get(res, ["content", "*/*"])
            );
    }

    function getSchemaFromContent(content: any) {
        const contentType = Object.keys(contentTypes).find((t) => t in content);
        let schema;
        if (contentType) {
            schema = _.get(content, [contentType, "schema"]);
        }
        return (
            schema || {
                type: "string",
            }
        );
    }

    function wrapResult(ex: ts.Expression) {
        return opts?.optimistic ? callOazapftsFunction("ok", [ex]) : ex;
    }

    // Parse ApiStub.ts so that we don't have to generate everything manually
    const stub = cg.parseFile(
        path.resolve(__dirname, "../../src/codegen/ApiStub.ts")
    );

    const { initializer } = cg.findFirstVariableDeclaration(
        stub.statements,
        "defaults"
    );
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        throw new Error("No object literal: defaults");
    }

    cg.changePropertyValue(
        initializer,
        "baseUrl",
        ts.createStringLiteral(''),
    );

    // Collect class functions to be added...
    const functionsByTag: Record<string, ts.FunctionDeclaration[]> = {};

    // Keep track of names to detect duplicates
    const names: Record<string, Record<string, number>> = {};

    Object.keys(spec.paths).forEach((path) => {
        const item: OpenAPIV3.PathItemObject = spec.paths[path];
        Object.keys(resolve(item)).forEach((verb) => {
            const method = verb.toUpperCase();
            // skip summary/description/parameters etc...
            if (!verbs.includes(method)) return;

            const op: OpenAPIV3.OperationObject = (item as any)[verb];
            const {
                operationId,
                requestBody,
                responses,
                summary,
                description,
                tags,
            } = op;
            if (!tags) {
                throw new Error('No tags found!');
            }

            if (skip(tags)) {
                return;
            }

            let name = getOperationName(verb, path, operationId);
            if (!names[tags[0]]) {
                names[tags[0]] = {};
            }
            const count = (names[tags[0]][name] = (names[tags[0]][name] || 0) + 1);
            if (count > 1) {
                throw new Error('Duplicate name detected');
            }

            // merge item and op parameters
            const parameters = supportDeepObjects([
                ...resolveArray(item.parameters),
                ...resolveArray(op.parameters),
            ]);

            // split into required/optional
            const [required, optional] = _.partition(parameters, "required");

            // convert parameter names to argument names ...
            const argNames: any = {};
            parameters
                .map((p) => p.name)
                .sort((a, b) => a.length - b.length)
                .forEach((name) => {
                    // strip leading namespaces, eg. foo.name -> name
                    const stripped = _.camelCase(name.replace(/\./g, ''));
                    // keep the prefix if the stripped-down name is already taken
                    argNames[name] = stripped in argNames ? _.camelCase(name) : stripped;
                });

            // build the method signature - first all the required parameters
            const methodObjParam = required.reduce((acc, p) => {
                acc[argNames[resolve(p).name]] = {
                    type: getTSTypefromSchema(isReference(p) ? p : p.schema),
                    optional: false,
                };
                return acc;
            }, {} as Record<string, { type: any, optional: boolean }>);

            let body: any;
            let bodyVar;

            // add body if present
            if (requestBody) {
                body = resolve(requestBody);
                const schema = getSchemaFromContent(body.content);
                const type = getTypeFromSchema(schema);
                bodyVar = 'body';
                methodObjParam.body = {
                    type: ts.createTypeReferenceNode(
                        ts.createIdentifier('codec.GetInterface'),
                        [ts.createTypeQueryNode(type)],
                    ),
                    optional: false,
                };
            }

            const methodParams = [];
            if (Object.keys(methodObjParam).length > 0) {
                methodParams.push(cg.createParameter(
                    cg.createObjectBinding(Object.keys(methodObjParam).map(name => ({ name }))),
                    {
                        type: ts.createTypeLiteralNode(
                            Object.entries(methodObjParam).map(([name, { type, optional }]) => {
                                return cg.createPropertySignature({
                                    name,
                                    type,
                                    questionToken: optional,
                                });
                            }),
                        )
                    }
                ));
            }
            methodParams.push(cg.createParameter(
                cg.createObjectBinding([{ name: 'query' }, { name: 'opts' }]),
                {
                    type: ts.createTypeLiteralNode([
                        cg.createPropertySignature({
                            name: 'query',
                            type: ts.createTypeReferenceNode(
                                ts.createIdentifier("Record"),
                                [
                                    ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                                    ts.createUnionTypeNode([
                                        ts.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
                                        ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                                        ts.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                                    ]),
                                ],
                            ),
                            questionToken: true,
                        }),
                        cg.createPropertySignature({
                            name: 'opts',
                            type: ts.createTypeReferenceNode("Oazapfts.RequestOpts", undefined),
                            questionToken: true,
                        }),
                    ]),
                    questionToken: false,
                    initializer: ts.createObjectLiteral([]),
                },
            ))
            // add an object with all optional parameters
            if (optional.length) {
                methodParams.push(
                    cg.createParameter(
                        cg.createObjectBinding(
                            optional
                                .map(resolve)
                                .map(({ name }) => ({ name: argNames[name] }))
                        ),
                        {
                            initializer: ts.createObjectLiteral(),
                            type: ts.createTypeLiteralNode(
                                optional.map((p) =>
                                    cg.createPropertySignature({
                                        name: argNames[resolve(p).name],
                                        questionToken: true,
                                        type: getTypeFromSchema(isReference(p) ? p : p.schema),
                                    })
                                )
                            ),
                        }
                    )
                );
            }


            // Next, build the method body...
            const returnsJson = hasJsonContent(responses);
            const query = parameters.filter((p) => p.in === "query");
            const header = parameters
                .filter((p) => p.in === "header")
                .map((p) => p.name);

            const url = createUrlExpression(path);
            const init: ts.ObjectLiteralElementLike[] = [
                ts.createSpreadAssignment(ts.createIdentifier("opts")),
            ];

            if (method !== "GET") {
                init.push(
                    ts.createPropertyAssignment("method", ts.createStringLiteral(method))
                );
            }

            if (bodyVar) {
                init.push(
                    cg.createPropertyAssignment("body", ts.createIdentifier(bodyVar))
                );
            }

            if (header.length) {
                init.push(
                    ts.createPropertyAssignment(
                        "headers",
                        ts.createObjectLiteral(
                            [
                                ts.createSpreadAssignment(
                                    ts.createLogicalAnd(
                                        ts.createIdentifier("opts"),
                                        ts.createPropertyAccess(
                                            ts.createIdentifier("opts"),
                                            "headers"
                                        )
                                    )
                                ),
                                ...header.map((name) =>
                                    cg.createPropertyAssignment(
                                        name,
                                        ts.createIdentifier(argNames[name])
                                    )
                                ),
                            ],
                            true
                        )
                    )
                );
            }

            const args: ts.Expression[] = [url];


            const parsers = getTypeFromResponses(responses!);
            args.push(parsers.oks);
            args.push(parsers.errs);

            if (init.length) {
                const m = Object.entries(contentTypes).find(([type]) => {
                    return !!_.get(body, ["content", type]);
                });
                const initObj = ts.createObjectLiteral(init, true);
                args.push(m ? callOazapftsFunction(m[1], [initObj]) : initObj); // json, form, multipart
            }

            if (!functionsByTag[tags[0]]) {
                functionsByTag[tags[0]] = [];
            }
            functionsByTag[tags[0]].push(
                cg.addComment(
                    cg.createFunctionDeclaration(
                        name,
                        {
                            modifiers: [cg.modifier.export],
                        },
                        methodParams,
                        cg.block(
                            ts.createReturn(
                                wrapResult(
                                    callOazapftsFunction(
                                        returnsJson ? "fetchJson" : "fetchText",
                                        args,
                                    )
                                )
                            )
                        )
                    ),
                    summary || description
                )
            );
        });
    });

    const functions = Object
        .entries(functionsByTag)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, funs]) => {
            return ts.createModuleDeclaration(
                undefined,
                [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
                ts.createIdentifier(tag.replace(/ (.)/g, (_, c) => c.toUpperCase())),
                ts.createModuleBlock(funs),
                ts.NodeFlags.Namespace,
            );
        });

    stub.statements = cg.appendNodes(
        stub.statements,
        ...[ts.createModuleDeclaration(
            undefined,
            [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
            ts.createIdentifier('Models'),
            ts.createModuleBlock(aliases),
            ts.NodeFlags.Namespace,
        ), ...functions]
    );

    return stub;
}
