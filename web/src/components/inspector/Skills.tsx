import type { MediaRequest, SkillSummary } from "../../lib/types";
import { t } from "../../lib/i18n";
import { SkillCard } from "./SkillCard";

type SkillFilter = "all" | "active" | "candidate" | "deprecated";

type SkillsProps = {
  skills: SkillSummary[];
  skillFilter: string;
  showAllSkills: boolean;
  onSkillFilter: (filter: SkillFilter) => void;
  onToggleShowAllSkills: () => void;
  onOpenMedia: (media: MediaRequest) => void;
};

export function Skills({
  skills,
  skillFilter,
  showAllSkills,
  onSkillFilter,
  onToggleShowAllSkills,
  onOpenMedia,
}: SkillsProps) {
  if (!skills.length) {
    return (
      <section class="inspectorSection">
        <div class="sectionHead">
          <h3>{t("skills.title")}</h3>
          <span class="count">0</span>
        </div>
        <p class="emptyHint">{t("skills.emptyHint")}</p>
      </section>
    );
  }

  const counts = {
    all: skills.length,
    active: skills.filter((skill) => skill.status === "active").length,
    candidate: skills.filter((skill) => skill.status === "candidate").length,
    deprecated: skills.filter((skill) => skill.status === "deprecated").length,
  };

  const filterEntries: [SkillFilter, string, number][] = [
    ["all", t("skillStatus.all"), counts.all],
    ["active", t("skillStatus.active"), counts.active],
    ["candidate", t("skillStatus.candidate"), counts.candidate],
    ["deprecated", t("skillStatus.deprecated"), counts.deprecated],
  ];
  const filters = filterEntries.filter((entry): entry is [SkillFilter, string, number] => entry[2] > 0);

  const filter = filters.some(([value]) => value === skillFilter) ? skillFilter as SkillFilter : "all";
  const filtered = skills
    .filter((skill) => filter === "all" || skill.status === filter)
    .sort((left, right) => {
      const rank = (status: string) => status === "active" ? 0 : status === "candidate" ? 1 : 2;
      return rank(left.status) - rank(right.status) || Number(right.confidence) - Number(left.confidence);
    });
  const visible = showAllSkills ? filtered : filtered.slice(0, 8);

  return (
    <section class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("skills.title")}</h3>
        <span class="count">
          {filter === "all" ? skills.length : `${filtered.length} / ${skills.length}`}
        </span>
      </div>
      <div class="filterChips">
        {filters.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            class={`filterChip ${filter === value ? "active" : ""}`}
            onClick={() => onSkillFilter(value)}
          >
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      <p class="sectionHint">{t("skills.hint")}</p>
      {visible.length ? (
        visible.map((skill) => (
          <SkillCard key={skill.id} skill={skill} onOpenMedia={onOpenMedia} />
        ))
      ) : (
        <p class="emptyHint">{t("skills.emptyFilter")}</p>
      )}
      {filtered.length > 8 ? (
        <button class="textButton" type="button" onClick={onToggleShowAllSkills}>
          {showAllSkills ? t("skills.collapse") : t("skills.showAll", { count: filtered.length })}
        </button>
      ) : null}
    </section>
  );
}