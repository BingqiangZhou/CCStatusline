# 更新日志（Changelog）

> 中文版，与 [CHANGELOG.md](CHANGELOG.md)（英文）一一对应。发版时两个文件需同步更新；CI 的 Release 正文目前取自英文 `CHANGELOG.md`。

## 1.2.22 - 2026-06-15

- 内部优化：状态栏每次渲染现在只读、写一次共享缓存文件（原来每个字段各自 `loadCache`/`saveCache`，一次渲染约 4 次整读 + 4–6 次整写）。各字段改动同一个共享缓存对象并打脏标记，渲染结束时统一 `saveCache` 一次，且仅当确有变化时才写（空闲且无变化的渲染完全不写）。无用户可见行为变化；每渲染缓存 I/O 约 4 倍下降，跨项目写冲突的窗口也更小。

## 1.2.21 - 2026-06-15

- 修复了会话空闲（窗口保持打开、没有新对话）一段时间后 `speed` 字段变成 `--` 且一直不恢复的问题。根因：所有 Claude Code 项目共用同一个缓存文件（`~/.claude/glm-statusline-cache.json`），而每次状态栏渲染都用非原子方式覆写它；另一个项目并发写入时可能把文件写坏，导致下一次渲染 `loadCache` 读到 `{}`、丢失本会话的速度基线。由于速度的空闲分支为了保住基线**故意不重写缓存**，丢失的条目就一直是 `shown: null` → `--`，直到下一条消息（其它字段每次渲染都重写缓存，所以一个 tick 就恢复，唯独 speed 卡住）。现在缓存写入改为原子写（临时文件 + `rename`），且空闲分支在拿不到可用瞬时读数时回落到会话平均速度——只要有有效数据就不再卡在 `--`。
- 修复了 `output_tokens`（以及因此 `Speed`、`Avg`、会话 token 字段）被多算约 3.3 倍的问题。Claude Code 每个内容块（thinking / text / tool_use ……）写一行 transcript，且把完整 `message.usage` 贴在每一行上，之前逐行求和导致一条消息被算了好几遍。现在按 `message.id` 去重，每条消息只算一次。

## 1.2.20 - 2026-06-14

- 修复了 `/clear` 后 `speed` 字段的 `Avg`（平均速度）被压低的问题。`cost.total_api_duration_ms` 是 Claude Code 的进程级累加器，`/clear` 不会归零——新会话会继承上一会话累积的 API 时间，从而把绝对平均（`out / 总 API 耗时`）拖低，而 `current`（增量计算）不受影响。实测铁证：某个会话 transcript 跨度仅 357 秒，却上报了 1682 秒的 API 时间——是其自身墙钟的 4.7 倍，没有「带过来」的残留时间不可能成立。`Avg` 现在锚定在本会话首次观测的 tick——`(out - out0) / ((apiMs - apiMs0)/1000)`，`out0`/`apiMs0` 与速度基线一起种下、并在会话重置时刷新，让带过来的基线在分子分母里同时抵消。首 tick / 重置后那一帧还没有增量，回退到累计比值，不会裸 `--`。

## 1.2.19 - 2026-06-14

- 修复了 `/clear`（以及 `/compact`、会话恢复等切换）后 `speed` 字段在会话剩余时间里一直冻结在 `--` 的问题。切换瞬间可能让首次采样拿到一个陈旧的、更大的累计输出值（新 `session_id` 的 `transcript_path` 仍指向上一会话的 transcript），从而污染按会话缓存的速度基线——新会话不断增长的值永远超不过它。鉴于真实会话内累计输出只会增长，现在把「正值且小于缓存基线」视为明确的会话重置：基线从当前读数重新开始，`current` 回到 `--` 直到下一次真实增量。`> 0` 的判断避免在瞬时读取失败（transcript 读不出时返回 0）时误触发。

## 1.2.18 - 2026-06-13

- 默认布局从 `single` 改为 `grouped`：全新配置（不写 `layout` 键）现在直接渲染成分类多行（model/effort/speed · context/session/day/30d · plan/5h/mcp）。设 `"layout": "single"` 可切回单行布局。单行布局的其它行为不变。

## 1.2.17 - 2026-06-13

