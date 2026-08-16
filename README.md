# dsh-mode-boost — 模式提升插件（实测驱动）

任务感知思维模式路由的**实测提升版**，宿主平面 bundle 插件：装配在**官方 preset 之上**，
无需 fork preset。全部改进来自 2026-08-15 官方 API 实测
（`deepseek-v4-flash`, `reasoning_effort=max`, n=2，日志见 `probe/results/flash-*.log`）。

## 实测依据（今日数据 vs 现售配置）

| 维度 | 现售 | mode-boost | 证据电池 |
|---|---|---|---|
| 多轮路由 @1536 | deep-guide 100% | 同（persona/引导文本不变式） | run-deep |
| 收敛 @1536 | 88% | **100%**（deep-persona） | run-deep deep-persona |
| 多轮路由 @1024 | BASE 69% | **88%**（boost 重分类） | run-boost |
| 相关链路由 @1024 | deep 50% / baseline 56% | **69%**（boost 措辞） | run-chain b-boost |
| 复杂任务深度经济 | 8.5 步 / 9.9k 字符 | **7.5 步 / 10.8k 字符**（有向深度引导） | run-efficiency b/c |
| 简单任务 | 3.5 步 / 6.5k 字符 | **1.0 步 / 1.2k 字符** | run-efficiency b |
| 胡思乱想率 | — | 0.0–0.4% | run-efficiency |

**A/B 同场对比（`probe/run-mode-boost-eval.mjs`，@1536 n=2，同一电池同一时段）**：

| 维度 | shipped 组合 | mode-boost 组合 | 增量 |
|---|---|---|---|
| 多轮交替 路由 | 10/16 (63%) | **15/16 (94%)** | **+31pp** |
| 多轮交替 收敛 | 10/16 (63%) | **14/16 (88%)** | **+25pp** |
| 相关链 路由 | 3/12 (25%) | **5/12 (42%)** | +17pp |
| 相关链 读连续性 | 2/12 (17%) | 1/12 (8%) | −9pp（读改问题仍开放，见论文 P21） |

文本与探针**单一事实源**：`lib/core.js` 同时被插件与 `probe/run-mode-boost-eval.mjs` 引用。

## 最低兼容（v0.1.1）

首轮分类依赖 DSH 主机的 `AssembleContext.messages`（`assembleContextFor(agent, signal, claimed)`
将本 step 已 claim、尚未落库的消息传入 `system-prompt/assemble`）。旧主机上首轮 assembly
记录 `host-incompatible` 并让位，首条消息落库后的后续轮次恢复全部行为；升级顺序应为
先升级 DSH 主机再装 v0.1.1。

## 安装（官方插件形态，三选一）

```powershell
# 运行时热装（免重启；推荐开发态）
dev_install_package <mode-boost 源目录>

# 官方装配（重启后由 bundles 接管）
dsh plugin --profile web add <解压目录或 tgz>

# 或直接装配仓库
dsh plugin --profile web add github:.../dsh-mode-boost
```

新会话选择官方 Standard preset 即生效（宿主平面 → 所有 preset 的会话受益）。

## 行为与激活策略（v0.1.1）

按会话的首条**真实用户消息**与 preset 面分派（活动日志可验证，`~/.dsh/mode-boost-activity.jsonl`）：

| 会话特征 | 动作 |
|---|---|
| 尚无任何真实用户消息（首轮 assembly 或诊断性裸 assemble） | **不判定**：原样返回，记录 `unclassified-no-user`（"没有消息"≠"寒暄"，缺失状态与空消息显式区分） |
| 首条消息是寒暄/无任务（你好/hello/短句无关键词） | **整体让位**：不换 persona、不过滤工具、不注入引导（实测：deep persona 套在聊天上 → 338 块长思维链，创造模式会话复盘 2026-08-15） |
| 编目含 `dev_router_status`（router-standard preset 行在场） | 整会话 no-op（不双重注入） |
| minimal 面（bash + str_replace_editor，无 read/write） | **只加引导**：保留 RL 完整 persona（`complete:true`）与工具面 |
| cordis/创造模式（persona 含 Cordis/Harness 信任指令） | **只加引导**：保留原 persona（双平面归属、禁改官方安装等关键指令） |
| standard / code(PTC) 面 | 全量：deep-persona 替换 + 首轮工具面收窄 + 引导注入 |

