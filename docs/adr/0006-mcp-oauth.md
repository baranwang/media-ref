# 0006 MCP OAuth：授权即一把 API 密钥

状态：已采纳（2026-11-28）

## 背景

`/mcp` 的工具只是把调用转发给公开 RPC，鉴权、权限和限额都是 RPC 自己的。第一版只认 API 密钥（`Authorization: Bearer` 或 `X-API-Key`），用户要先去网站建密钥，再贴进 MCP 客户端。MCP 授权规范（2025-06-18、2026-07-28 两版）让客户端自己走 OAuth：收到 401 后读 `WWW-Authenticate` 里的受保护资源元数据，找到授权服务器，登记客户端，带 PKCE 跳转登录，换取令牌。

要求：令牌和 API 密钥是同一个主体，过同样的检查——读、上报、提交三种权限，按密钥和按用户的读限额，提交配额——没有绕过的路。

## 考虑过的做法

**Better Auth 的 OAuth 插件。** better-auth 1.7.27 已经去掉了 `mcp` 和 `oidcProvider` 插件，换成单独的 `@better-auth/oauth-provider`。它要新增 `oauthClient`、`oauthAccessToken`、`oauthRefreshToken`、`oauthConsent` 四张表，访问令牌还依赖 `jwt` 插件和 `jwks` 表。更大的问题是它发的令牌只带 `userId`，没有密钥 id：按密钥的读限额、用量统计、上报去重（`invalidation_reports.reporter_key_id`）、线索的 `reporter_key_id` 都需要另外造一个"伪密钥 id"，用户的 API 密钥页面也看不到、撤销不了这些授权。这等于在 API 密钥之外再养一套主体。

**访问令牌直接就是一把 API 密钥。** 换码时建一把密钥，把密钥本身当访问令牌发出去。下游一行不用改，但令牌是长期有效的明文密钥，和规范"访问令牌应短期有效"相反，泄露后只能靠用户手动删。

## 决定

自己实现一个很小的授权服务器（`apps/api/src/mcp-oauth.ts`），授权的落点是一把 API 密钥：

- **授权记录 = 一把 API 密钥。** 用户在同意页点"允许"、客户端换码时，在用户名下建一把名为「MCP: 客户端名」的密钥，权限由用户在授权页勾选决定（`read report` 总有；「提交变更单」默认跟着客户端是否请求 `submit`，用户可以勾上或取消），90 天后过期。密钥原文当场丢弃，从不出服务器。这把密钥出现在 API 密钥页面，用量照常统计，删掉它就撤销了授权。
- **访问令牌是指向这把密钥的签名令牌。** 形如 `mrat_<载荷>.<HMAC>`，载荷只有密钥 id、受众（`<API>/mcp`）和过期时间（1 小时），用 `AUTH_SECRET` 签名，不落库。RPC 鉴权（`requireApiKeyAuth`，`resolveKeyOrSession` 也经过它）认出前缀后验签，再按密钥 id 走和 API 密钥同一个 `verifyApiKey`：启用、过期、邮箱验证、权限一样检查，读限额按这把密钥的 id 计，提交配额按密钥和用户计。没有第二条路径。
- **受众只有 `/mcp`。** 只有 `/mcp` 转发出来的 RPC 请求带着解析令牌的函数（`ApiRequestRuntime.resolveMcpAccessToken`），直接打 RPC 端点的令牌一律 401。外部请求无法伪造这个标记，它只存在于进程内。
- **刷新令牌轮换。** 刷新令牌和授权码都存在 Better Auth 已有的 `verification` 表里（只存哈希），读取即删除，所以各只能用一次；每次刷新先确认那把密钥还在、还有效，再发新的一对。无需迁移。用过的刷新令牌会留下记录（`mcp-oauth:used:<哈希>` → 密钥 id）。同一个刷新令牌再被出示，说明它有副本在别人手里，于是删除那把授权密钥：新的刷新令牌和所有访问令牌一起失效（RFC 9700 §4.14.2）。
- **客户端登记两种都支持。** 2026-07-28 推荐的客户端元数据文档（`client_id` 是 https URL，服务器去取 JSON 并核对 `client_id` 和跳转地址），以及已弃用但 2025-06-18 客户端还在用的动态注册（RFC 7591）。动态注册无状态：`client_id` 是签过名的客户端名和跳转地址，不建表。
- **登录和同意页都在网站上。** 未登录时跳到网站 `/login?redirect=…`，登录后回到 API 的 `/oauth/authorize`。API 校验请求，然后把签名的请求载荷（绑定当前用户，10 分钟过期）交给网站的 `/oauth/consent`，由网站用站内组件显示；表单提交回 API，API 重新验签、核对会话。mediaref.org 和 api.mediaref.org 同站，SameSite=Lax 的会话 cookie 会随这次提交发送。授权页禁止被嵌入。出错时 API 也跳到这个页面，只带固定的错误码，网站不显示 URL 里的文字。授权和建密钥一样要求邮箱已验证。

