import { useState } from "react";
import FocusEditor from "./FocusEditor";
import { canRecord, effectiveEnd, eventPhase, quality, tone } from "./model";
import type { Focus, Entry } from "./model";
type Action = (
  command: string,
  args: Record<string, unknown>,
  message: string,
) => Promise<boolean>;
export default function EventManager({
  items,
  records,
  today,
  disabled,
  action,
  goRecord,
}: {
  items: Focus[];
  records: Entry[];
  today: string;
  disabled: boolean;
  action: Action;
  goRecord: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState("");
  const [confirm, setConfirm] = useState("");
  const [extending, setExtending] = useState("");
  const [until, setUntil] = useState("");
  const [tab, setTab] = useState("all");
  const events = items.filter((i) => i.event);
  const shown = events
    .filter((item) => {
      const phase = eventPhase(item, today).key;
      return (
        tab === "all" ||
        (tab === "active"
          ? phase === "active" || phase === "due"
          : tab === "ended"
            ? phase === "ended" || phase === "expired"
            : phase === tab)
      );
    })
    .sort((a, b) => b.event!.startDate.localeCompare(a.event!.startDate));
  function nextDate(date: string) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return (
    <div className="events-page">
      <div className="events-toolbar">
        <div>
          <h2>把一段经历，单独记下来。</h2>
          <p className="muted">
            可用于短期计划、一次旅行，或者一件尚未确定何时结束的事。
          </p>
        </div>
        <button
          className="primary"
          disabled={disabled}
          onClick={() => {
            setCreating(true);
            setEditing("");
          }}
        >
          ＋ 新增事件
        </button>
      </div>
      {(creating || editing) && (
        <FocusEditor
          key={editing || "new-event"}
          item={items.find((i) => i.id === editing)}
          eventMode
          today={today}
          disabled={disabled}
          cancel={() => {
            setCreating(false);
            setEditing("");
          }}
          save={async (name, states, bestFirst, details) => {
            const ok = await action(
              editing ? "update_focus_states" : "add_event",
              editing
                ? { itemId: editing, states, bestFirst }
                : { draft: { name, states, bestFirst, ...details } },
              editing
                ? "事件状态配置已保存，历史记录保持原样。"
                : "事件已创建，到起始日即可记录。",
            );
            if (ok) {
              setCreating(false);
              setEditing("");
              setTab("all");
            }
            return ok;
          }}
        />
      )}
      <div className="event-tabs" role="group" aria-label="事件筛选">
        {[
          { key: "all", label: "全部" },
          { key: "active", label: "进行中" },
          { key: "upcoming", label: "未开始" },
          { key: "ended", label: "已结束 / 到期" },
        ].map((t) => (
          <button
            key={t.key}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!shown.length && (
        <div className="empty-state">
          <h2>{events.length ? "这一类暂时没有事件" : "从一段新的经历开始"}</h2>
          <p>创建事件后，可在有效日期内每天记录状态与备注。</p>
        </div>
      )}
      <div className="event-list">
        {shown.map((item) => {
          const event = item.event!;
          const phase = eventPhase(item, today);
          const count = records.filter((r) => r.itemId === item.id).length;
          const due =
            !event.endedOn && !!event.endDate && event.endDate <= today;
          const finishable = !event.endedOn && canRecord(item, today);
          const minEnd =
            event.endDate && event.endDate >= today
              ? nextDate(event.endDate)
              : today;
          return (
            <section
              className="event-card"
              key={item.id}
              aria-label={`事件 ${item.name}`}
            >
              <div className="event-heading">
                <h3>{item.name}</h3>
                <span className={`badge event-phase-${phase.key}`}>
                  {phase.label}
                </span>
              </div>
              {event.description && (
                <p className="event-description">{event.description}</p>
              )}
              <p className="event-period">
                {event.startDate} 开始 ·{" "}
                {event.endDate
                  ? `计划于 ${event.endDate} 结束`
                  : "未设结束日期"}
                {event.endedOn ? ` · 已于 ${event.endedOn} 结束` : ""}
              </p>
              <div className="state-swatches">
                {item.states.map((s, index) => (
                  <span
                    className="mini-state"
                    key={s.id}
                    style={tone(
                      quality(index, item.states.length, item.bestFirst),
                    )}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              <div className="event-card-footer">
                <span className="muted">
                  已记录 {count} 天
                  {effectiveEnd(item) === today ? " · 今天仍可记录" : ""}
                </span>
                <div className="event-actions">
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setEditing(item.id);
                      setCreating(false);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    编辑状态
                  </button>
                  {canRecord(item, today) && (
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={goRecord}
                    >
                      记录今天
                    </button>
                  )}
                  {finishable && (
                    <button
                      className="secondary finish-event-button"
                      disabled={disabled}
                      onClick={() => {
                        setConfirm(item.id);
                        setExtending("");
                      }}
                    >
                      结束事件
                    </button>
                  )}
                  {due && (
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() => {
                        setExtending(item.id);
                        setUntil(minEnd);
                        setConfirm("");
                      }}
                    >
                      {phase.key === "expired" ? "延期继续记录" : "延期"}
                    </button>
                  )}
                </div>
              </div>
              {phase.key === "due" && !confirm && !extending && (
                <p className="event-due-hint">
                  今天是计划结束日；如需继续，可点击“延期”继续记录。
                </p>
              )}
              {confirm === item.id && (
                <div className="event-inline-panel">
                  <p>
                    将「{item.name}
                    」结束于今天？今天仍可记录，明天起不再显示在“今日”中。历史记录会保留。
                  </p>
                  <div className="editor-actions">
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() => setConfirm("")}
                    >
                      取消
                    </button>
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={async () => {
                        if (
                          await action(
                            "finish_event",
                            { itemId: item.id, expectedDate: today },
                            `「${item.name}」已于今天结束，历史记录保留。`,
                          )
                        )
                          setConfirm("");
                      }}
                    >
                      确认结束
                    </button>
                  </div>
                </div>
              )}
              {extending === item.id && (
                <form
                  className="event-inline-panel"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await action(
                        "extend_event",
                        {
                          itemId: item.id,
                          endDate: until,
                          expectedDate: today,
                        },
                        `「${item.name}」已延期至 ${until}。`,
                      )
                    )
                      setExtending("");
                  }}
                >
                  <label htmlFor={`extend-${item.id}`}>新的结束日期</label>
                  <input
                    id={`extend-${item.id}`}
                    type="date"
                    min={minEnd}
                    required
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    disabled={disabled}
                  />
                  <p className="muted">延期后可继续每天记录；原有记录保留。</p>
                  <div className="editor-actions">
                    <button
                      className="secondary"
                      type="button"
                      disabled={disabled}
                      onClick={() => setExtending("")}
                    >
                      取消
                    </button>
                    <button
                      className="primary"
                      type="submit"
                      disabled={disabled || !until || until < minEnd}
                    >
                      确认延期
                    </button>
                  </div>
                </form>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
