import type { CSSProperties } from "react";
export type Choice = { id: string; label: string };
export type EventInfo = {
  description: string;
  startDate: string;
  endDate: string | null;
  endedOn: string | null;
};
export type EventDetails = Pick<
  EventInfo,
  "description" | "startDate" | "endDate"
>;
export type RepeatRule =
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: number[] }
  | { kind: "monthly"; days: number[] }
  | { kind: "once"; date: string };
export type RepeatVersion = { from: string; rule: RepeatRule };
export type Focus = {
  id: string;
  name: string;
  createdOn: string;
  archived: boolean;
  states: Choice[];
  bestFirst: boolean;
  event?: EventInfo | null;
  repeatRules?: RepeatVersion[];
  skippedDates?: string[];
  extraDates?: string[];
};
export type Entry = {
  itemId: string;
  date: string;
  status: string;
  statusLabel: string;
  quality: number;
  note: string;
  updatedAt: string;
};
export type ClockChange = {
  at: string;
  kind: string;
  from: string;
  to: string;
  reason: string;
};
export type ClockInfo = {
  simulated: boolean;
  systemDate: string;
  systemTime: string;
  checkedAt: string;
  reason: string;
  checks: number;
  generation: number;
  changes: ClockChange[];
};
export type Snapshot = {
  storageRevision: string;
  today: string;
  folder: string;
  items: Focus[];
  records: Entry[];
  clock: ClockInfo;
};
export function quality(index: number, count: number, bestFirst: boolean) {
  if (count === 1) return 0.5;
  const score = index / (count - 1);
  return bestFirst ? 1 - score : score;
}
export function tone(score: number): CSSProperties {
  const hue = 5 + Math.max(0, Math.min(1, score)) * 125;
  return {
    backgroundColor: `hsl(${hue} 58% 92%)`,
    color: `hsl(${hue} 48% 30%)`,
    borderColor: `hsl(${hue} 42% 65%)`,
  };
}
export const choiceId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
export const newChoices = () =>
  ["极差", "差", "一般", "好", "非常好"].map((label) => ({
    id: choiceId(),
    label,
  }));

export function repeatOn(item: Focus, date: string): RepeatRule {
  const version = (item.repeatRules ?? [])
    .filter((v) => v.from <= date)
    .reduce<RepeatVersion | null>(
      (last, v) => (!last || v.from > last.from ? v : last),
      null,
    );
  return version?.rule ?? { kind: "daily" };
}
export function baseScheduled(item: Focus, date: string): boolean {
  if (item.event) return true;
  const rule = repeatOn(item, date);
  const value = new Date(date + "T12:00:00Z");
  switch (rule.kind) {
    case "daily":
      return true;
    case "weekly":
      return rule.weekdays.includes(value.getUTCDay() || 7);
    case "monthly":
      return rule.days.includes(value.getUTCDate());
    case "once":
      return rule.date === date;
  }
}
export type ExceptionAction = "skip" | "unskip" | "add" | "removeAdd";
export const isSkipped = (item: Focus, date: string) =>
  !item.event && (item.skippedDates ?? []).includes(date);
export const isExtra = (item: Focus, date: string) =>
  !item.event && (item.extraDates ?? []).includes(date);
export function isScheduled(item: Focus, date: string): boolean {
  return item.event
    ? true
    : !isSkipped(item, date) &&
        (isExtra(item, date) || baseScheduled(item, date));
}
export function canAddExtra(item: Focus, date: string): boolean {
  const kind = repeatOn(item, date).kind;
  return (
    !item.event &&
    !item.archived &&
    date >= item.createdOn &&
    (kind === "weekly" || kind === "monthly") &&
    !baseScheduled(item, date) &&
    !isSkipped(item, date) &&
    !isExtra(item, date)
  );
}
export function repeatLabel(item: Focus, date: string): string {
  const rule = repeatOn(item, date);
  const names = ["", "一", "二", "三", "四", "五", "六", "日"];
  switch (rule.kind) {
    case "daily":
      return "每天";
    case "weekly":
      return "每周 " + rule.weekdays.map((d) => "周" + names[d]).join("、");
    case "monthly":
      return "每月 " + rule.days.join("、") + " 日";
    case "once":
      return rule.date + " · 仅一次";
  }
}
export function repeatProblem(
  rule: RepeatRule,
  today: string,
  original: RepeatRule,
): string {
  if (rule.kind === "weekly" && !rule.weekdays.length)
    return "请至少选择一个星期。";
  if (rule.kind === "monthly" && !rule.days.length)
    return "请至少选择一个月内日期。";
  if (
    rule.kind === "once" &&
    (!rule.date ||
      (rule.date < today &&
        !(original.kind === "once" && original.date === rule.date)))
  )
    return "请选择今天或之后的固定日期。";
  return "";
}
export const effectiveEnd = (item: Focus) =>
  item.event?.endedOn ?? item.event?.endDate ?? null;
export function canRecord(item: Focus, date: string): boolean {
  const end = effectiveEnd(item);
  return (
    !item.archived &&
    date >= (item.event?.startDate ?? item.createdOn) &&
    (!end || date <= end) &&
    isScheduled(item, date)
  );
}
export function eventPhase(item: Focus, today: string) {
  const event = item.event!;
  if (event.startDate > today) return { key: "upcoming", label: "未开始" };
  if (event.endedOn && event.endedOn <= today)
    return { key: "ended", label: "已结束" };
  if (event.endDate && event.endDate < today)
    return { key: "expired", label: "已到期" };
  if (event.endDate === today) return { key: "due", label: "今日到期" };
  return { key: "active", label: "进行中" };
}
export function missingLabel(item: Focus, date: string, today: string) {
  if (isSkipped(item, date)) return "已跳过";
  if (!item.event && date >= item.createdOn && !isScheduled(item, date))
    return "无需打卡";
  if (date > today) return "尚未到来";
  if (date < (item.event?.startDate ?? item.createdOn)) return "尚未开始";
  const end = effectiveEnd(item);
  if (end && date > end) return "已结束";
  return "未记录";
}
