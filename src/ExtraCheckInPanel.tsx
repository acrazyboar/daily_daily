import { useState } from "react";
import { baseScheduled, isExtra, isSkipped, repeatOn } from "./model";
import type { Focus } from "./model";
export default function ExtraCheckInPanel({
  items,
  today,
  disabled,
  add,
  openDate,
  close,
}: {
  items: Focus[];
  today: string;
  disabled: boolean;
  add: (item: Focus, date: string) => Promise<boolean>;
  openDate: (itemId: string, date: string) => void;
  close: () => void;
}) {
  const [date, setDate] = useState(today);
  const [id, setId] = useState("");
  const [added, setAdded] = useState<{ id: string; date: string } | null>(null);
  const candidates = items.filter(
    (i) =>
      !i.event &&
      !i.archived &&
      ["weekly", "monthly"].includes(repeatOn(i, date).kind),
  );
  const item = candidates.find((i) => i.id === id) ?? candidates[0];
  const issue = !date
    ? "请选择日期。"
    : !item
      ? "所选日期没有适用的每周或每月打卡项。"
      : date < item.createdOn
        ? "日期不能早于项目创建日期。"
        : isSkipped(item, date)
          ? "这一天已跳过，请在日期详情或跳过列表中恢复。"
          : baseScheduled(item, date)
            ? "这一天已在原计划中，不用额外添加。"
            : isExtra(item, date)
              ? "这一天已经额外添加过了。"
              : "";
  return (
    <section className="extra-check-in-panel" aria-label="额外添加一次">
      <div className="section-heading">
        <h2>额外添加一次</h2>
        <button className="secondary" disabled={disabled} onClick={close}>
          收起
        </button>
      </div>
      <p className="muted">
        适用于调休、临时安排等情况，只增加这一天，不改变每周或每月的重复规则。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (item && !issue && (await add(item, date)))
            setAdded({ id: item.id, date });
        }}
      >
        <fieldset disabled={disabled}>
          <div className="extra-fields">
            <div>
              <label htmlFor="extra-date">添加日期</label>
              <input
                id="extra-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="extra-item">打卡项</label>
              <select
                id="extra-item"
                value={item?.id ?? ""}
                onChange={(e) => setId(e.target.value)}
              >
                {!candidates.length && <option value="">无适用项目</option>}
                {candidates.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {issue && (
            <p className="muted" role="status">
              {issue}
            </p>
          )}
          <div className="form-bottom">
            <span className="muted">
              未来日期可先安排，到当天才能填写记录。
            </span>
            <button
              className="primary"
              type="submit"
              disabled={disabled || !!issue}
            >
              添加这一次
            </button>
          </div>
        </fieldset>
      </form>
      {added && (
        <button
          className="folder-link"
          onClick={() => openDate(added.id, added.date)}
        >
          在概览中查看 {added.date} 的安排 →
        </button>
      )}
    </section>
  );
}