- 调整了分组布局的行序：`model` / `effort` / `speed` 现在是第 1 行，`context` / `session` / `day` / `30d` 居中，`plan` / `5h` / `mcp` 是最后一行。
- 新增 GitHub Actions workflow（`.github/workflows/release.yml`）：每次推送 `vX.Y.Z` 标签时，自动发布名为 `GLM StatusLine <版本>` 的 GitHub Release，正文取自 `CHANGELOG.md` 对应条目。
- README 新增「字段数据来源（每项怎么来的）」说明，按 GLM / Z.ai 监控 API、Claude Code 会话 JSON、本地 transcript 计算三类来源讲清每个字段。
- 新增 `CHANGELOG.zh.md`，中文版更新日志。

## 1.2.16 - 2026-06-13

- 优化了 `/glm-statusline:configure` 里单行 / 分组布局的切换提示：现在以单选样式（`[x] single` / `[ ] grouped`）展示，每个选项各带一行说明，与字段列表之间用空行分隔，输入提示改为 `l = layout`。README 的 configure 示例和相关 skill 文档同步更新。

## 1.2.15 - 2026-06-13

- 调整了分组布局的字段分行：第 1 行为 `plan` / `5h` / `mcp`；第 2 行为 `context` / `session` / `day` / `30d`；第 3 行为 `model` / `effort` / `speed`。（此前第 1 行是全部额度字段，第 2 行是对话相关字段，第 3 行只有 `model`。）单行默认布局不变。

## 1.2.14 - 2026-06-13

- 新增可选的 `grouped`（分组）布局，把状态栏按类别拆成多行：额度（`plan`、`5h`、`mcp`、`day`、`30d`）、当前对话（`context`、`effort`、`session`、`speed`）、模型（`model`）各占一行；某类别没选中任何字段时整行省略。每行内部仍按字段顺序排列，并各自按终端宽度换行。分组模式下 `speed` 并入「当前对话」行，不再独占末尾一行。通过 `/glm-statusline:configure`（按 `l`）或在配置文件里设 `"layout": "grouped"` 开启；默认仍是单行布局。

## 1.2.13 - 2026-06-13

- 升级了可选的 `speed` 字段：在专属行同时显示当前和会话平均输出速度 `Speed <当前> t/s · Avg <平均> t/s`。平均速度 = 累计输出 token ÷ 累计 API 耗时。当前值空闲时不再掉到 `0`，而是保持上次读数（仅首次测量前为 `--`）。同时修复了「有 API 耗时但还没有输出 token」时显示 `Avg 0 t/s` 的问题。

## 1.2.12 - 2026-06-13

- 新增可选的 `speed` 字段，显示当前输出速度（tokens/sec）：由 transcript 的输出 token 增量除以 `cost.total_api_duration_ms` 增量得到（用的是真实 API 时间，渲染之间的空闲不会被算进分母，不会虚高），按 `session_id` 缓存。首次为 `--`，空闲时保持上次读数，30 秒无新输出后衰减为 `0`。当 `cost.total_api_duration_ms` 不可用时，依次回退到 transcript 时间戳跨度、墙钟时间。通过 `/glm-statusline:configure` 开启，默认关闭。

## 1.2.11 - 2026-06-13

- 修复了进度条在某些情况下仍会闪成 `0%` 的问题。Claude Code 在会话切换（轮次之间、切换模型）时偶尔会发出字面量 `0` 的 `used_percentage`；此前的修复只在 `null` 读数时稳定。现在当该会话已缓存了真实值时，收到的 `0` 会被当作瞬态值并刻意不写入缓存，避免污染后续的 null 读数。会话最开始（尚无任何缓存值）收到真实的 `0` 仍会缓存并显示 `0%`，这样后续 null 读数保持 `0%` 而不是闪成 `--%`。

## 1.2.10 - 2026-06-13

- 在 MCP 状态栏字段里加入 MCP/tools 额度到期日期，以紧凑的 `@MM-DD`（如 `@06-14`）显示在进度条旁。GLM / Z.ai API 本就返回窗口到期时间，现在透出到状态栏（不可用时显示 `@--`）；`--plan-details` 显示 MCP 窗口的完整日期和时间。

## 1.2.9 - 2026-06-12

- 新增可选的 `effort` 字段，显示当前推理 effort 等级（`low` / `medium` / `high` / `xhigh` / `max`），读取自 Claude Code 的 `effort.level` statusline 输入（需 Claude Code v2.1.119+）。通过 `/glm-statusline:configure` 开启，默认关闭。
- 修复了会话早期和 `/compact` 之后进度条短暂闪成 `0%` 的问题。Claude Code 在这些时刻把 `used_percentage` 报成 `null`；现在进度条会按 `session_id` 缓存并保持上一次已知值，使其保持稳定，只在首次真实值到来前显示 `--%`，而非误导性的 `0%`。

