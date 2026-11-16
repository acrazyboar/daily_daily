import { useState } from "react";
import {
  effectiveEnd,
  isSkipped,
  isExtra,
  isScheduled,
  missingLabel,
  quality,
  tone,
} from "./model";
import type { Entry, Focus, ExceptionAction } from "./model";
import ScheduleExceptionControls from "./ScheduleExceptionControls";
type Draft = { choice: string; note: string; original: Entry | null };
export default function HistoryDetail({
  item,
  date,
  today,
  entry,
  disabled,
  save,
  changeException,
}: {
  item: Focus;
  date: string;
  today: string;
  entry?: Entry;
  disabled: boolean;
  changeException: (action: ExceptionAction) => Promise<boolean>;
  save: (
    status: string,
    note: string,
    keepOriginalStatus: boolean,
    expectedUpdatedAt: string | null,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const end = effectiveEnd(item);
  const eligible =
    !isSkipped(item, date) &&
    (entry || isScheduled(item, date)) &&
    date <= today &&
    date >= item.createdOn &&
    (!end || date <= end) &&
    !(item.archived && date === today && !entry);
  const original = draft?.original;
  const legacy =
    !!original &&
    !item.states.some(
      (s, index) =>
        s.id === original.status &&
        s.label === original.statusLabel &&
        Math.abs(
          quality(index, item.states.length, item.bestFirst) - original.quality,
        ) < 0.000001,
    );
  const displayedChoice =
    draft?.choice === "original" && !legacy && original
      ? "current:" + original.status
      : draft?.choice;
  const validChoice =
    !!draft &&
    (draft.choice === "original"
      ? !!original
      : item.states.some((s) => "current:" + s.id === draft.choice));
  const displayDate = new Date(date + "T12:00:00").toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  return (
    <section className="record-detail" aria-label="记录详情">
      <div>
        <p className="eyebrow">DAY DETAILS</p>
        <h3>
          {item.name} · {displayDate}
        </h3>
        <span
          className="badge"
          style={
            entry && !isSkipped(item, date) ? tone(entry.quality) : undefined
          }
        >
          {isSkipped(item, date)
            ? "已跳过"
            : (entry?.statusLabel ?? missingLabel(item, date, today))}
        </span>
        {isExtra(item, date) && (
          <small className="extra-note">本次额外添加</small>
        )}
        {isSkipped(item, date) && entry && (
          <p className="muted">
            原记录：{entry.statusLabel} · 记录已保留，恢复后可继续修改。
          </p>
        )}
        {entry && (
          <small className="muted">
            最后保存于 {new Date(entry.updatedAt).toLocaleString("zh-CN")}
          </small>
        )}
      </div>
      <ScheduleExceptionControls
        item={item}
        date={date}
        entry={entry}
        disabled={disabled || !!draft}
        change={changeException}
      />
      {!draft ? (
        <>
          <p className="detail-note">
            {entry?.note ||
              (entry
                ? "当天没有填写备注。"
                : "暂无记录。未填写不会被视为最差状态。")}
          </p>
          {eligible ? (
            <button
              className="secondary"
              disabled={disabled}
              onClick={() =>
                setDraft({
                  choice: entry ? "original" : "",
                  note: entry?.note ?? "",
                  original: entry ? { ...entry } : null,
                })
              }
            >
              {entry ? "修改记录" : date < today ? "补记这一天" : "记录今天"}
            </button>
          ) : (
            <p className="muted">
              {isSkipped(item, date)
                ? "这一天已跳过，恢复后可记录。"
                : date > today
                  ? "未来日期不能填写或修改。"
                  : date < item.createdOn
                    ? "该日期早于此内容的创建日期。"
                    : !entry && !isScheduled(item, date)
                      ? "这一天不在该打卡项的重复计划内，无需打卡。"
                      : item.event
                        ? "该日期不在事件的有效日期内。"
                        : "已移除的打卡项不能新增今天的记录。"}
            </p>
          )}
        </>
      ) : (
        <form
          className="history-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!validChoice) return;
            const keep = draft.choice === "original";
            const status = keep
              ? draft.original!.status
              : draft.choice.slice("current:".length);
            if (
              await save(
                status,
                draft.note,
                keep,
                draft.original?.updatedAt ?? null,
              )
            )
              setDraft(null);
          }}
        >
          <fieldset disabled={disabled}>
            <legend>{entry ? "修改记录" : "补记记录"}</legend>
            <p className="history-target-date">
              记录日期：<strong>{date}</strong>
              {date < today && <span>历史日期</span>}
            </p>
            <div className="status-options">
              {legacy && original && (
                <label
                  className={`status-choice ${draft.choice === "original" ? "chosen" : ""}`}
                  style={
                    draft.choice === "original"
                      ? tone(original.quality)
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="history-status"
                    checked={draft.choice === "original"}
                    onChange={() => setDraft({ ...draft, choice: "original" })}
                  />
                  <span className="choice-dot" style={tone(original.quality)} />
                  {original.statusLabel}（原记录）
                </label>
              )}
              {item.states.map((state, index) => (
                <label
                  className={`status-choice ${displayedChoice === "current:" + state.id ? "chosen" : ""}`}
                  key={state.id}
                  style={
                    displayedChoice === "current:" + state.id
                      ? tone(quality(index, item.states.length, item.bestFirst))
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="history-status"
                    checked={displayedChoice === "current:" + state.id}
                    onChange={() =>
                      setDraft({ ...draft, choice: "current:" + state.id })
                    }
                  />
                  <span
                    className="choice-dot"
                    style={tone(
                      quality(index, item.states.length, item.bestFirst),
                    )}
                  />
                  {state.label}
                </label>
              ))}
            </div>
            {legacy && (
              <p className="muted">
                状态配置已调整。选择“原记录”可保留当时的状态和颜色，只修改备注。
              </p>
            )}
            <label htmlFor="history-note">
              备注<span>选填 · 最多 2000 字</span>
            </label>
            <textarea
              id="history-note"
              maxLength={2000}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="记录这一天的具体情况……"
            />
            <div className="form-bottom">
              <span className="muted">
                仅保存「{item.name}」在 {date} 的记录
              </span>
              <div className="editor-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={disabled}
                  onClick={() => setDraft(null)}
                >
                  取消编辑
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={disabled || !validChoice}
                >
                  保存 {date} 的记录
                </button>
              </div>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
