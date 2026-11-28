import {
  fromJson,
  ScalarType,
  toJson,
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescMethodUnary,
  type DescService,
  type JsonValue,
} from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { ConnectError } from "@connectrpc/connect";
import { createMediaRefTransport, extractConnectErrorInfo, proto } from "@media-ref/client";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { extractApiKeyFromHeaders } from "./api-keys.ts";
import { PROTO_DOCS } from "./gen/proto-docs.ts";

export const MCP_PATH = "/mcp";

const SERVER_INSTRUCTIONS = `MediaRef maps movies and TV shows to their pages on video platforms (tencent, iqiyi, youku, bilibili, mgtv), down to season and episode.
Each tool is one public MediaRef RPC (package mediaref.v1): its arguments are the request message and its result the response message, both in protobuf JSON (camelCase fields, enum values by name).
A MediaRef names a title by exactly one id, e.g. {"tmdb":{"type":"MEDIA_TYPE_TV","id":1429}}, {"imdb":"tt0944947"}, {"douban":"1292052"}, {"platform":{"platform":"PLATFORM_BILIBILI","nativeId":"ss34430"}} or {"mediaId":"<uuid>"}.
Errors carry MediaRef's business code. Writes are evidence that MediaRef's own checks approve or reject.`;

type JsonSchema = Record<string, unknown>;

/** The proto3 JSON mapping of a message, as JSON Schema. */
function messageSchema(message: DescMessage, path: readonly string[] = []): JsonSchema {
  // Well-known types have their own JSON forms; a recursive message ends in "any".
  if (message.typeName.startsWith("google.protobuf.") || path.includes(message.typeName)) {
    return {};
  }
  const inner = [...path, message.typeName];
  return {
    type: "object",
    properties: Object.fromEntries(
      message.fields.map((field) => [field.jsonName, fieldSchema(field, inner)]),
    ),
    additionalProperties: false,
  };
}

function scalarSchema(scalar: ScalarType): JsonSchema {
  switch (scalar) {
    case ScalarType.BOOL:
      return { type: "boolean" };
    case ScalarType.STRING:
      return { type: "string" };
    case ScalarType.BYTES:
      return { type: "string", contentEncoding: "base64" };
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return { type: "number" };
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return { type: "string", pattern: "^-?[0-9]+$" };
    default:
      return { type: "integer" };
  }
}

function enumSchema(desc: DescEnum): JsonSchema {
  const documented = desc.values
    .map((value) => [value.name, PROTO_DOCS[`${desc.typeName}.${value.name}`]] as const)
    .filter(([, doc]) => doc);
  return {
    type: "string",
    enum: desc.values.map((value) => value.name),
    ...(documented.length > 0
      ? { description: documented.map(([name, doc]) => `${name}: ${doc}`).join(" ") }
      : {}),
  };
}

/** The proto comment on a field, else on its message or enum type. */
function fieldDoc(field: DescField): string | undefined {
  const type = field.message ?? field.enum;
  return (
    PROTO_DOCS[`${field.parent.typeName}.${field.name}`] ?? (type && PROTO_DOCS[type.typeName])
  );
}

function fieldSchema(field: DescField, path: readonly string[]): JsonSchema {
  const element = (kind: "scalar" | "enum" | "message"): JsonSchema =>
    kind === "scalar"
      ? scalarSchema(field.scalar!)
      : kind === "enum"
        ? enumSchema(field.enum!)
        : messageSchema(field.message!, path);
  const schema =
    field.fieldKind === "list"
      ? { type: "array", items: element(field.listKind) }
      : field.fieldKind === "map"
        ? { type: "object", additionalProperties: element(field.mapKind) }
        : element(field.fieldKind);
  const description = [
    fieldDoc(field),
    schema.description,
    field.oneof && `Set only one of: ${field.oneof.fields.map((f) => f.jsonName).join(", ")}.`,
  ].filter(Boolean);
  return description.length > 0 ? { ...schema, description: description.join(" ") } : schema;
}

/** Every unary RPC of the public package. `mediaref.internal.v1` lives in another module. */
const PUBLIC_METHODS = (Object.values(proto) as unknown[])
  .filter((value): value is DescService => (value as { kind?: unknown }).kind === "service")
  .flatMap((service) => service.methods)
  .filter((method): method is DescMethodUnary => method.methodKind === "unary")
  .map((method) => {
    const schema = messageSchema(method.input);
    return {
      method,
      name: method.name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase(),
      description:
        PROTO_DOCS[`${method.parent.typeName}.${method.name}`] ??
        `${method.parent.typeName}/${method.name}`,
      readOnly: method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS,
      // Arguments pass through untouched; fromJson in the handler is the strict check.
      inputSchema: {
        "~standard": {
          version: 1,
          vendor: "mediaref-proto",
          validate: (value: unknown) => ({ value: value as JsonValue }),
          jsonSchema: { input: () => schema, output: () => schema },
        },
      } as const,
    };
  });

function toolError(code: string, status: number, message: string, extra: object = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, status, message, ...extra }) }],
  } satisfies CallToolResult;
}

/**
 * One MCP server per HTTP request whose tools forward to the public RPCs. `fetch` sends each
 * RPC through the API Worker's own router, so the caller's API key gets the same auth,
 * permission and rate-limit checks as a direct RPC call.
 */
function createServer(
  apiKey: string,
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): McpServer {
  const transport = createMediaRefTransport({ apiKey, fetch, baseUrl: "https://mcp.internal" });
  const server = new McpServer(
    { name: "mediaref", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of PUBLIC_METHODS) {
    const { method } = tool;
    server.registerTool(
      tool.name,
      {
        title: method.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
      },
      async (args): Promise<CallToolResult> => {
        let input;
        try {
          input = fromJson(method.input, (args ?? {}) as JsonValue);
        } catch (error) {
          return toolError("INVALID_ARGUMENT", 400, (error as Error).message);
        }
        try {
          const res = await transport.unary(method, undefined, undefined, undefined, input);
          const text = JSON.stringify(toJson(method.output, res.message));
          return { content: [{ type: "text", text }] };
        } catch (error) {
          if (!(error instanceof ConnectError)) throw error;
          const { code, status, message, ...extra } = extractConnectErrorInfo(error);
          return toolError(code, status, message, extra);
        }
      },
    );
  }
  return server;
}

/**
 * Serves `/mcp`. `dispatch` hands a public RPC request to the API Worker's router; the MCP
 * caller's IP is copied onto it so per-IP read limits count MCP tool calls too.
 */
export async function handleMcpRequest(
  request: Request,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const apiKey = extractApiKeyFromHeaders(request.headers);
  if (!apiKey) {
    return Response.json(
      {
        code: "API_KEY_REQUIRED",
        message: "API key is required (Authorization: Bearer <key> or X-API-Key)",
      },
      { status: 401 },
    );
  }
  const ip = request.headers.get("cf-connecting-ip");
  const fetch = (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (ip) headers.set("cf-connecting-ip", ip);
    // connect-web asks for redirect "error", which workerd's Request rejects; nothing redirects here.
    return dispatch(new Request(input, { ...init, headers, redirect: "manual" }));
  };
  return createMcpHandler(() => createServer(apiKey, fetch)).fetch(request);
}
