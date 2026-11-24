import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import StorageSettings from "./StorageSettings";

export default function StorageGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "setup" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void invoke<{ setupRequired: boolean }>("storage_info").then(info => {
      if (active) { setError(""); setStatus(info.setupRequired ? "setup" : "ready"); }
    }).catch(e => { if (active) { setError(String(e)); setStatus("error"); } });
    return () => { active = false; };
  }, [retry]);
  if (status === "ready") return children;
  return <main className="storage-onboarding" aria-label="首次设置数据文件夹">
    <div className="onboarding-brand"><span className="brand-icon" aria-hidden="true">日</span><strong>日日记</strong></div>
    <header className="onboarding-header">
      <p className="eyebrow">WELCOME TO DAILY LOG</p>
      <h1>先为记录选一个家。</h1>
      <p className="muted">选择数据文件夹后开始使用。以后可在“设置 → 数据存储”中更改。</p>
    </header>
    {status === "loading" && <p role="status">正在检查数据位置…</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {(status === "error" || !!error) && <button className="primary" disabled={pending} onClick={() => setRetry(n => n + 1)}>重新检查</button>}
    {status === "setup" && <StorageSettings initialSetup data={null} disabled={pending} onPending={setPending}
      change={async (command, args) => {
        setPending(true); setError("");
        try {
          await invoke(command, { ...args, expectedRevision: "", clockGeneration: 0 });
          const info = await invoke<{ setupRequired: boolean }>("storage_info");
          if (info.setupRequired) throw new Error("数据文件夹尚未设置成功，请重试。");
          setStatus("ready");
          return true;
        } catch(e) { setError(String(e)); return false; }
        finally { setPending(false); }
      }} />}
  </main>;
}
