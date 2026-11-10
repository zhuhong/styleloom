# 示例：定妆照 + 场景照作为 Ref2VA 参考

同一条小红书竖屏参考片的第二次生成：先出人物定妆照与空场景照，再用 Ref2VA 把两张图作为参考，对比纯文字 T2VA 的稳定性。

## 参考片

- 小红书竖屏参考片（原片为第三方作品、含真人，不随仓库分发），9.54 秒 / 1080×1920
- 固定机位平视全身、奶油墙角落、左侧深棕木门、右下彩虹花卉画、柔和低对比暖中性光

## 参考图

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 人物定妆照 | `assets/stills/character-c2-2026-11-10T03-24-07.png` | 1152×2048 |
| 空场景照 | `assets/stills/location-l2-2026-11-10T03-24-24.png` | 1152×2048 |

用 OpenRouter `qwen/qwen-image-2.1-turbo` 生成（2K、9:16），人物全身完整、场景无人物。

### 人物定妆照提示词

```text
Neutral full-body reference still of an adult woman with long black hair in a low bun, warm light-olive skin and slender build, wearing an ivory fine-knit short-sleeve top, olive wide-leg trousers and tan leather flat shoes with small gold hoop earrings, standing straight facing the camera with a relaxed closed-mouth smile, plain cream background, soft even frontal light.
```

### 场景照提示词

```text
Interior corner with a cream painted wall, a dark brown wood door with brass hardware at screen left, white light switches, wood flooring, and a large vivid rainbow flower artwork leaning against the wall at screen right; warm-neutral artificial indoor lighting, empty room, no people.
```

## 生成参数

- 模式：Ref2VA（`generationMode=ref2va`）
- 模型：`minimax-h3-ref2va`，task `ref2va`
- conditions：2 张 `role=reference` 参考图（人物 + 场景），无参考视频、无首尾帧
- 时长/画幅：9 秒 / 9:16，输出 768×1344，含音轨
- 生成耗时：约 248 秒（排队 + 推理）
- video_id：`video_684f9443-ac67-4edd-b51d-9312aec490e8`

## VLM 自动质检（1s / 4s / 8s 三帧）

```json
{
  "match": "高度",
  "identity": "三帧中人物均为黑发低髻、象牙白针织短袖、橄榄绿阔腿裤、棕色平底鞋，脸型与五官与定妆照一致，服装版型与配色稳定，无明显漂移。",
  "room": "奶油色墙面、左侧深棕木门（含黄铜门把手与合页）、右下彩虹花卉画框均与场景照吻合，画作位置与比例稳定；墙面多出一组白色开关面板，属参考图未提及的小差异。",
  "framing": "固定机位、平视、竖屏全身构图，三帧景别与人物占比基本一致，头顶与脚下均留有余量，无裁切。",
  "lighting": "暖调室内光，色温与明暗三帧一致，墙面与地板反光稳定，无闪烁。",
  "poseProgression": "1s 双臂自然垂于身侧、正面站立；4s 左手轻搭画框、重心偏移、双腿微交叉；8s 手仍扶画框、双腿交叉加深并略侧倾，变化缓慢自然，符合预期。",
  "defects": [
    "搭在画框上的手指略显细长、边缘轻微模糊",
    "墙面出现参考图未有的开关面板"
  ],
  "vs_t2va": "无法判断",
  "notes": "人物与场景高度还原两张参考图，机位与光线稳定，仅手部细节与墙面小物件有轻微偏差，整体质量良好。"
}
```

## 与纯文字 T2VA 版对比

| 维度 | T2VA 纯文字版 | Ref2VA 定妆照+场景照版 |
| --- | --- | --- |
| 人物身份 | 新角色，靠文字描述，整体符合 | 与定妆照一致，脸/发型/服装稳定 |
| 场景元素 | 门、画、墙基本到位 | 与场景照一致，画作位置/比例稳定 |
| 机位稳定性 | 1s→4s 有轻微推近/构图漂移 | 三帧景别一致，无漂移 |
| 全身构图 | 1s 鞋尖轻微裁切 | 头顶脚下均留余量，无裁切 |
| 手部接触 | 手指与画框略融合 | 仍有轻微细长/模糊 |
| 额外差异 | — | 墙面多出一组白色开关面板 |

结论：Ref2VA + 两张参考图在身份、场景和构图稳定性上明显更好；纯文字版本的优点是更自由、不依赖图片模型。

用户验收：第二版（定妆照 + 场景照 Ref2VA）效果可接受，已写入相关技能的反馈记录，项目阶段置为 `deliver`。

## 新增技能

