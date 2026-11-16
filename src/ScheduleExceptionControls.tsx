import {
  baseScheduled,
  isExtra,
  isScheduled,
  isSkipped,
  repeatOn,
} from "./model";
import type { Entry, ExceptionAction, Focus } from "./model";
export default function ScheduleExceptionControls({
  item,
  date,
  entry,
  disabled,
  change,
}: {
  item: Focus;
  date: string;
  entry?: Entry;
  disabled: boolean;
  change: (action: ExceptionAction) => Promise<boolean>;
}) {
  if (item.event || date < item.createdOn) return null;
  const skipped = isSkipped(item, date),
    extra = isExtra(item, date);
  if (item.archived && !skipped && !extra) return null;
  const kind = repeatOn(item, date).kind;
  return (
    <div className="schedule-exception-controls" aria-label="单日安排">
      {skipped ? (
        <>
          <span className="skip-note">
            这一天已跳过{entry ? "，原记录仍保留" : "，不算漏填"}
          </span>
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => void change("unskip")}
          >
            恢复这一天
          </button>
        </>
      ) : (
        <>
          {extra && <span className="extra-note">＋ 本次额外添加</span>}
          {!item.archived && (isScheduled(item, date) || entry) && (
            <button
              className="secondary skip-button"
              disabled={disabled}
              onClick={() => void change("skip")}
            >
              跳过这一天
            </button>
          )}
          {!item.archived &&
            !baseScheduled(item, date) &&
            !extra &&
            (kind === "weekly" || kind === "monthly") && (
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void change("add")}
              >
                ＋ 额外添加这一天
              </button>
            )}
          {extra && !entry && (
            <button
              className="text-button"
              disabled={disabled}
              onClick={() => void change("removeAdd")}
            >
              取消本次添加
            </button>
          )}
        </>
      )}
    </div>
  );
}
