import {
  effectiveEnd,
  isScheduled,
  isSkipped,
  missingLabel,
  quality,
  tone,
} from "./model";
import type { Entry, Focus } from "./model";
import EventTimeline from "./EventTimeline";

export default function YearOverview({
  year,
  items,
  records,
  today,
  selection,
  onSelect,
}: {
  year: number;
  items: Focus[];
  records: Entry[];
  today: string;
  selection: { id: string; date: string } | null;
  onSelect: (value: { id: string; date: string }) => void;
}) {
  const first = new Date(year, 0, 1);
  const offset = (first.getDay() + 6) % 7;
  const count = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
  const weeks = Math.ceil((offset + count) / 7);
  const dates = Array.from({ length: count }, (_, index) => {
    const date = new Date(year, 0, index + 1);
    return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  const entries = new Map(
    records.map((record) => [`${record.itemId}:${record.date}`, record]),
  );
  const columns = { gridTemplateColumns: `repeat(${weeks}, 12px)` };
  return (
    <div className="year-overview">
      {items.map((item) => (
        <section
          className="year-card"
          key={item.id}
          aria-label={`${item.name} ${year}年记录`}
        >
          <div className="year-card-heading">
            <h3>
              {item.name}
              {item.event && <small>事件</small>}
              {item.archived && <small>已移除</small>}
            </h3>
            <span className="muted">
              全年已记录 {records.filter((r) => r.itemId === item.id).length} 天
            </span>
          </div>
          <div
            className="year-scroll"
            tabIndex={0}
            role="region"
            aria-label={`${item.name} 全年每日记录，可横向滚动`}
          >
            {item.event ? (
              <EventTimeline
                item={item}
                records={records}
                start={`${year}-01-01`}
                end={`${year}-12-31`}
                today={today}
                selection={selection}
                onSelect={onSelect}
                scale="year"
              />
            ) : (
              <div className="year-chart">
                <div className="year-months" style={columns}>
                  {Array.from({ length: 12 }, (_, month) => (
                    <span
                      key={month}
                      style={{
                        gridColumn:
                          Math.floor(
                            ((Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) /
                              86_400_000 +
                              offset) /
                              7,
                          ) + 1,
                      }}
                    >
                      {month + 1}月
                    </span>
                  ))}
                </div>
                <div className="year-weekdays" aria-hidden="true">
                  <span>一</span>
                  <span />
                  <span>三</span>
                  <span />
                  <span>五</span>
                  <span />
                  <span>日</span>
                </div>
                <div className="year-days" style={columns}>
                  {Array.from({ length: offset }, (_, i) => (
                    <span key={`blank-${i}`} />
                  ))}
                  {dates.map((date) => {
                    const record = isSkipped(item, date)
                      ? undefined
                      : entries.get(`${item.id}:${date}`);
                    const unavailable =
                      !isScheduled(item, date) ||
                      date > today ||
                      date < item.createdOn ||
                      (!!effectiveEnd(item) && date > effectiveEnd(item)!);
                    const label =
                      record?.statusLabel ?? missingLabel(item, date, today);
                    const color = record ? tone(record.quality) : undefined;
                    return (
                      <button
                        key={date}
                        className={`year-day ${isSkipped(item, date) ? "skipped-day" : ""} ${unavailable && !record ? "unavailable" : ""} ${selection?.id === item.id && selection.date === date ? "cell-selected" : ""} ${date === today ? "year-today" : ""}`}
                        style={
                          color
                            ? { ...color, backgroundColor: color.borderColor }
                            : undefined
                        }
                        title={`${date} · ${label}`}
                        aria-label={`${item.name} ${date} ${label}`}
                        aria-current={date === today ? "date" : undefined}
                        aria-pressed={
                          selection?.id === item.id && selection.date === date
                        }
                        onClick={() => onSelect({ id: item.id, date })}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="year-card-legend">
            <span className="muted">
              {item.bestFirst ? "好 → 差" : "差 → 好"}
            </span>
            <div className="state-swatches">
              {item.states.map((state, index) => (
                <span
                  key={state.id}
                  className="mini-state"
                  style={tone(
                    quality(index, item.states.length, item.bestFirst),
                  )}
                >
                  {state.label}
                </span>
              ))}
            </div>
            <span className="muted">
              {item.event
                ? "连续色带表示事件跨度，浅色为未记录或计划中"
                : "空格为未记录，斜纹为已跳过，浅色为无需打卡或未来日期"}
            </span>
          </div>
        </section>
      ))}
      <p className="year-explainer">
        长期关注使用每日格子；事件使用连续时间条。颜色保留记录当时的等级，点击可查看详情。
      </p>
    </div>
  );
}
