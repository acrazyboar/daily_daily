import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

export default function MonthlyViewport({ today, children }: { today: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const table = element.querySelector("table");
    let previousWidth = -1;
    let previousTableWidth = -1;
    function revealToday() {
      const current = element.querySelector<HTMLElement>('thead th[aria-current="date"]');
      if (!current) return;
      const bounds = element.getBoundingClientRect();
      const cell = current.getBoundingClientRect();
      const label = element.querySelector('thead th:first-child')?.getBoundingClientRect();
      const left = bounds.left + element.clientLeft + (label?.width ?? 0);
      const right = bounds.left + element.clientLeft + element.clientWidth;
      if (cell.right > right + 1 || cell.left < left - 1) {
        // Keep the full month, moving only the viewport. Do not scroll the page vertically.
        element.scrollLeft = Math.max(0, element.scrollLeft + cell.right - right);
      }
    }
    function resize() {
      const width = element.clientWidth;
      const tableWidth = table?.getBoundingClientRect().width ?? 0;
      if (width === previousWidth && tableWidth === previousTableWidth) return;
      previousWidth = width;
      previousTableWidth = tableWidth;
      revealToday();
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [today]);
  return (
    <div ref={viewport} className="matrix-scroll" tabIndex={0} role="region" aria-label="月度内容记录表，可横向滚动">
      {children}
    </div>
  );
}
