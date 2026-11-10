---
id: prompt-97a6d517
name: 单镜头一致性锚点复述
kind: prompt
version: 1
source: public
tags: 提示词, 一致性, 锚点, 角色稳定, 场景复现
---

# 单镜头一致性锚点复述

把人物、服装、场景、构图、光线写成固定锚点串，每条提示词原样复述。

## 何时使用
- 同场景多段生成
- 需要角色外观稳定
- 单镜头分次出图

## 避免使用
- 每镜换装换景的叙事片

## 执行规则
单镜头或同场景多段生成时，先写一份锚点清单：人物外形、服装三件套、场景固定物（墙面/门/五金/地面/道具）、构图与机位、光线。每次生成把这份清单逐字复制进提示词，只改动作与姿态描述。锚点顺序保持一致，避免同义替换导致外观漂移。

## H3 prompt fragment
```text
consistency anchors repeated verbatim: same subject appearance, same three-piece wardrobe, same wall/door/floor/prop layout, static eye-level frontal full-body framing, soft low-contrast warm-neutral light
```

## 说明
本条目为公开技能，不含证据图与使用反馈（涉及第三方素材版权与个人使用数据）。
证据与置信度只在本机 `data/skills/<id>/` 中累积；如需查看原始证据，请在本机学习结果中检索。
