# 0002 探索 agent 重做：先查索引，再让模型判断，代码把关

状态：草案（2026-11-25）

## 背景

探索由需求触发（见 GLOSSARY「需求」「探索」）：API 调用方查某部媒体，发现它在某组命名空间里缺记录，
就记一条需求。例如豆瓣条目还没有 TMDB 编号（目录组），或者某一季还没有任何视频平台的合集（平台组）。

现有实现（`packages/core/src/exploration-scheduler.ts`、`exploration-agent.ts`）的问题：

- **覆盖面窄**：只有哔哩哔哩、爱奇艺两个适配器能搜索（Tier 3），腾讯视频、优酷、芒果 TV 从不被探索。
  目录组没有任何 Tier 3 适配器，目录组需求永远不会被调度。
- **模型从零搜索**：模型拿片名去平台搜，再自己挑候选，默认模型（Workers AI Llama 3.3 70B）的工具调用不可靠。
- **只要提交就算满足**：变更单一提交，需求就标为已满足；之后被驳回，需求也不会重新打开。
- **共用一个 60 秒预算**：一个任务里的所有平台共用同一个截止时间，后面的平台容易超时，
  整条需求因此算作临时失败重跑，已成功的平台可能重复提交（未验证）。
- **官网浏览也记需求**：官网服务端经 `InternalApi` 读媒体时同样记需求，挤占探索预算。

参考了两个已有项目：

