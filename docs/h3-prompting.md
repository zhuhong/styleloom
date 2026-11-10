# H3 提示词速查

代码实现：`src/generate/prompt.ts`；校验：`validatePrompt`。

## 结构

### 基础模式（T2VA / I2VA / FL2VA / L2VA）

```
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

### 对齐句（逐字，必须是第一行，后跟一个空行）

I2VA：

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

FL2VA（`S.SS` 用两位小数，例如 `8.00`）：

```
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the S.SS-second mark of the target video.
```

L2VA：

```
How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the S.SS-second mark of the target video.
```

T2VA / Ref2VA 没有对齐句。

### Ref2VA（六段，顺序固定）

```
subject_definitions:
<Subject 1> is ...
<Picture 1> is ...
<Video 1> is ...

summary: [reference generation + synchronized audio] ...

retention_analysis:
<Subject 1>: fully_preserved
<Picture 1>: partially_preserved
<Video 1>: partially_preserved

detailed_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

- `<Video N>` 只表达整片/节奏关系；身份仍归 `<Subject N>`。参考视频里的人不能被写成主体定义。
- 保留标记：`fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`。
- 风格句放在 `[Shot 1]` 之前或描述开头，不单独成段。

## 写作要点

- 单镜头连续运动优先；切镜必须引入新信息，第二镜起用 `[Shot 2] At 00:03.500, ...`，时间严格递增。
- 运镜写「类型 + 幅度 + 速度 + 动机」，例如 `pushes in with small amplitude at slow speed toward her eyes`。
- 动作写因果链：意图 → 启动 → 接触/受力 → 惯性/次级运动 → 收势。
- 表情写可见微表情与视线目标，不写“很悲伤”。
- 灯光写主光方向/软硬/色温、补光、轮廓光、实际光源。
- 对白逐字保留：`(S1) says: <d>[Chinese] 原文</d>`；画外音要写嘴唇闭合。
- 画面文字用英文双引号原样保留。
- 不要堆“8K、电影感”；不要写与官方结构并列的 negative prompt 段落。
- 总长度 ≤ 7000 字符。超长时先删重复画质词与次要环境修饰，绝不删对齐句、对白、关键动作、参考职责。

## 校验清单

- [ ] 模式与素材职责正确
- [ ] 对齐句逐字正确（I2VA / FL2VA / L2VA）
- [ ] 第一镜无时间戳；后续切点递增且小于时长
- [ ] `subject_definitions` 每个标签都有定义，`retention_analysis` 覆盖所有标签
- [ ] 身份、服装、场景、左右关系连续
- [ ] 运镜不冲突，幅度/速度/动机齐全
- [ ] 光向、阴影、反射随动作变化
- [ ] 对白原文与语言标签正确
- [ ] `overall_soundscape` 与 `non_diegetic_music` 分工正确
- [ ] 长度 ≤ 7000

## 平台参数

- 时长：1–15 秒整数；H3 常规下限 4 秒。低于 4 秒时默认按 4 秒生成后本地裁剪；`experimentalDuration=true` 才直接请求短时长（2/3 秒档位以平台返回为准）。输出固定 1344×768（短边 768）。
- 文生/首尾帧：`minimax-h3-fl2va`；参考图/参考视频：`minimax-h3-ref2va`。
- 提示词已经是官方结构时，客户端发送 `enhance_prompt: false`，避免平台二次改写。
- 创建任务 → 轮询 `GET /v1/videos/{id}` → 下载 `/content`；轮询失败连续 5 次才放弃。