### 与规范的对应

- 401 带 `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="read report"`；令牌无效或过期时加 `error="invalid_token"`。`/mcp` 在处理 MCP 消息前先校验凭证，这样过期令牌得到的是 HTTP 401（客户端据此刷新或重新登录），而不是工具错误。API 密钥无效时也一样。`mrat_` 令牌先在本地验签、看过期；预检走路由但跳过按 IP 的读限额（`ApiRequestRuntime.skipIpLimit`），这样一次工具调用只扣一份 IP 额度。
- 受保护资源元数据（RFC 9728）在根路径和 `/mcp` 路径下都有；授权服务器元数据（RFC 8414）声明 `code_challenge_methods_supported: ["S256"]`、`client_id_metadata_document_supported`、`authorization_response_iss_parameter_supported`，授权响应带 `iss`（RFC 9207）。
- 只接受 PKCE S256 和公开客户端（`token_endpoint_auth_method: none`）。`resource`（RFC 8707）可以是 `<API>/mcp` 或 API 源站，缺省时放行，兼容老客户端。
- 跳转地址精确匹配；回环地址允许任意端口（RFC 8252 §7.3）。用户点「允许」或「拒绝」之前的错误（`response_type`、PKCE、`resource`）只显示错误页，不跳回客户端：任何人都能登记任意 https 跳转地址，自动跳转就成了开放重定向。

### 刻意的偏差和取舍

- **跳转地址除了 https 和回环 http，还允许原生应用的私有 scheme**（如 `cursor://`，RFC 8252 §7.1）。规范写的是"只能 localhost 或 https"，但主流桌面客户端在用私有 scheme；PKCE 保护授权码，同意页会显示跳转目标。
- **客户端元数据文档不缓存**，每次打开授权页都取一次（5 秒超时、5 KB 上限、不跟随重定向）。只有已登录用户会触发抓取。
- **超权限不做 HTTP 层的升级授权。** 读令牌调提交类工具时，得到的是工具错误 `INSUFFICIENT_PERMISSIONS`（和 API 密钥一样），而不是 403 `insufficient_scope`；需要提交权限时，用户在授权页勾上「提交变更单」即可，不依赖客户端请求 `submit`（多数客户端照 401 里的 `scope="read report"` 申请）。
- **每次授权建一把新密钥。** 同一客户端重复授权会留下多把密钥，各自 90 天后过期，用户也可以在密钥页面删除。

## 后果

- 新增配置 `WEBSITE_URL`（默认 `https://mediaref.org`），签名依赖已有的 `AUTH_SECRET`。
- 网站登录页接受 `redirect` 参数，但只允许跳回 API 的 `/oauth/authorize`。
- 轮换 `AUTH_SECRET` 会让所有访问令牌、进行中的授权和动态注册的 `client_id` 失效。已有授权不受影响：客户端收到 401 后用刷新令牌换一个新签名的访问令牌即可；只有重新授权时才要重新登记。