- [douban-bridge](https://github.com/baranwang/douban-bridge) 的 agent 匹配（豆瓣 → TMDB）。
  可取：候选封闭集合（模型不能编造 ID）、唯一的结论出口、首轮预填资料、租约加比较写入、
  把运行失败和「确实没有」分开。不可取：只凭模型自报置信度自动写入，补充核对可省略。
- [rex-widget](https://github.com/baranwang/rex-widget) 的 `scraper-kit` 和 TMDB 映射 agent。
  可取：通过 **360 影视索引**和**豆瓣「在哪看」**拿到各平台播放链接（不依赖被封的平台搜索），
  五个平台的分集接口、网址解析（含爱奇艺 `v_` 编号解码），以及「提交前必须实际拉过该合集分集」的证据门。

## 决定

### 1. 范围

只探索需求，不主动探索榜单或线索。需求只来自 API 调用方：官网经 `InternalApi` 的读取不再记需求。
两组都要覆盖：

- **平台组**：为某部媒体（某一季）找各视频平台上的合集，提交平台关联。
- **目录组**：为缺少权威目录编号的媒体找 TMDB 等编号（douban-bridge 做的事）。

### 2. 流程：发现 → 判断 → 把关

1. **发现（不调用模型）**：确定性地收集候选。
   - 平台组：豆瓣「在哪看」（豆瓣条目可经 IMDb 编号或已有豆瓣关联得到）、360 影视剧集级索引、
     能用的平台原生搜索（哔哩哔哩、爱奇艺、芒果 TV）。播放链接统一经适配器解析成合集 ID。
   - 目录组：IMDb 编号 → TMDB `/find`，TMDB、Trakt 搜索。
   - 所有候选登记进本任务的**候选集合**，模型只能从这里选。
2. **快速通道**：只有一个候选，且片名、年份、季、集数都对得上时，直接进入把关，不调用模型。
3. **判断（调用模型）**：其余情况交给模型。模型的工具只做查询和核对：
   `list_candidates`、`inspect_collection`（合集信息）、`list_episodes`（分集列表）、
   `probe_mapping`（按季、集范围、偏移抽查分集）、`get_catalog_season`（基准目录的季与集）。
   结束只能调用 `submit_mapping` 或 `mark_not_found`。
4. **把关（代码）**，依次：
   - 候选必须在候选集合里；
   - **证据门**：提交的每个合集和集范围，必须在本任务里被 `list_episodes` 或 `probe_mapping`
     实际拉过且返回了分集；
   - 再走现有取证关卡（`evidence-gate.ts`）。通过即自动生效，没通过转审核员。
   - 目录组编号额外要求身份链条：IMDb 编号一致，或片名、年份、导演三项都对得上。不接受只凭模型置信度写入。

### 2.1 目录组编号由 agent 直接写入

这是对 ADR 0001「整部媒体的权威目录编号只由同步或审核员维护」的补充。探索 agent 为媒体找到的
TMDB 等编号，过了上面的把关后直接写成外部编号（`is_external_id = true`），不经变更单：

- 新增来源 `source = "agent"`（迁移放宽 `associations.source` 的 `CHECK`），和 `sync`、`reviewer`、
  `submission` 区分开，审核员可以按来源筛查、回退。
- 只补空位：媒体在该命名空间已有外部编号时不覆盖，已锁定（`locked`）的更不动。编号已属于另一部媒体时
  不写入，改为提出审核告警（可能需要合并媒体）。
- 写入时同时记录取证内容（命中的身份链条、候选来源），供回溯。
- 不会把来自不同作品的编号拼到一起：IMDb、Trakt 等编号只取自同一个已核实的 TMDB 条目。

### 2.2 综艺

综艺也在第一版里。它和剧集的区别是平台按「期」排，而不是按集：同一期常拆成上、下两条，
另有加更、纯享、花絮；基准目录（TMDB）通常按播出日期一期一集。做法：

- **按播出日期对应**，不按集号。工具 `get_catalog_season` 返回每集的播出日期，`list_episodes`
  返回每期的日期和期号（复用 rex-widget 的 `parseVarietyEpisodeIdentity`，识别 第N期、上/下、加更）。
- **只认正片**：加更、纯享、花絮、预告不进映射（复用 rex-widget 的黑名单规则）。
- **一期拆成多条时**按非线性段（`nonLinear`）提交。
- **补强把关**：现有取证关卡遇到非线性段会跳过集数核对，只看季和年份
  （`evidence-gate.ts` 的 `hasTvNonLinearSegments` 分支），综艺照现状会几乎不设防地自动生效。
  所以证据门对综艺额外要求：抽查的每一期（至少首、中、末三期）都要在平台上找到播出日期相同的正片，
  任何一期对不上就不提交。
- 平台分集来源：腾讯「curated」综艺列表、芒果按月的 `variety/showlist`、优酷按 `stage` 排序的分页，
  以及 360 影视的 `episodeszongyi`。

### 3. 模型

经 AI Gateway 动态路由 `dynamic/cheap`（网关 `gateway`），用 Workers AI 绑定调用，
OpenAI chat completions 格式。配置：`AI_MODEL=dynamic/cheap`、`AI_GATEWAY_ID=gateway`。
每次调用带 `cf-aig-metadata`（需求 ID、任务 ID）以便在网关里追踪花费。

### 4. 抓取能力

从 rex-widget 移植到 `packages/core/src/adapters`，按现有适配器写法改写，不引入新依赖：

- 网址解析和合集编号（五个平台）；
- 分集列表：哔哩哔哩 `pgc/view/web/ep/list`、腾讯 `GetPageData`、爱奇艺签名 `base_info`、
  优酷 openapi `shows/videos`、芒果 `variety/showlist`；
- 发现源：360 影视 `api.so.360kan.com/index`、豆瓣 `rexxar movie/{id}` 的 `vendors`；
- 芒果搜索 `mobileso.bz.mgtv.com`。

不移植：弹幕、优酷 mtop 签名、人人视频。每个任务新建适配器实例，不共享可变的 cookie 和请求头。

### 5. 运行

- 先在 Cloudflare 上直接跑。逐个接口实测从 Workers 出口能否访问；不通的接口先不用。
  之后可以按命名空间接出站代理（`OUTBOUND_PROXY_CONFIG`），例如国内朋友的 Tailscale 出口节点。
- 每个平台单独计时、单独限步；任务内的平台按结果分别记账，已提交的平台不会因为别的平台失败而重跑。
- 需求在变更单**生效后**才标为已满足；变更单被驳回或被取证关卡打回时，需求回到待探索并退避。
- 每日预算按需求条数和模型花费双重限制。

### 5.1 出口实测（2026-11-26）

同一份探测脚本分别从开发机和 Cloudflare 边缘（`wrangler dev --remote`，机房 LAX）各跑一遍，
Cloudflare 上跑了两轮。每个接口只测了一个样本。

| 接口                                             | 开发机       | Cloudflare                          |
| ------------------------------------------------ | ------------ | ----------------------------------- |
| 360 影视搜索 `api.so.360kan.com/index`           | 通           | 通                                  |
| 豆瓣「在哪看」`rexxar movie/{id}`                | 通           | 通                                  |
| 豆瓣搜索 `rexxar search`                         | 通           | 通                                  |
| 豆瓣 IMDb→条目 `api.douban.com/v2/movie/imdb`    | 通           | 通                                  |
| 哔哩哔哩 合集、分集、搜索（`api.bilibili.com`）  | 通           | **HTTP 412，被拦**                  |
| 腾讯 分集 `GetPageData vsite_episode_list`       | 通           | 通                                  |
| 腾讯 搜索 `MbSearch`                             | `ret=20607`  | `ret=20607`                         |
| 爱奇艺 签名分集 `prelw/tvg/v2/lw/base_info`      | 通           | 通                                  |
| 爱奇艺 视频信息 `pcw-api`                        | 通           | 通                                  |
| 爱奇艺 搜索 `search.video.iqiyi.com/o`           | 通           | 通                                  |
| 优酷 openapi 分集、视频→剧                       | 通           | 通                                  |
| 优酷 搜索页 `so.youku.com`                       | 验证码       | 验证码                              |
| 芒果 搜索 `mobileso.bz.mgtv.com/msite/search/v2` | **HTTP 403** | HTTP 403                            |
| 芒果 分集 `episode/list`、`variety/showlist`     | 通           | 通（`variety/showlist` 第一轮超时） |

结论：

- **发现源都能用**：360 影视和豆瓣在 Cloudflare 上都通，不依赖平台搜索就能拿到候选，这条路线成立。
- **分集都能拿，除了哔哩哔哩**：腾讯、爱奇艺、优酷、芒果的分集接口在 Cloudflare 上都通。
- **哔哩哔哩按 IP 拦截 Cloudflare 出口**：同样的请求头开发机能通。这也意味着线上现有的哔哩哔哩适配器
  （探索搜索和人工提交的取证）从 Worker 发出时同样会失败，需要优先接出站代理。
- **平台搜索只剩爱奇艺**：腾讯、优酷、芒果的搜索在哪都不通（芒果这个接口 rex-widget 当时能用，现在开发机也 403）。
- Cloudflare 上延迟 1–5 秒，开发机 0.2–0.9 秒，单平台计时要按秒级留余量。
- 只测了 LAX 一个机房和每个接口一个样本；其他机房、优酷多集剧的分页、芒果按月分页都没测。

香港机器（绿云香港，Leaseweb HK 机房 IP，已在 Tailscale 网内）用 curl 跑同一份探测两轮：

- **哔哩哔哩在香港全通**（合集、分集、搜索，约 0.1 秒），说明 412 是针对 Cloudflare 出口，
  香港出口可以作为哔哩哔哩的出站代理。
- 其余结果和 Cloudflare 一致：腾讯、优酷、芒果的搜索照样不通，分集接口都通。
- 偶发失败：360 影视第一轮 11 秒超时、爱奇艺搜索第二轮连接失败、芒果 `variety/showlist`
  第一轮 15 秒超时，第二轮都恢复。豆瓣、360 影视从香港走反而比 Cloudflare 慢（2–13 秒）。
- 所以代理只给需要的命名空间配（目前只有 `bilibili`），其余继续从 Cloudflare 直连；所有抓取都要带超时和重试。

### 5.2 香港出站代理（已上线基础设施，2026-11-26）

- 隧道按机器命名为 `greencloud-hk`（原 `media-ref-db-hk` 改名，编号不变），cloudflared 单独一个 stack
  `/opt/stacks/greencloud-hk-tunnel`，以外部网络接入各服务的网络。
- 代理是单独的 Caddy 容器（`/opt/stacks/egress-proxy`），只在 `greencloud-egress` 网络上，不映射端口。
  调用方用 `x-egress-host` 指定目标域名，代理以 HTTPS 转发；拒绝 IP 字面量、单段名和内网后缀。
- Cloudflare 侧是 HTTP 类型的 VPC 服务 `greencloud-hk-egress`，Worker 以 `EGRESS` 绑定使用。
  `OUTBOUND_PROXY_CONFIG` 里设 `{"bilibili":{"mode":"egress"}}` 的命名空间走它，重定向在代码里逐跳经代理跟随。
- 部署用的 build token 需要 Connectivity Directory Bind 权限才能发布带 VPC 绑定的版本。

### 6. 评测

用 douban-bridge 导入的映射和已确认的关联做标注集，离线重放「发现 → 判断 → 把关」，
记录命中率、误判率和每条花费。改提示词或换模型前先跑评测。

## 实施顺序

每步一个 PR；全程 `EXPLORATION_DAILY_BUDGET` 保持 `"0"`，评测结果确认后再开。

1. 需求生命周期：内部读取不记需求；提交后需求进入 `awaiting_review`，变更单生效才 `fulfilled`，
   全部被驳回则回到 `open` 并按未找到退避（`change_requests.demand_id` 关联）。
2. 发现源：360 影视、豆瓣「在哪看」、爱奇艺搜索 → 候选集合。
3. 新执行器（平台组）：快速通道、模型判断、证据门；调度器改为按发现源排平台。
4. 目录组，两类缺口：目录组需求现在要求同时有 TMDB 外部编号和已确认的豆瓣或 Bangumi 关联。
   - 缺 TMDB 外部编号：按 IMDb 编号查 TMDB `/find`，同类型恰好一条且该条目的 IMDb 编号一致才写入，
     `source = "agent"`，只补空位；TVDB、Trakt 只取自同一条目。编号已属另一部媒体时不写，提审核告警
     `agent_external_id_conflict`。第一版只用 IMDb 链条，没有 IMDb 编号的媒体先不处理。
   - 缺豆瓣关联：经豆瓣 IMDb 接口找条目作为候选，走和平台相同的拉取、快速通道、模型判断和变更单。
     Bangumi 还没有候选来源，暂不探索。
5. 综艺：默认 1:1 映射对不上时，取 TMDB 该季每集播出日期，和平台正片（去掉加更、纯享、花絮、预告等）的日期比对，
   允许相差一天。首、中、末三期都对上且整体至少八成对上，才能以整季非线性段提交（只关联到合集，不精确到集）；
   只有一个候选时直接提交，模型提交非线性段也必须过这道检查（`NONLINEAR_NEEDS_AIR_DATE_EVIDENCE`）。
   人工提交的非线性段仍按现有取证关卡处理，没有加日期核对。
6. 评测，确认后开启。

## 后果

- 新增五个平台的分集和网址解析能力，也会让人工提交的取证更准。
- 依赖多个非官方接口和写死的密钥，随时可能失效，需要出站探测和告警。
- 自动生效依赖证据门和取证关卡的严格程度，评测集是放宽或收紧规则的依据。
