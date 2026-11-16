import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import StorageSettings from "./StorageSettings";
import { DEFAULT_THEME, THEMES } from "./theme";
import type { Snapshot } from "./model";
export default function SettingsDialog({ data, busy, storagePending, theme, themeError, error, message, externalChange, onTheme, onClose, change, onPending }: {
  data: Snapshot | null;
  busy: boolean;
  storagePending: boolean;
  theme: string;
  themeError: string;
  error: string;
  message: string;
  externalChange: boolean;
  onTheme: (color: string) => void;
  onClose: () => void;
  change: (command: string, args: Record<string, unknown>, success: string) => Promise<boolean>;
  onPending: (pending: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"appearance" | "storage">("appearance");
  const blocked = busy || storagePending;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const modal = dialog.current!;
    modal.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return createPortal(
    <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title"
      onCancel={e => { e.preventDefault(); if (!blocked) onClose(); }}
      onClick={e => {
        const bounds = e.currentTarget.getBoundingClientRect();
        if (e.target === e.currentTarget && !blocked && (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom)) onClose();
      }}>
      <div className="settings-header">
        <div><p className="eyebrow">PREFERENCES</p><h2 id="settings-title">设置</h2></div>
        <button autoFocus className="secondary settings-close" aria-label="关闭设置" disabled={blocked} onClick={onClose}>✕</button>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={e => {
        if (blocked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === "Home" ? "appearance" : e.key === "End" ? "storage" : tab === "appearance" ? "storage" : "appearance";
        setTab(next);
        document.getElementById(next + "-tab")?.focus();
      }}>
        <button id="appearance-tab" role="tab" tabIndex={tab === "appearance" ? 0 : -1} aria-selected={tab === "appearance"} aria-controls="appearance-panel" disabled={blocked} onClick={() => setTab("appearance")}>外观</button>
        <button id="storage-tab" role="tab" tabIndex={tab === "storage" ? 0 : -1} aria-selected={tab === "storage"} aria-controls="storage-panel" disabled={blocked} onClick={() => setTab("storage")}>数据存储</button>
      </div>
      <div className="settings-content">
        {error && <p className="notice error" role="alert">{error}</p>}
        {message && <p className="notice success" role="status">{message}</p>}
        {externalChange && <p className="notice error" role="alert">数据文件已被外部修改。请关闭设置，复制未保存的内容后刷新记录，再调整存储位置。</p>}
        <section id="appearance-panel" role="tabpanel" aria-labelledby="appearance-tab" hidden={tab !== "appearance"}>
          <h3>主题色</h3>
          <p className="muted">选一个喜欢的颜色，即刻应用到导航、按钮与界面配色。</p>
          <div className="theme-options" role="group" aria-label="主题色">
            {THEMES.map(option => <button key={option.color} className="theme-option" aria-pressed={theme === option.color} onClick={() => onTheme(option.color)}>
              <span className="theme-swatch" style={{ backgroundColor: option.color }} aria-hidden="true">{theme === option.color ? "✓" : ""}</span>
              {option.name}
            </button>)}
          </div>
          <div className="custom-theme">
            <label htmlFor="custom-theme-color">自定义颜色</label>
            <input id="custom-theme-color" type="color" value={theme} onChange={e => onTheme(e.target.value)} />
            <span>{theme.toUpperCase()}</span>
          </div>
          <p className="muted">偏好保存在这台设备上。打卡状态原有的红绿等级颜色保持不变。</p>
          <button className="secondary" disabled={theme === DEFAULT_THEME} onClick={() => onTheme(DEFAULT_THEME)}>恢复默认主题</button>
          {themeError && <p className="notice error" role="alert">{themeError}</p>}
        </section>
        <section id="storage-panel" role="tabpanel" aria-labelledby="storage-tab" hidden={tab !== "storage"}>
          <StorageSettings data={data} disabled={blocked || externalChange} change={change} onPending={onPending} />
        </section>
      </div>
      <div className="settings-footer"><span className="muted">主题自动保存 · 数据迁移需单独确认</span><button className="primary" disabled={blocked} onClick={onClose}>完成</button></div>
    </dialog>, document.body,
  );
}
