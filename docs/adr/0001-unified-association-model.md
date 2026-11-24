# 0001 统一关联模型：外部编号并入关联，命名空间按能力区分

状态：已采纳（2026-11-24）

## 背景

v1 把「某个外部 ID 属于某部媒体」拆成了两张表：

- `external_ids`：TMDB、IMDb、TVDB、Trakt 的整部媒体 ID。SQL `CHECK` 写死四个命名空间，
  `UNIQUE (media_id, namespace)`，没有段。IMDb 的季、集 ID（例如《进击的巨人》整剧 `tt2560140`
  和第 4 季第 1 集 `tt13624322`）无处可放。
- `associations`：五个平台加豆瓣、Bangumi，`CHECK` 同样写死；取证时拿到的合集标题和集数用完即弃，
  读接口只能返回裸的原生 ID。豆瓣把 TMDB 的一季拆成 N 个条目（`S1 E1–12`、`S1 E13–24` …）时，
  客户端分不清哪个条目是「最终季 Part.2」。

另外 `validateVariantSegments` 不允许整部媒体的关联（`segments: []`）与带段的关联共存。
这条规则对一个平台变体、对豆瓣这样的目录是对的，对 IMDb 这样的层级目录是错的。

## 决定

### 1. 只有一种记录：关联

`external_ids` 表删除，数据迁入 `associations`。外部编号不再是独立的实体，而是一条
`is_external_id = true` 的关联：**权威目录上代表整部媒体的那个条目**。它仍然：

- 每部媒体每个命名空间最多一条（部分唯一索引 `(media_id, namespace) where is_external_id`）；
- 在全库唯一（`(namespace, native_id) where is_external_id`），用于按外部键找到媒体；
- 不经过证据门，保留 `source`（`sync` / `reviewer` / `submission`）和 `locked`。

同一权威目录里的季、集条目是普通关联（`is_external_id = false`），带段，可以与外部编号共存。
它们只能经变更单提出（权威目录没有取证适配器，直接转审核员）；整部媒体的权威目录 ID 不接受变更单，
仍由同步或审核员维护。

读接口保持 v1 形状：外部编号只出现在 `MediaDocument.external_ids`，其余关联（含 IMDb 季、集条目）
出现在 `associations`。不把外部编号重复放进 `associations`，是为了不破坏现有客户端对
`associations` 的遍历和计数。按外部键查询时，先匹配外部编号；没有命中再匹配同一命名空间的季、集
关联（例如 `imdb:tt13624322` 命中第 1 季第 1 集，并返回 `matched_association_id`）。

存储层的内部查询同理：凡是遍历「关联」的地方都加 `is_external_id = false`，凡是处理外部编号的地方
都加 `is_external_id = true`。

### 2. 命名空间能力注册表

命名空间是否合法、属于哪一组、能做什么，由一张能力表决定，不再散落在 `CHECK` 和代码里的常量数组中：

| 能力                      | 含义                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `group`                   | `platform`（能播放）或 `catalog`（只收录）                                                    |
| `supportsVariants`        | 关联必须属于一个变体。目前只有平台                                                            |
| `allowHierarchicalScopes` | 同一媒体在该命名空间下，整部、整季、单集的关联可以层层嵌套共存                                |
| `verificationMode`        | `sync`：权威目录，ID 由上游同步或审核员写入，不过证据门；`evidence`：每条关联经变更单和证据门 |

| 命名空间                              | group    | supportsVariants | allowHierarchicalScopes | verificationMode |
| ------------------------------------- | -------- | ---------------- | ----------------------- | ---------------- |
| tencent, iqiyi, youku, bilibili, mgtv | platform | ✓                | ✗                       | evidence         |
| tmdb, imdb, tvdb, trakt               | catalog  | ✗                | ✓                       | sync             |
| douban, bangumi                       | catalog  | ✗                | ✗                       | evidence         |

