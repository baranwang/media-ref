# MediaRef 宪法

这份文件写的是项目的基本原则。ADR、GLOSSARY、代码和提示词与它冲突时，以它为准，并去改那一方。

## 一、维护者不介入运行

项目运行时，没有人参与。数据的写入、核对、改正、撤销，全部由 agent 和代码完成。

- **没有"等人处理"这一步。** 任何流程都必须自动走到终点：变更单只会以通过或驳回结束，需求只会以满足、没找到或稍后再试结束。不能设计"转人工"、"维持人工"、"等审核员"这样的状态，也不能指望有人去清队列。
- **拿不准就不写入。** agent 或代码拿不准时，驳回或不提交，再按退避规则稍后重试。宁可暂时缺一条关联，也不留下一条没人确认的关联。
- **维护者只改规则，不改数据。** 维护者的工作是改代码、配置和提示词，经 PR 合并、由 CI 部署。发现数据错了，要去修产生错误的规则，让 agent 自己纠正，或者让同类错误不再发生。直接改库只用于止损，而且必须留下修订记录，同时修掉对应的规则。
- **每一步都有上限。** agent 的步数、token、时间都有预算，用完就按上面的规则结束，不会挂起。
- **结论可追溯。** 每个结论都记下理由和证据，公开可查（例如探索动态页）。没有人工兜底，可追溯就是唯一的监督手段。

## 二、欢迎外部参与

项目接受外部的人和程序参与：API 调用方、提交变更单的贡献者、上报线索或失效的客户端。

- **外部输入是证据，不是决定。** 查询会留下需求，提交会成为变更单，上报会成为线索。它们都要经过同样的取证、证据门和审核 agent，结果由 agent 和代码决定。
- **没有人能绕过这一套，维护者的账号也不例外。** 账号角色只影响限额和能看到什么，不影响证据门。
- **"审核员"不是流程中的一环。** 审核页面只是一个查看入口；就算有人在上面操作，系统也不能依赖这种操作。
- **外部参与是加速，不是前提。** 没有任何外部参与，系统也要能靠探索 agent 自己运转。外部提供的线索和提交，只是让它找得更快、更准。

## 三、与现状不一致、待改的地方

截至 2026-11-27，变更单已由证据门和审核 agent 判定（ADR 0003 修订）。以下缺口仍在，拟议的处理方式见 [ADR 0004](docs/adr/0004-no-waiting-states.md)。

- **重复媒体**：探索发现外部编号已归另一部媒体时只记告警；只有审核员 RPC 会调用 `mergeMedia` 写入媒体重定向（`packages/core/src/exploration-agent.ts`、`packages/core/src/tmdb-sync.ts`、`apps/api/src/reviewer.ts`）。
- **审核员直接写入**：仍可锁定关联、覆盖或锁定外部编号、合并媒体、切换基准和关闭告警，前三项均不写修订记录（`apps/api/src/reviewer.ts`、`packages/core/src/conflict-resolution.ts`）。
- **锁没有期限**：关联和外部编号由审核员上锁、解锁；挑战锁定关联的变更单可以自动驳回，但锁和挑战告警没有自动收尾（`packages/core/src/conflict-resolution.ts`、`packages/core/src/media-service.ts`、`packages/core/src/evidence-job.ts`）。
- **锁定关联已下架**：平台明确找不到合集时，失效复查只记告警，关联仍是 `confirmed`（`packages/core/src/invalidation.ts` 的 `handleConfirmedNotFoundInTx`）。
- **TMDB 编号失效**：同步遇到 404 就记告警、跳过该媒体的本次刷新，没有自动查找替代编号（`packages/core/src/tmdb-sync.ts` 的 `tmdb_missing_or_merged` 分支）。
- **段的坐标待核对**：TMDB 季结构变化、合并媒体或切换基准都可能标记受影响的段，没有任务自动重算这些坐标（`packages/core/src/tmdb-sync.ts` 的 `segments_needs_review` 告警）。
- **种子取证失败**：种子保留为 `seed_unconfirmed` 并标记 `needs_review`，后续排队会跳过它（`packages/core/src/seeds.ts` 的 `markSeedEvidenceFailedInTx`、`enqueueSeedEvidenceChecksForMedia`）。
- **关联内容不符后的复查**：告警本身不会安排下次复查；没有新的失效上报，即使合集已经恢复，按集查询也可能一直降级（`packages/core/src/invalidation.ts`、`packages/client/src/resolve.ts`）。
