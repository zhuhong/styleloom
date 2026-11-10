# 示例：从参考片自动抽取的技能

> 由 `study_reference_video` 自动抽取（candidate，置信度 0.39），经过一次好评反馈后升级为 active（0.79）。

---
id: camera-46a40acd
name: 固定机位平视双人对话镜
kind: camera
status: active
confidence: 0.79
version: 1
tags: 固定机位, 双人镜, 平视, 中景, 写实
updatedAt: 2026-11-10T02:38:31.062Z
---

# 固定机位平视双人对话镜

对话场景用完全静止的平视中景双人镜，把张力交给表演与光线。

## 何时使用
- 两人对话、谈判或对峙场景
- 情绪靠表演而非动作推进
- 同一空间内需要切多个镜头
- 写实观察式风格

## 避免使用
- 动作戏或追逐段落
- 需要强主观视角代入
- 单人对白或独白

## 执行规则
当场景核心是两人之间的言语博弈而非动作时，用三脚架锁死机位：平视、中景双人、35-50mm 等效镜头、中等景深。整场不推不摇不移不变焦，画面内运动只来自人物手势、姿态与视线。同场景的多个镜头保持同一机位高度与焦段，仅靠表演与光线区分情绪。若需强调某句台词，用镜头时长与构图距离解决，绝不加运镜。

## H3 prompt fragment
```text
locked-off static camera, eye-level medium two-shot, 35-50mm equivalent lens, medium depth of field, no pan, no tilt, no zoom, no dolly, subject motion only, steady observational framing
```

## 证据
- 参考片学习示例-办公室对话（20261110-参考片学习示例-办公室对话-26a2）镜头 s01 · videocopy-ref12.mp4
  ![evidence](evidence/20261110-参考片学习示例-办公室对话-26a2-s01.jpg)
- 参考片学习示例-办公室对话（20261110-参考片学习示例-办公室对话-26a2）镜头 s02 · videocopy-ref12.mp4
  ![evidence](evidence/20261110-参考片学习示例-办公室对话-26a2-s02.jpg)

## 使用与反馈
- 使用 0 次，阅读 1 次
- 好评 1 / 一般 0 / 差评 0
- 2026-11-10 good · s02：固定机位让对话张力落在表演上，有效

## 修订历史
- v1 · 2026-11-10 · 从参考片抽取（置信度 0.39）
