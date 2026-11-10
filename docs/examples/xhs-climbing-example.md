# 示例：120 秒攀岩参考片 → 9 秒同款竖屏镜头

用户给了一条 120 秒小红书攀岩穿搭视频，要求“做一个同款”。这条片实际包含攀岩长跟拍、T 恤热转印、品牌收尾等多种内容；本次只取**主攀爬段落**的视觉与运镜，不复刻人物身份、品牌与产品插入镜头。

## 参考片

- 链接：`https://www.xiaohongshu.com/explore/6af02c77000000001a025388`
- note id：`6af02c77000000001a025388`
- 标题：`穿的暖爬的软👀秋冬攀岩穿搭`
- 规格：120.12 秒 / 1440×2560 / HEVC + AAC
- 本地切片：16 镜，平均 7.5 秒；主攀爬段为 s09（34–63s）与 s11（65–110s）的长手持跟拍

## 学到的视觉配方

| 维度 | 参考片 |
| --- | --- |
| 人物 | 年轻女性，深色马尾，运动体型；浅蓝白横条纹长袖、黑色骑行短裤、黑色及膝袜、灰色攀岩鞋、白色镁粉袋、黑色运动表 |
| 场景 | 暖桦木胶合板抱石墙，密集钴蓝/红/橙/薄荷绿/黄/紫岩点，黑色线路标签，粉灰色厚地垫，深色裸露天花板与管道 |
| 光线 | 顶部柔和均匀环境光，中性偏冷约 5200K，桦木反弹出微暖，中低对比，无硬阴影 |
| 镜头 | 24–28mm 广角、深景深、低角度手持跟拍；随攀爬缓慢上摇/轻推，保留呼吸感 |
| 色彩 | 暖米色桦木 + 中性肤色打底，高饱和原色岩点做点缀 |
| 声音 | 馆内环境底噪、通风声、远处人声、鞋底与岩点摩擦、镁粉袋响、发力呼气；无配乐 |

## 本次的“同款”取舍

- **保留**：条纹长袖 + 黑短裤 + 黑及膝袜 + 攀岩鞋 + 镁粉袋的造型锚点；暖桦木墙 + 彩色岩点；低角度手持跟拍；真实环境声。
- **替换**：新角色（不复刻原片人物脸/身份）、新构图、新动作节拍。
- **舍弃**：原片的 T 恤热转印段落、品牌 logo、字幕、结尾黑底品牌卡；这些不属于“攀岩穿搭”的视觉核心。

## 参考图

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 人物定妆照 | `assets/stills/character-c1-2026-11-10T04-01-19.png` | 1152×2048 |
| 空场景照 | `assets/stills/location-l1-2026-11-10T04-01-36.png` | 1152×2048 |

人物定妆照用 OpenRouter `qwen/qwen-image-2.1-turbo` 生成，纯色背景、全身完整；场景照为空馆，无人物、无文字。

## 生成参数

- 模式：Ref2VA（`generationMode=ref2va`）
- 模型：`minimax-h3-ref2va`，task `ref2va`
- conditions：2 张 `role=reference`（人物 + 场景），无参考视频、无首尾帧
- 时长 / 画幅：9 秒 / 9:16，输出 768×1344，含音轨
- 生成耗时：约 248 秒（排队 + 推理）
- video_id：`video_1697c4f1-eff3-4369-a94c-900aab3bdbdc`

## VLM 自动质检（1s / 4s / 8s）

```json
{
  "match": "高度",
  "action": "三帧可清晰读出攀岩动作：1s 双手悬挂、重心偏左；4s 右手上移换点、左腿抬起踩紫色岩点；8s 双手撑住紫色岩点、左脚踩点、右腿下垂，重心转移与发力上移连贯可读",
  "identity": "脸型、黑色马尾、浅蓝白横条纹长袖、黑骑行短裤、黑及膝袜、灰攀岩鞋、白镁粉袋在三帧中保持一致，无明显漂移",
  "wall": "暖桦木墙、彩色岩点分布、粉灰地垫与参考空馆一致，三帧间岩点位置稳定，无跳变",
  "camera": "低角度竖屏手持跟拍，景别以中近景为主，随人物上移轻微仰拍跟随，符合预期机位",
  "anatomy": [
    "8s 右手手指与紫色岩点接触处略有融合、指节细节模糊",
    "4s 左手在橙色岩点附近的手部偏小、细节不足",
    "4s 右脚鞋与岩点接触边缘略软，但无明显穿模"
  ],
  "defects": [
    "岩点上的小品牌标签文字模糊不可辨",
    "4s 人物面部被手臂遮挡，属正常跟拍",
    "无明显多余人物、闪烁或裁切"
  ],
  "vs_reference": "与参考片的攀岩纪实感高度接近：真实馆内暖光、手持轻微晃动、服装与装备一致，动作节奏可信",
  "usable": true,
  "notes": "三帧动作连贯、身份与场景稳定，低角度手持跟拍符合预期，仅手部接触细节略有模糊，可用。"
}
```

