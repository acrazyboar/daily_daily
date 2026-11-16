import { useState } from "react";
import type { PointerEvent, MouseEvent } from "react";
import { effectiveEnd, missingLabel, tone } from "./model";
import type { Entry, Focus } from "./model";
const ordinal = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value.getTime() / 86_400_000;
};
const dateAt = (day: number) =>
  new Date(day * 86_400_000).toISOString().slice(0, 10);
export default function EventTimeline({
  item,
  records,
  start,
  end,
  today,
  selection,
  onSelect,
  scale,
}: {
  item: Focus;
  records: Entry[];
  start: string;
  end: string;
  today: string;
  selection: { id: string; date: string } | null;
  onSelect: (value: { id: string; date: string }) => void;
  scale: "month" | "year";
}) {
  const [hover, setHover] = useState<string | null>(null);
  const periodStart = ordinal(start),
    periodEnd = ordinal(end),
    total = periodEnd - periodStart + 1;
  const eventEnd = effectiveEnd(item);
  const visibleEnd = eventEnd ?? today;
  const from = Math.max(periodStart, ordinal(item.event!.startDate));
  const to = Math.min(periodEnd, ordinal(visibleEnd));
  const count = to - from + 1;
  const entries = new Map(
    records.filter((r) => r.itemId === item.id).map((r) => [r.date, r]),
  );
  if (count <= 0)
    return <div className="event-timeline-empty">此时间范围内暂无事件日期</div>;
  const selected =
    selection?.id === item.id &&
    ordinal(selection.date) >= from &&
    ordinal(selection.date) <= to
      ? selection.date
      : null;
  const current =
    selected ?? dateAt(Math.max(from, Math.min(to, ordinal(today))));
  const readout = hover ?? current;
  const status = (date: string) =>
    entries.get(date)?.statusLabel ?? missingLabel(item, date, today);
  const runs: { color: string; first: number; last: number }[] = [];
  for (let i = 0; i < count; i++) {
    const date = dateAt(from + i);
    const entry = entries.get(date);
    const color = entry
      ? String(tone(entry.quality).backgroundColor)
      : date > today
        ? "#f0f3ec"
        : "#dce5d3";
    const last = runs[runs.length - 1];
    if (last?.color === color) last.last = i + 1;
    else runs.push({ color, first: i, last: i + 1 });
  }
  const gradient =
    "linear-gradient(to right," +
    runs
      .map(
        (run) =>
          `${run.color} ${(run.first / count) * 100}%, ${run.color} ${(run.last / count) * 100}%`,
      )
      .join(",") +
    ")";
  const dayUnderPointer = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return dateAt(
      from +
        Math.min(
          count - 1,
          Math.max(
            0,
            Math.floor(((event.clientX - rect.left) / rect.width) * count),
          ),
        ),
    );
  };
  const choose = (date: string) => onSelect({ id: item.id, date });
  return (
    <div
      className={`event-timeline event-timeline-${scale}`}
      data-start={dateAt(from)}
      data-end={dateAt(to)}
      style={{ minWidth: scale === "month" ? total * 36 : 780 }}
    >
      {scale === "year" && (
        <div className="event-month-axis" aria-hidden="true">
          {Array.from({ length: 12 }, (_, month) => {
            const key =
              start.slice(0, 4) +
              "-" +
              String(month + 1).padStart(2, "0") +
              "-01";
            return (
              <span
                key={month}
                style={{
                  left: `${((ordinal(key) - periodStart) / total) * 100}%`,
                }}
              >
                {month + 1}月
              </span>
            );
          })}
        </div>
      )}
      <div className="event-range-caption">
        <span>
          {item.event!.startDate} → {visibleEnd}
          {!eventEnd ? "（进行中）" : ""}
        </span>
        <span>
          {item.event!.startDate < start ? "← 跨期延续" : ""}
          {visibleEnd > end ? " · 延续至本期之后 →" : ""}
        </span>
      </div>
      <div className="event-timeline-track">
        <div
          role="slider"
          tabIndex={0}
          className={`event-band ${selected ? "event-band-selected" : ""}`}
          aria-label={`${item.name} 连续时间条`}
          aria-valuemin={0}
          aria-valuemax={count - 1}
          aria-valuenow={ordinal(current) - from}
          aria-valuetext={`${current} ${status(current)}`}
          aria-orientation="horizontal"
          title="点击日期查看详情，方向键可逐日选择"
          style={{
            left: `${((from - periodStart) / total) * 100}%`,
            width: `${(count / total) * 100}%`,
            background: gradient,
            borderTopLeftRadius:
              from > periodStart || item.event!.startDate === start ? 10 : 0,
            borderBottomLeftRadius:
              from > periodStart || item.event!.startDate === start ? 10 : 0,
            borderTopRightRadius: visibleEnd <= end ? 10 : 0,
            borderBottomRightRadius: visibleEnd <= end ? 10 : 0,
          }}
          onClick={(e) => choose(dayUnderPointer(e))}
          onPointerMove={(e) => setHover(dayUnderPointer(e))}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            const offsets: Record<string, number> = {
              ArrowLeft: -1,
              ArrowRight: 1,
              ArrowUp: 1,
              ArrowDown: -1,
              PageUp: 7,
              PageDown: -7,
            };
            if (e.key === "Home" || e.key === "End" || e.key in offsets) {
              e.preventDefault();
              setHover(null);
              choose(
                dateAt(
                  e.key === "Home"
                    ? from
                    : e.key === "End"
                      ? to
                      : Math.max(
                          from,
                          Math.min(to, ordinal(current) + offsets[e.key]),
                        ),
                ),
              );
            }
          }}
        >
          {selected && (
            <span
              className="event-selection-marker"
              style={{
                left: `${((ordinal(selected) - from + 0.5) / count) * 100}%`,
              }}
            />
          )}
          {item.event!.startDate < start && (
            <span className="event-continuation-left" aria-hidden="true">
              ‹
            </span>
          )}
          {visibleEnd > end && (
            <span className="event-continuation-right" aria-hidden="true">
              ›
            </span>
          )}
        </div>
      </div>
      <div className="event-timeline-readout">
        <output>
          {readout} · {status(readout)}
        </output>
        <span>点击时间条选日期 · ← → 逐日查看</span>
      </div>
    </div>
  );
}