1. **首轮注入**（全量模式）：替换 persona section（保留 plan-mode section），首轮工具面收窄
   （spec read-first / react write-first / weak 写优先），首个工具调用后放行全目录。
   首条消息取**已落库的真实用户消息优先、`context.messages`（claimed）兜底**，恢复窗口
   （只有 pending `agent/inbox/spliced`、尚无 `user/message`）由官方 Inbox 投影统一覆盖。
2. **近场引导**（weak 模式会话，每条进入模型请求的真实用户消息一条固定文本，缓存中性）：
   在 `agent/pre-step` 瀑布注入（官方扩展点，可替换进入 step 的消息）：先 `await next()`，
   `reject` 原样返回；guide 消息**追加到 decision.messages 尾部**（顺序：claimed →
   runtime context/下游插件上下文 → mode-boost guide），随请求落库，满足 model-visible ⟺ logged。
   - 第 1-2 轮：分类引导；**第 3 轮起：boost 重分类**（"这是新任务，重新分类，勿沿用上轮风格"）；
     round 按"已落库真实用户消息数 + 当前 batch 内序号"计算；
   - 简单任务 → 快速收敛版（1 步零浪费）；复杂任务 → 有向深度版
     （架构/边界/集成点，不做环境猜疑；非 Flash 模型附决策闭环后缀）；
   - **exactly-once**：loop 对每个 claimed batch 只执行一次 pre-step，request retry 复用同一
     assembly，故纯消息转换即幂等，不依赖插件内状态；外层监听器 reject 时注入的 guide 随
     decision 一起被丢弃，不落库、不调用模型。
3. **deep-persona**：weak/Flash persona 内置"先深想再产出"（收敛 100%，persona 静态保缓存）。
4. **按模型自动匹配**：Pro → w6c（spec 句 + 分类指令）；Flash → w7 + 深度锚 + 回顾/反跑题锚。
5. **自优化工具**：`dev_mode_status` / `dev_mode_set` / `dev_mode_subagent`（与 router-standard
   行的 `dev_router_*` 并存不冲突；工具名刻意不同，编目信号零污染）。

## 共存与迁移

- **共存守卫（编目信号）**：首次 assembly 时若编目已含 `dev_router_status`（= router-standard
  preset 行已挂载）或存在 router-owned persona section → 本插件对该会话整体 no-op（不双重注入
  persona/引导）。自己的工具在守卫通过后**惰性注册**，保证信号不被自身污染。
  活动日志可验证：`$DSH_HOME/mode-boost-activity.jsonl`
  （apply / assemble inactive|chat-standdown|guide-only|first-turn|promoted|unclassified-no-user|host-incompatible / guide）。
- 迁移路径：删掉 `~/.dsh/.agent-presets/router-standard` fork 后，新会话由本插件全面接管。

## 测试

```sh
npm test   # node --test tests/core.test.js tests/plugin.integration.test.js tests/real-combo.test.js tests/loader-combo.test.js
```

- `real-combo.test.js`：把插件装入官方 LLM/session/system-prompt/tools/agent/agent-loop 组合，验证 guide 进入同一步的 `user/message` 与模型请求（需要仓库构建产物，从仓库根目录执行）。
- `loader-combo.test.js`：`npm pack` 打包产物安装进临时 node_modules，经 `dsh-app-boot` 的真实 Loader 从测试 `cordis.yml` 启动，覆盖发布清单（`cordis.patch.yml` 入包）与发布入口装配。

## 复现

```sh
node probe/run-mode-boost-eval.mjs --run --n 2 --model deepseek-v4-flash   # 插件 vs 现售 A/B
```

## License

MIT。