本次实验沉淀了一条 workflow 技能 `workflow-eb9591aa`：**定妆照 + 场景照 Ref2VA 锁定**（active，0.79）。

## 最终 Ref2VA 提示词

```text
subject_definitions:
<Subject 1> is an adult woman with long black hair in a low bun, warm light-olive skin and a slender build, wearing an ivory fine-knit short-sleeve top, olive wide-leg trousers, tan leather flat shoes and small gold hoop earrings; her manner is calm and her expression relaxed.
<Picture 1> is the reference still that defines the face, hair, skin tone, build and complete wardrobe of <Subject 1>.
<Picture 2> is the reference still that defines the location: an interior corner with a cream painted wall, a dark brown wood door with brass hardware at screen left, white light switches on the wall, wood flooring, and a large vivid rainbow flower artwork leaning against the wall at screen right, under warm-neutral artificial indoor lighting with no windows or weather visible.

summary: [reference generation + synchronized audio] A static vertical full-body portrait of <Subject 1> in the corner defined by <Picture 2>; she shifts her weight onto her right leg, lets her left hand drift to the edge of the rainbow artwork, crosses her ankles, lifts her chin to look up and slightly away, then returns her gaze to the camera and settles into a relaxed closed-mouth smile, while the room and framing remain fixed.

retention_analysis:
<Subject 1>: fully_preserved — face, low black bun, warm light-olive skin, slender build, ivory fine-knit top, olive wide-leg trousers, tan leather flats and small gold hoop earrings remain identical throughout.
<Picture 1>: partially_preserved — appearance and wardrobe are carried over exactly, while pose, gaze and expression are newly performed for this shot.
<Picture 2>: attribute_transfer — the cream wall, dark brown door with brass hardware at screen left, white light switches, wood floor and the vivid rainbow flower artwork at screen right are transferred into the shot as the standing environment, not copied as a still image.

detailed_description: [Shot 1] Static eye-level full-body vertical 9:16 portrait, clean digital editorial realism, soft and understated, neutral cream, white and taupe palette with one saturated rainbow accent from the artwork, moderate contrast, clean whites, warm-neutral skin tones, clean low-grain digital texture, soft skin rendering and crisp fabric detail. <Subject 1> stands centered in a frontal full-body framing at a fixed distance, deep focus, 35–50mm equivalent lens, minimal distortion, no pan, no tilt, no zoom, no dolly, no handheld shake; only she moves inside the locked frame. The room stays exactly as defined by <Picture 2>: cream painted wall behind her, dark brown wood door with brass hardware at screen left, white light switches on the wall, wood flooring underfoot, and the large vivid rainbow flower artwork leaning against the wall at screen right, its saturated bands of color providing the single strong accent against the neutral room. Soft low-contrast warm-neutral frontal key light comes from slightly camera-left, ambient fill lifts the shadows, no practical lamp is visible, and the indoor color temperature stays warm-neutral.

0.00–1.60 seconds: she holds a settled, even stance, arms relaxed at her sides, chin level, gaze directly into the lens with a calm neutral expression; the fabric of the ivory knit and olive trousers hangs still, and only a faint room tone and the softest breath are audible.

1.60–3.40 seconds: her weight rolls slowly onto her right leg, the left hip easing outward, the olive wide-leg trouser leg swinging with a soft fabric rustle; her left hand drifts up and outward until the fingertips rest lightly at the edge of the rainbow artwork beside her, and a faint flat-shoe contact sounds against the wood floor as the weight settles.

3.40–5.20 seconds: she crosses her ankles in a small, deliberate adjustment, the tan leather flats sliding quietly over the wood, her shoulders softening as she inhales; the gold hoop earrings catch the light with a slight sway.

5.20–6.80 seconds: she lifts her chin and turns her head slowly up and slightly away from the camera, eyes traveling off-lens, the line of her throat lengthening, the low bun shifting minutely with the movement; the room tone continues evenly.

6.80–8.20 seconds: she lowers her gaze back down to the camera, her head returning to center, the motion decelerating naturally, her expression easing.

8.20–9.00 seconds: she settles into a relaxed closed-mouth smile, weight still on the right leg, left hand still at the artwork edge, a soft exhale, and holds the pose as the shot ends; the framing, focus and lighting remain unchanged throughout.

overall_soundscape: quiet indoor room tone throughout; soft fabric rustle from the knit top and wide-leg trousers as she shifts weight, a faint flat-shoe contact and slide on the wood floor at the ankle cross, a subtle earring sway; no dialogue, no music, no other voices or room activity.

non_diegetic_music: none.
```
