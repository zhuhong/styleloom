# 技能库：把每次学习变成可积累的能力

风格圣经解决「这部参考片是什么样」，技能库解决「以后遇到类似镜头该怎么做」。
技能是跨项目复用的可执行方法，不是对某部片子的描述。

## 三层记忆

| 层 | 作用域 | 存什么 | 位置 |
| --- | --- | --- | --- |
| 风格圣经 | 项目 | 角色身份、场景、运镜语法、节奏、灯光、声音 | `data/projects/<id>/learning/styleBible.json` |
| 风格包 | 跨项目 | 某部参考片的完整风格圣经 + 引用素材 | `data/library/packs/<id>.json` |
| 技能 | 跨项目 | 可执行方法、H3 prompt fragment、证据、使用反馈 | `data/skills/<id>/` |

角色定妆照、场景照仍然属于某个参考片（风格包）；技能只沉淀「怎么拍、怎么写提示词、怎么避坑」。

## 技能结构

```
data/skills/<id>/
├── skill.json        # 机器可读：规则、证据、反馈、置信度、版本
├── SKILL.md          # 人/Agent 可读：何时用、怎么做、prompt fragment、证据、修订历史
└── evidence/         # 从参考片复制的关键帧（默认最多 2 张，项目删除后仍保留）
```

`skill.json` 核心字段：

```json
{
  "id": "camera-46a40acd",
  "name": "固定机位平视双人对话镜",
  "kind": "camera",
  "status": "candidate",
  "summaryZh": "对话戏全程锁死机位……",
  "instruction": "当场景核心是两人关系与言语交锋时……",
  "promptFragment": "locked-off static camera, eye-level medium two-shot ...",
  "applicableWhen": ["双人对话", "需要写实观察式质感"],
  "avoidWhen": ["动作、追逐等需要运动能量"],
  "tags": ["固定机位", "双人镜", "平视"],
  "evidence": [{ "projectId": "...", "shotIds": ["s01"], "image": "evidence/...jpg" }],
  "outcomes": [{ "rating": "good", "shotId": "s02", "notes": "推近幅度刚好" }],
  "confidence": 0.39,
  "version": 1,
  "revisions": [{ "version": 1, "change": "从参考片抽取", "confidence": 0.39 }]
}
```

一次好评后：`confidence` 0.79、`status` active、`outcomes` 增加 `good` 记录。

`kind`：`camera` / `lighting` / `color` / `composition` / `rhythm` / `prompt` / `sound` / `workflow` / `avoid`。

## 自动积累流程

```
study_reference_video
  → 切片 + 逐镜标注 + 风格圣经
  → extractSkillsFromStudy
      ├─ LLM 从风格圣经和逐镜观察里归纳 3-8 条可复用技能
      ├─ 与已有技能做标签/文本/prompt fragment 相似度匹配
      │    ├─ 相似 → 合并证据、标签、适用条件，版本 +1
      │    └─ 不相似 → 新建 candidate
      └─ 复制证据关键帧到技能目录
```

- 同一条技能被第二部、第三部参考片命中时会不断累积 `evidence`，置信度上升；证据 ≥ 3 个独立项目会自动 active。
- 学习失败不会影响已经生成的分镜和风格圣经；技能抽取失败会退回规则版（从运镜语法、灯光、节奏、避坑清单直接生成）。

## 置信度与升降级

```
confidence = 0.32
           + min(0.25, 0.07 × (证据项目数 - 1))
           + (好评 + 0.5×一般) / 总反馈 × 0.4
           + min(0.08, 使用次数 × 0.01)
```

- `candidate`：刚抽取，默认 0.32–0.5。
- `active`：至少 1 次好评，或 ≥3 个独立项目证据，或置信度 ≥0.6。
- `deprecated`：差评 ≥2 且差评多于好评+一般；或被 `merge_skills` 合并。
- 人工调用 `update_skill` 指定 `status` 后，`statusLocked` 会阻止自动升降级。

LLM 的自评 confidence 只用于候选排序，**不会**直接抬高置信度；必须靠独立证据或真实反馈。

## Agent 怎么用

1. 规划前 `search_skills`（中文关键词、kind 可选），命中后 `read_skill`。
2. 把技能的 `promptFragment` 写进 `shot.camera` / `lighting` / `action`，或直接用进 H3 提示词；只用在语义匹配的镜头，遵守 `avoidWhen`。
3. `plan_shots` 用 `skillIds` 记录采用了哪些技能；`generate_shot` 也会接收 `skillIds`。
4. 生成后问用户效果，`record_skill_outcome(good|mixed|bad, notes)` 更新统计。
5. 重复技能 `merge_skills`，规则不准 `update_skill` 改写，长期不用可改 `deprecated`。
6. 学习完成后 Agent 会汇报新增/合并了哪些技能。

## 手动维护

- 直接编辑 `data/skills/<id>/skill.json` 或 `SKILL.md` 也可以；改 JSON 后重启服务刷新缓存。
- 删除技能目录即彻底删除；建议用 `update_skill` 标记 `deprecated` 保留证据。
- 备份/迁移整个 `data/skills/` 目录即可；`evidence/` 已复制，不依赖原项目。
- `SKILL.md` 是给人看的摘要，真正进入 Agent 上下文的是 `skill.json` 字段。

## 当前限制

- 检索是词法匹配（标签、名称、文本、中文 bigram），不是向量检索；技能多到几百条后可换 embedding。
- 反馈只统计，不会自动改写规则；需要 Agent 根据 `outcomes.notes` 调 `update_skill`。
- 合并是「源并入目标」，不做双向自动聚类；重复提取时靠相似度阈值 0.52 自动合并。
- 证据图最多 2 张/技能，参考片段不复制。
- 角色/场景身份不进入全局技能库，避免跨项目串脸。

## 相关工具

| 工具 | 作用 |
| --- | --- |
| `search_skills` | 按关键词/kind 检索 |
| `read_skill` | 读完整规则与证据 |
| `extract_skills` | 手动从当前项目补跑抽取 |
| `record_skill_outcome` | 记录好/一般/差 |
| `update_skill` | 修正内容或状态 |
| `merge_skills` | 合并重复技能 |
