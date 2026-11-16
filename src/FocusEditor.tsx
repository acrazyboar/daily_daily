import { useState } from "react";
import {
  choiceId,
  newChoices,
  quality,
  tone,
  repeatOn,
  repeatProblem,
} from "./model";
import type { Choice, Focus, EventDetails, RepeatRule } from "./model";

import RepeatEditor from "./RepeatEditor";

export default function FocusEditor({
  item,
  disabled,
  save,
  cancel,
  eventMode = false,
  today = "",
}: {
  item?: Focus;
  eventMode?: boolean;
  today?: string;
  disabled: boolean;
  save: (
    name: string,
    states: Choice[],
    bestFirst: boolean,
    details?: EventDetails,
    repeat?: RepeatRule,
  ) => Promise<boolean>;
  cancel: () => void;
}) {
  const [originalRepeat] = useState<RepeatRule>(() =>
    item ? repeatOn(item, today) : { kind: "daily" },
  );
  const [repeat, setRepeat] = useState<RepeatRule>(originalRepeat);
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const dateIssue =
    eventMode && !item
      ? !startDate
        ? "请选择起始日期。"
        : endDate && endDate < startDate
          ? "结束日期不能早于起始日期。"
          : ""
      : "";
  const [name, setName] = useState(item?.name ?? "");
  const [states, setStates] = useState<Choice[]>(
    () => item?.states.map((s) => ({ ...s })) ?? newChoices(),
  );
  const [bestFirst, setBestFirst] = useState(item?.bestFirst ?? false);
  const labels = states.map((s) => s.label.trim());
  const issue =
    dateIssue ||
    (!eventMode ? repeatProblem(repeat, today, originalRepeat) : "") ||
    (!states.length
      ? "至少保留一个状态。"
      : labels.some((label) => !label)
        ? "请为每个状态填写名称。"
        : new Set(labels).size !== labels.length
          ? "状态名称不能重复。"
          : "");
  function move(index: number, delta: number) {
    const next = [...states];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setStates(next);
  }
  return (
    <section className="management-card focus-editor">
      <h2>
        {item
          ? eventMode
            ? `编辑「${item.name}」的状态`
            : `编辑「${item.name}」`
          : eventMode
            ? "新增事件"
            : "添加关注项"}
      </h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            !issue &&
            (await save(
              name.trim(),
              states.map((s) => ({ ...s, label: s.label.trim() })),
              bestFirst,
              eventMode && !item
                ? { description, startDate, endDate: endDate || null }
                : undefined,
              eventMode ? undefined : repeat,
            ))
          ) {
            if (!item) setName("");
          }
        }}
      >
        <fieldset disabled={disabled}>
          {!item && (
            <>
              <label htmlFor="focus-name">
                {eventMode ? "事件名称" : "关注项名称"}
              </label>
              <input
                id="focus-name"
                placeholder={
                  eventMode
                    ? "例如：准备一次分享、旅行、短期训练"
                    : "例如：睡眠"
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={30}
                required
              />
            </>
          )}
          {eventMode && !item && (
            <div className="event-details-fields">
              <label htmlFor="event-description">
                事件简介<span>选填 · 最多 2000 字</span>
              </label>
              <textarea
                id="event-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder="这件事想做什么，或者希望达到什么目标？"
              />
              <div className="event-dates">
                <div>
                  <label htmlFor="event-start">起始日期</label>
                  <input
                    id="event-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="event-end">
                    结束日期<span>选填</span>
                  </label>
                  <input
                    id="event-end"
                    type="date"
                    min={startDate}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              <p className="muted">
                起始日和结束日均可记录。不设结束日期则持续记录，之后可手动结束。
              </p>
            </div>
          )}
          {!eventMode && (
            <RepeatEditor
              rule={repeat}
              onChange={setRepeat}
              today={today}
              minimumDate={item?.createdOn ?? today}
              editing={!!item}
            />
          )}
          <div className="states-heading">
            <div>
              <h3>可选状态</h3>
              <p className="muted">
                按好坏排序，颜色自动从红到绿过渡。单个状态使用中间色。
              </p>
            </div>
            <label htmlFor="state-direction">
              排序方向
              <select
                id="state-direction"
                value={bestFirst ? "best" : "worst"}
                onChange={(e) => {
                  setBestFirst(e.target.value === "best");
                  setStates([...states].reverse());
                }}
              >
                <option value="worst">由差到好</option>
                <option value="best">由好到差</option>
              </select>
            </label>
          </div>
          <ol className="state-editor-list">
            {states.map((state, index) => (
              <li key={state.id}>
                <span className="state-position">{index + 1}</span>
                <span
                  className="color-preview"
                  style={tone(quality(index, states.length, bestFirst))}
                  aria-label={`颜色预览，${states.length === 1 ? "中间" : index === 0 ? (bestFirst ? "最好" : "最差") : index === states.length - 1 ? (bestFirst ? "最差" : "最好") : "中间"}等级`}
                />
                <input
                  aria-label={`状态名称 ${index + 1}`}
                  value={state.label}
                  maxLength={30}
                  onChange={(e) =>
                    setStates(
                      states.map((s, i) =>
                        i === index ? { ...s, label: e.target.value } : s,
                      ),
                    )
                  }
                  placeholder="填写状态名称"
                  required
                />
                <div className="state-buttons">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`上移状态 ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`下移状态 ${index + 1}`}
                    disabled={index === states.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`删除状态 ${index + 1}`}
                    disabled={states.length === 1}
                    onClick={() =>
                      setStates(states.filter((_, i) => i !== index))
                    }
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              setStates([...states, { id: choiceId(), label: "" }])
            }
          >
            ＋ 添加状态
          </button>
          {issue && (
            <p className="validation-hint" role="status">
              {issue}
            </p>
          )}
          {item && (
            <p className="muted">
              修改名称、顺序或移除状态，都不会改变旧记录当时的文字和颜色。之后保存的记录使用新的配置。
            </p>
          )}
          <div className="form-bottom">
            <span className="muted">
              {states.length} 个状态 · {bestFirst ? "好 → 差" : "差 → 好"}
            </span>
            <div className="editor-actions">
              {(item || eventMode) && (
                <button className="secondary" type="button" onClick={cancel}>
                  {item ? "取消编辑" : "取消新增"}
                </button>
              )}
              <button
                className="primary"
                type="submit"
                disabled={disabled || !!issue || !name.trim()}
              >
                {item
                  ? eventMode
                    ? "保存状态配置"
                    : "保存设置"
                  : eventMode
                    ? "创建事件"
                    : "添加关注项"}
              </button>
            </div>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
