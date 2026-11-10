# 示例：从一条小红书竖屏参考片生成仿拍

## 参考片

- 来源：小红书笔记 `6ad5e4c0000000000c00b1ad`（标题 `Hi……`）
- 时长/画幅：9.54 秒 / 1080×1920（9:16）
- 内容：固定机位平视全身时尚人像，奶油墙室内角落，左侧深棕木门、右下彩虹花卉画，柔和低对比暖中性光

## 学习结果

- 1 个镜头，自动归纳风格圣经 + 8 条技能（固定机位、姿态微变化、柔光、单点高饱和、建筑线条构图、锚点复述、负向清单、室内声场）。
- 参考片人物只用于学习，不直接作为生成主体；新视频使用新角色 c2，走纯文本 T2VA，避免复刻原片人物身份。

## 生成参数

- 模型：MiniMax H3 T2VA（video_9e930951-416b-474a-9d73-34a079ca5018）
- 时长/画幅：9 秒 / 9:16，输出 768×1344，含音轨
- 使用技能：camera / lighting / color / composition / prompt / avoid / rhythm / sound
- 生成耗时：约 141 秒（排队 + 推理）

## VLM 自动质检（1s / 4s / 8s 三帧）

```json
{
  "match": "高度符合",
  "subject": "成年女性，黑发低髻，金色圈形耳环；象牙白针织短袖、橄榄绿阔腿裤、棕色平底鞋，与预期一致",
  "room": "奶油墙、左侧深棕木门与黄铜把手、墙面开关、右下彩虹花卉画、木地板齐全",
  "framing": "9:16 竖屏，平视全身，人物居中略偏右，门与画左右平衡；1s→4s 有轻微推近",
  "lighting": "柔和低对比暖中性光，肤色与墙面过渡自然",
  "poseProgression": "正面直立 → 重心右移、手搭画框、交叉脚踝 → 保持倚靠并微调头肩",
  "defects": [
    "轻微机位推近/构图漂移",
    "手指与画框接触略融合",
    "1s 鞋尖轻微裁切"
  ],
  "notes": "人物、服装、场景、光线高度还原，姿态过渡自然"
}
```

自动质检反馈写入技能库：lighting / color / prompt / rhythm 记为 good 并升级 active；camera / composition / avoid 因轻微漂移与鞋尖裁切记为 mixed，保持 candidate。

## 最终 H3 提示词

```text
integrated_multimodal_description: [Shot 1] Vertical 9:16 static eye-level full-body portrait, clean digital editorial realism, soft and understated, neutral cream/white/taupe palette broken by one saturated rainbow accent. Locked-off camera at eye level, frontal full-body framing, 35–50mm equivalent normal-to-moderate-wide lens, deep depth of field, minimal distortion, no pan, no tilt, no zoom, no dolly — the frame stays fixed and the subject moves inside it. Interior corner of a room: cream painted wall filling the background, a dark brown wood door with brass hardware and a white light switch plate at screen left, warm wood flooring, and a large vivid rainbow flower artwork leaning against the wall at screen right, its edge just within her reach. Soft low-contrast warm-neutral frontal key from slightly camera-left, ambient fill lifting the shadows, warm neutral indoor color temperature, no visible lamp or window; clean low-grain digital texture, soft skin rendering, crisp fabric detail, natural indoor falloff. The subject is an adult woman, long black hair in a low bun, warm light-olive skin, slender build, small gold hoop earrings, wearing an ivory fine-knit short-sleeve top, olive wide-leg trousers and tan leather flat shoes; her identity, wardrobe, hair and the room layout remain consistent throughout.

At 0.00–2.00s she stands centered, weight settled evenly on both feet, arms relaxed at her sides, chin level, gaze directly into the lens, expression calm and closed-mouth. Around 2.00s she slowly shifts her weight onto her right leg; the olive wide-leg trouser fabric swings and settles, the tan flat shoe pivots faintly on the wood floor, and her hips ease slightly off-axis while her shoulders stay square to the camera. At 3.00–4.50s her left hand drifts outward and her fingertips come to rest on the top edge of the rainbow artwork beside her, a small deliberate adjustment; her right arm hangs loose. At 4.50–5.50s she crosses her ankles, the left flat shoe sliding behind the right with a soft scuff, and her posture lengthens. At 5.50–7.00s she lifts her chin and turns her head slowly up and slightly away from camera, eyes traveling off-lens toward the upper left, a soft breath lifting her chest and a strand of hair shifting at her temple. At 7.00–9.00s she lowers her gaze back down the same slow arc until her eyes meet the lens again, her head returning to center, and she settles into a relaxed closed-mouth smile, weight still on the right leg, left hand still at the artwork edge, a final small exhale easing her shoulders. Only weight transfer, small hand adjustments, one slow head turn and soft breathing occur; the room, framing and light remain unchanged, and the action resolves in a settled, still pose.

overall_soundscape: Quiet indoor room tone with a faint low room hum; soft fabric rustle of the fine-knit top and wide-leg trousers as she shifts her weight; a light scuff and faint flat-shoe contact on the wood floor at the weight transfer and again as she crosses her ankles; a barely audible breath at the chin lift and at the final settle. No dialogue, no music, no other voices or room activity.

non_diegetic_music: none
```