代码里的唯一来源是 `@media-ref/client` 的 `NAMESPACE_CAPABILITIES`；`PLATFORM_NAMESPACES`、
`CATALOG_NAMESPACES`、`EXTERNAL_ID_NAMESPACES` 都由它派生。数据库里有同构的 `namespaces` 表，
`associations`、`change_requests`、`variants` 的命名空间列以外键指向它，取代原来写死的 `CHECK`。
「变体关联必须有 `variant_id`、目录关联不能有」由 `namespaces.supports_variants` 经复合外键约束
（`(namespace, has_variant)` → `namespaces (namespace, supports_variants)`）保证。

新增一个命名空间 = 在注册表和 `namespaces` 表各加一行，再写它的适配器。

### 3. 段的范围规则

所有命名空间都用同一套段表达覆盖范围：

| 范围     | 写法                                                                                          |
| -------- | --------------------------------------------------------------------------------------------- |
| 整部媒体 | `segments: []`                                                                                |
| 整季     | `{ season, episodeStart: 1, episodeEnd: null }`                                               |
| 季内拆分 | 多个条目各占一段，例如豆瓣三个条目：`S1 E1–12`、`S1 E13–24`、`S1 E25–36`，都指向 TMDB 第 1 季 |
| 跨季     | 一条关联带多段，每段一季                                                                      |
| 单集     | `episodeStart === episodeEnd`，例如 IMDb 单集                                                 |

重叠检查分两种：

- **互斥范围**（`allowHierarchicalScopes = false`：平台的每个变体、豆瓣、Bangumi）：同一变体或同一
  目录命名空间下的全部关联，段两两不重叠，整部媒体的关联不能和其他关联共存。季内拆分是互斥范围的
  合法情形，因为各段集号不重叠。
- **层级范围**（`allowHierarchicalScopes = true`：IMDb 等权威目录）：只要求每条关联内部的段不重叠；
  不同关联之间允许整部 ⊃ 整季 ⊃ 单集的嵌套。

跨媒体共享合集的规则（`validateSharedCollectionSegments`）不变。

### 4. 展示快照：条目标题与集数

`associations` 增加两个可空列 `title`、`episode_count`，保存合集或条目自己的标题（例如
「进击的巨人 最终季 Part.2」「三体 下篇」）和集数。来源只有两处：

- 变更单通过时，取证结果里的 `evidence.collection.title` / `featureEpisodeCount`；
- 上游同步（种子导入、合集重查）写入的同名字段。

它们是快照，不是审核内容：不进入版本历史，不参与证据门，提交者也不能直接写。新的取证结果会覆盖旧值。
读接口在 `Association.title` / `Association.episode_count` 中返回。

### 5. 媒体展示元数据的边界

`MediaSnapshot` 只保存坐标映射需要的骨架：`title`、`original_title`、`year`、`type`、`seasons`
（每季集数和首播年）。它决定基准和段的合法性，所以由库维护。

海报、简介、类型、片长、评分、演职员等展示元数据**不入库**，也不加到 proto。网站或客户端需要时，
用文档里的外部编号（通常是 `tmdb`）直接向 TMDB 取。理由：这些字段更新频繁、有版权和语言版本问题，
与「ID 对应关系」这一核心职责无关；入库只会带来同步负担。若以后确有需要，应作为独立的缓存层，
而不是 `MediaSnapshot` 的字段。

## 后果

- 正：一个查询覆盖所有外部引用；IMDb 层级 ID、豆瓣拆季都能表达；读接口能显示条目原生标题；
  新增命名空间不再需要改 SQL `CHECK`。
- 负：`associations` 多了只对权威目录有意义的 `is_external_id`、`source` 列；每个遍历关联的查询都要
  记得按 `is_external_id` 过滤；读接口仍保留 `external_ids` 与 `associations` 两个列表。
- 迁移 `0013_unified_associations` 不可无损回滚到拆表前的形状以外的数据：`down` 会把
  `is_external_id` 行搬回 `external_ids`，但权威目录的季、集关联会被丢弃。
