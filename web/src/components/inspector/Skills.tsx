import { useMemo, useState } from "preact/hooks";
import type { MediaRequest, SkillRating, SkillSummary } from "../../lib/types";
import { skillKindLabel } from "../../lib/utils";
import { t } from "../../lib/i18n";
import { SkillCard } from "./SkillCard";

type SkillFilter = "all" | "active" | "candidate" | "deprecated" | "needsFeedback";

type SkillsProps = {
  skills: SkillSummary[];
  skillFilter: string;
  showAllSkills: boolean;
  onSkillFilter: (filter: SkillFilter) => void;
  onToggleShowAllSkills: () => void;
  onOpenMedia: (media: MediaRequest) => void;
  onRateSkill?: (skillId: string, rating: SkillRating) => void;
  rateBusyId?: string | null;
  skillFeedbackNotes?: Record<string, { rating: SkillRating; count?: number }>;
};

export function Skills({
  skills,
  skillFilter,
  showAllSkills,
  onSkillFilter,
  onToggleShowAllSkills,
  onOpenMedia,
  onRateSkill,
  rateBusyId,
  skillFeedbackNotes,
}: SkillsProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.kind, (counts.get(skill.kind) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [skills]);

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
    needsFeedback: skills.filter((skill) => skill.needsFeedback).length,
  };

  const filterEntries: [SkillFilter, string, number][] = [
    ["all", t("skillStatus.all"), counts.all],
    ["active", t("skillStatus.active"), counts.active],
    ["candidate", t("skillStatus.candidate"), counts.candidate],
    ["needsFeedback", t("skills.needsFeedbackFilter"), counts.needsFeedback],
    ["deprecated", t("skillStatus.deprecated"), counts.deprecated],
  ];
  const filters = filterEntries.filter((entry): entry is [SkillFilter, string, number] => entry[2] > 0);

  const filter = filters.some(([value]) => value === skillFilter) ? skillFilter as SkillFilter : "all";
  const needle = query.trim().toLowerCase();
  const filtered = skills
    .filter((skill) => {
      if (filter === "needsFeedback") return Boolean(skill.needsFeedback);
      return filter === "all" || skill.status === filter;
    })
    .filter((skill) => kind === "all" || skill.kind === kind)
    .filter((skill) => {
      if (!needle) return true;
      const hay = [
        skill.name,
        skill.summaryZh,
        skill.kind,
        ...(skill.tags || []),
        ...(skill.applicableWhen || []),
      ].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  const visible = showAllSkills ? filtered : filtered.slice(0, 8);

  return (
    <section class="inspectorSection">
      <div class="sectionHead">
        <h3>{t("skills.title")}</h3>
        <span class="count">
          {filter === "all" && kind === "all" && !needle ? skills.length : `${filtered.length} / ${skills.length}`}
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
      <div class="skillToolbar">
        <input
          class="skillSearch"
          type="search"
          value={query}
          placeholder={t("skills.searchPlaceholder")}
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      {kinds.length > 1 ? (
        <div class="filterChips">
          <button
            type="button"
            class={`filterChip ${kind === "all" ? "active" : ""}`}
            onClick={() => setKind("all")}
          >
            {t("skills.kindAll")}
          </button>
          {kinds.map(([value, count]) => (
            <button
              key={value}
              type="button"
              class={`filterChip ${kind === value ? "active" : ""}`}
              onClick={() => setKind(value)}
            >
              {skillKindLabel(value)}
              <span>{count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p class="sectionHint">{t("skills.hint")}</p>
      {visible.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          onOpenMedia={onOpenMedia}
          onRate={onRateSkill}
          rateBusy={rateBusyId === skill.id}
          savedRating={skillFeedbackNotes?.[skill.id]?.rating}
        />
      ))}
      {!filtered.length ? (
        <p class="emptyHint">{t("skills.emptyFilter")}</p>
      ) : null}
      {filtered.length > 8 ? (
        <button class="textButton" type="button" onClick={onToggleShowAllSkills}>
          {showAllSkills ? t("skills.collapse") : t("skills.showAll", { count: filtered.length })}
        </button>
      ) : null}
    </section>
  );
}
