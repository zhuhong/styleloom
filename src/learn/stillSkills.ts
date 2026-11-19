import type { SkillDraft, StyleBible } from "../types";

/**
 * 从风格圣经直接派生「出图技能」（定妆照 / 场景照）。
 *
 * 这一步不调用模型：静帧的方法论本来就能从 bible 的 style / prompting 里读出来，
 * 多一轮模型调用只会增加成本与不确定性。抽出来的技能一样进技能库、一样吃
 * 证据与反馈（`evidence` 用参考片关键帧，`outcomes` 由 generate_still 记录 usage、
 * 由 record_skill_outcome 记录真实效果）。
 *
 * ACT: 只派生 3 条通用基准（人物 / 场景 / 避坑），不按每个角色、场景各生成一条，
 * 否则技能库会被同义条目灌满；具体人物/场景信息留在风格圣经的 stillPrompt 里。
 */
export function deriveStillSkills(bible: StyleBible): SkillDraft[] {
  const prefix = bible.style.stylePrefix?.trim() ?? "";
  const lead = prefix ? `${prefix}, ` : "";
  const texture = bible.style.texture?.trim();
  const grading = bible.style.colorGrade?.trim();
  const characterShots = bible.characters.flatMap(character => character.refShotIds ?? []).slice(0, 2);
  const locationShots = bible.locations.flatMap(location => location.refShotIds ?? []).slice(0, 2);

  const character: SkillDraft = {
    name: "定妆照基准：全身中性参考帧",
    kind: "still",
    appliesTo: ["still"],
    summaryZh: "定妆照先保证「全身完整 + 无缝背景 + 中性布光」，人物一致性才立得住",
    instruction:
      "生成角色定妆照时：主体全身完整入画（头顶与脚底各留少量余量，不裁切）、正面或 3/4 侧站立、中性表情看镜头、纯色或无缝背景、均匀柔光、无道具无文字；发型与服装按风格圣经固定，方便后续作为 Ref2VA 参考图复用。",
    promptFragment: `${lead}full-body character reference still, standing straight facing camera, calm neutral expression, plain seamless neutral background, even soft studio lighting, complete head-to-toe framing with margin, consistent hairstyle and wardrobe, no props, no text, no watermark${texture ? `, ${texture}` : ""}`,
    applicableWhen: ["角色定妆照", "Ref2VA 参考图", "人物一致性"],
    avoidWhen: ["需要环境叙事的剧照", "情绪特写"],
    tags: ["still", "character", "reference", "full-body"],
    evidenceShotIds: characterShots,
  };

  const location: SkillDraft = {
    name: "场景照基准：空场景参考帧",
    kind: "still",
    appliesTo: ["still"],
    summaryZh: "场景照只出空景，陈设层级清楚，才方便后面往镜头里放人",
    instruction:
      "生成场景照时：只出空场景，不出现人物与文字招牌；用能看清空间关系的广角/中景，陈设与光源方向明确，前景/中景/背景层次可辨；保持与参考片一致的色温与材质质感，便于作为 Ref2VA 场景参考图。",
    promptFragment: `${lead}empty location reference still, no people, wide establishing view, clear foreground midground background layering, readable set dressing and light direction, no text, no signage, no watermark${grading ? `, ${grading}` : ""}`,
    applicableWhen: ["场景照", "空景参考", "Ref2VA 参考图"],
    avoidWhen: ["需要人物出镜的剧照"],
    tags: ["still", "location", "reference", "empty-set"],
    evidenceShotIds: locationShots,
  };

  const avoid: SkillDraft = {
    name: "出图避坑：文字、水印与裁切",
    kind: "avoid",
    appliesTo: ["still"],
    summaryZh: "参考静帧里出现文字、水印或被裁切的身体，后面当参考图会一路传染",
    instruction:
      "生成定妆照/场景照时避免：画面内文字、logo、水印、边框；人物头顶或脚底贴边裁切；多人入镜抢主体；强烈的单侧硬光把五官和服装细节吃掉。发现这些问题就重出一张，不要拿它当参考图。",
    promptFragment: "",
    applicableWhen: ["定妆照", "场景照", "参考图验收"],
    avoidWhen: ["需要字幕或排版效果的成片画面"],
    tags: ["still", "avoid", "watermark", "framing"],
    evidenceShotIds: characterShots.slice(0, 1),
  };

  return [character, location, avoid];
}