## 1.2.8 - 2026-06-06

- 把进度条字符从部分块（▏▎▍▌▋▊▉）换成全宽渐变字符（░▒▓█），消除填充格与空格之间的可见缝隙。
- 每格现在有 4 级灰度（░ 空 → ▒ 中 → ▓ 深 → █ 满），共 24 步（约 4.17% 一级），视觉上无缝。

## 1.2.7 - 2026-06-06

- 把 `renderBar` 从 `Math.round` 改成 `Math.ceil`，让小百分比（如 4%）至少显示一格，而不是看上去全空。
- 引入部分块字符以获得更细的粒度（约 1.56% 一级），后在 1.2.8 被全宽渐变字符取代。

## 1.2.6 - 2026-06-04

- 把显示字段定义抽到 `lib/display-fields.js`，格式化工具抽到 `lib/statusline-format.js`。
- 新增 GLM / Z.ai API 响应测试样例（`test/fixtures/`）。
- 更新 README：在本地路径之外，加入 GitHub `owner/repo` 的 marketplace 安装方式。
- 更新插件构建指南文档。

## 1.2.5 - 2026-06-04

- 把默认状态栏字段改为 `5h`、`mcp`、`session`、`day`。

## 1.2.4 - 2026-06-04

- 把配置简化为无参数的交互式选择器 + 单一的 `display` 配置数组。
- 移除了参数式显示配置、字段别名、布尔显示开关、布局选择和可配置的进度条宽度。

## 1.2.3 - 2026-06-04

- 新增按字段边界自动换行，基于保守的终端宽度估算。

## 1.2.2 - 2026-06-04

- 新增安装完成提示，引导用户运行 `/glm-statusline:configure`。

## 1.2.1 - 2026-06-04

- 把无参数的 `/glm-statusline:configure` 改成交互式选择器，每次切换字段后保存并预览。

## 1.2.0 - 2026-06-04

- 把实时状态栏精简成一行：5H 额度/重置、Context、Session token。
- 通过 `/glm-statusline:configure` 和 `~/.claude/glm-statusline-config.json` 支持可配置的状态栏字段。
- 新增 `glm-statusline.js --preview` 以及安装/配置器的预览输出，让用户能立刻看到选中的字段。
- 新增 `/glm-statusline:plan-details`，展开显示 GLM Coding Plan 信息。
- 新增额度明细提取：已用/总量、重置时间、MCP 额度，以及 API 返回时的 weekly 额度。
- plan details 命令不包含 model、Context、Session token 明细。

## 1.1.2 - 2026-06-04

- 新增 `CHANGELOG.md` 跟踪插件发布。
- 新增 `GLM_STATUSLINE_CACHE_FILE`，用于测试和隔离运行，避免验证脚本把 mock API 条目写进用户真实的状态栏缓存。
- 清理了本地缓存工作流里的测试污染。
- 从仓库内容中移除了旧的个人笔记文档。

## 1.1.1 - 2026-06-04

- 安装器改为在 `~/.claude/glm-statusline-launcher.js` 写入一个稳定 launcher。
- 稳定 launcher 自动选择最新已安装的插件缓存版本，因此 `claude plugin update glm-statusline@bingqiangzhou-tools` 不再让 `statusLine.command` 钉在旧版本路径上。
- 保留对旧版「钉版本」命令和新版稳定 launcher 命令两种情况的卸载支持。

## 1.1.0 - 2026-06-04

- 用 `5H@HH:mm` 取代原来的当前时钟显示。
- `5H@HH:mm` 优先显示 5H 额度的 `nextResetTime`；该字段不可用时，显示最近一次成功的额度刷新时间。
- 把 `Mon` 改成 `30D`，更清楚地表示近 30 天 token 用量。
- 把 Day 和 30D 的 token 总量切换到 Zhipu/Z.ai 的 `/api/monitor/usage/model-usage` 接口。
- 移除对本地项目 transcript 的 Day/30D 用量扫描。
- 改进大数格式化，例如 `5.98B` 而非 `6B`。

## 1.0.0 - 2026-06-04

- GLM StatusLine 的初始 Claude Code 插件打包。
- 新增 install 和 uninstall skill。
- 新增 `bingqiangzhou-tools` 的 marketplace 清单。
- 新增验证脚本和插件构建文档。