结论：动作可读、身份与场景稳定、低角度手持跟拍成立；手部与岩点接触处仍有轻微模糊，属于当前 H3 的细节上限。

## 技能反馈

- 从这条参考片新抽取的 8 条技能中，5 条本次记为 `good` 并升为 active（0.80）：手持跟拍、低角度仰拍、广角深景深、顶部柔光、暖中性+彩色点缀。
- `rhythm-9c2be639`（长跟拍 + 短插入）记为 `mixed`（0.60）：本次只验证了长跟拍，没有做插入镜头。
- 复用的 `workflow-eb9591aa`（定妆照 + 场景照 Ref2VA）记为 `good`，置信度 0.81。

## 完整 Ref2VA 提示词

```text
subject_definitions:
<Subject 1> is one young adult East Asian woman, mid-20s, athletic build, dark brown hair in a messy low ponytail with loose strands, natural skin, calm focused expression, wearing a light blue-and-white horizontal striped long-sleeve top with a relaxed drop-shoulder fit, black fitted cycling shorts, black knee-high socks, grey climbing shoes dusted with white chalk, a small white drawstring chalk bag at her waist, and a black sports watch; her hands are chalked.
<Picture 1> is the reference still defining the identity, face, hair, body type and wardrobe of <Subject 1>.
<Picture 2> is the reference still defining the layout, materials, hold colors, mat and lighting of the location.

summary: [reference generation + synchronized audio] A low-angle handheld vertical sports documentary shot inside a real indoor bouldering gym: <Subject 1> hangs from two high holds on the pale plywood wall, reaches her right hand to a cobalt-blue hold, steps her left foot onto a purple volume, shifts her weight and pulls upward, flags her left leg for balance, then settles into a stable high step with her chest close to the wall, breathing visibly, while the camera slowly tilts up and pushes in with natural handheld jitter and synchronized gym room tone, shoe squeaks, chalk-bag rustle, fabric friction and one controlled exhale.

retention_analysis:
<Subject 1>: fully_preserved
<Picture 1>: partially_preserved
<Picture 2>: attribute_transfer

detailed_description: [Shot 1] Cinematic live-action vertical sports documentary inside a real indoor bouldering gym, 9:16 frame, warm birch plywood wall densely set with saturated primary-color resin holds, soft even overhead light, handheld wide-angle follow, natural skin and chalk texture, clean frame free of text and logos. The shot is one continuous handheld take lasting 9.00 seconds. <Subject 1> stays consistent in identity and wardrobe: messy dark low ponytail, athletic build, natural skin, light blue-and-white horizontal striped long-sleeve top, black fitted cycling shorts, black knee-high socks, grey chalk-dusted climbing shoes, white drawstring chalk bag, black sports watch. The environment remains exactly as defined by <Picture 2>, with pale birch plywood, dense cobalt blue, red, orange, mint, yellow and purple holds, black route tags, pinkish-grey padded mat and dark exposed ceiling truss. At 0.0–1.5 seconds she hangs from two high holds, chalked hands gripping, arms engaged, gaze lifted toward the next hold, ponytail and chalk bag settling; the camera sits low on the mat, below and slightly behind her left shoulder, 24–28mm equivalent, deep focus, framing both hands and feet with margin. At 1.5–3.5 seconds she reaches her right hand to a cobalt-blue hold, fingers closing on the resin, shoulder blade sliding, fabric pulling across her back; a rubber sole squeaks against a hold. At 3.5–5.0 seconds she steps her left foot onto a purple volume, weight transferring through the leg, chalk dust faintly releasing; the camera begins a slow reactive tilt up with a slight push-in, moderate amplitude, small natural handheld jitter, motivated by her upward movement. At 5.0–7.0 seconds she shifts her weight and pulls upward, left leg flagging out for balance, ponytail and chalk bag swaying, fabric friction audible against the wall; her expression stays calm and focused, eyes tracking the next hold. At 7.0–9.0 seconds she settles into a stable high step, chest close to the wall, breathing visibly with one controlled exhale of effort, hands and feet still inside the frame as the camera eases to a steady low-angle wide view. Lighting is soft even overhead gym light, neutral-cool 5200K with warm plywood bounce, low contrast, minimal hard shadowing, ambient fill from the pale wall and mat, clean whites on the wall. Materials read naturally: matte resin holds, wood grain, chalk dust, natural skin, matte fabric. The camera move is a single slow tilt up with subtle push-in, smooth and controlled, keeping the climber centered and the wall geometry readable.

overall_soundscape: Indoor gym room tone with ventilation hum and distant chatter; rubber shoe soles squeak and slap on resin holds; chalk bag rustles; fabric friction against the plywood; one controlled exhale of effort near the final high step; sounds stay synchronized with her reach, foot placement, weight shift and settle.

non_diegetic_music: none
```
