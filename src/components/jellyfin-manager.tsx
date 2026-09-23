"use client";

import { useCallback, useEffect, useState } from "react";

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  remoteUserName: string;
  serverName: string | null;
  serverVersion: string | null;
  allowPrivateHost: boolean;
  lastCheckedAt: string | null;
  warning: string | null;
}

interface ProbeResult {
  ok: boolean;
  serverName?: string;
  version?: string;
  startupWizardCompleted?: boolean;
  error?: string;
}

/** Jellyfin / Emby 连接管理。 */
export default function JellyfinManager() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/media/jellyfin", { cache: "no-store" });
      const body = (await response.json()) as { connections?: Connection[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "加载失败");
      setConnections(body.connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 只测连通性，不提交凭据 —— 让「地址对不对」与「密码对不对」分开排查。 */
  const probe = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch("/api/media/jellyfin?action=probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const body = (await response.json()) as ProbeResult;
      if (!body.ok) throw new Error(body.error ?? "连接失败");
      setNotice(
        `连通成功：${body.serverName}（${body.version}）` +
          (body.startupWizardCompleted === false
            ? " —— 但该服务器尚未完成初始化向导，无法登录"
            : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/media/jellyfin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || baseUrl,
          baseUrl,
          username,
          password,
          allowPrivateHost: allowPrivate,
        }),
      });
      const body = (await response.json()) as { error?: string; connection?: Connection };
      if (!response.ok) throw new Error(body.error ?? "连接失败");
      setNotice(`已连接 ${body.connection?.serverName ?? baseUrl}`);
      setPassword("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/media/jellyfin?id=${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "断开失败");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const recheck = async (id: string) => {
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/media/jellyfin?id=${id}`, { method: "PATCH" });
      const body = (await response.json()) as { ok: boolean; error?: string; version?: string };
      if (body.ok) setNotice(`连接正常（${body.version}）`);
      else setError(body.error ?? "连接异常");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">已连接的媒体服务器</h2>
        {connections.length === 0 ? (
          <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">
            还没有连接。下面填你自己的 Jellyfin / Emby 地址即可。
          </p>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className={`space-y-2 rounded border p-3 text-sm ${
                  connection.warning
                    ? "border-amber-900 bg-amber-950/20"
                    : "border-neutral-800 bg-neutral-900/40"
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{connection.name}</span>
                <span className="font-mono text-xs text-neutral-500">{connection.baseUrl}</span>
                <span className="text-xs text-neutral-400">账号 {connection.remoteUserName}</span>
                {connection.serverVersion && (
                  <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                    v{connection.serverVersion}
                  </span>
                )}
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => void recheck(connection.id)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                  >
                    测试
                  </button>
                  <button
                    type="button"
                    onClick={() => void disconnect(connection.id)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50"
                  >
                    断开
                  </button>
                </div>
                </div>
                {connection.warning && (
                  <p className="text-xs text-amber-300">⚠️ {connection.warning}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">连接新的服务器</h2>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="服务器地址，例如 http://192.168.1.10:8096"
              className="min-w-72 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => void probe()}
              disabled={busy || baseUrl.trim().length === 0}
              className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
            >
              仅测试连通
            </button>
          </div>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="名称（可选），例如「宿舍服务器」"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />

          <div className="flex flex-wrap gap-3">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Jellyfin 用户名"
              autoComplete="off"
              className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Jellyfin 密码"
              autoComplete="off"
              className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={allowPrivate}
              onChange={(event) => setAllowPrivate(event.target.checked)}
              className="size-3.5 accent-sky-500"
            />
            允许内网地址（自建 Jellyfin 通常在校园网或局域网，需要勾选）
          </label>

          {/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(baseUrl.trim()) && (
            <p className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              这个地址只有服务器本机能访问。学生从自己电脑打开页面时浏览器会去找
              <strong>他自己的机器</strong>，必然播不了。请填写服务器在局域网里的地址
              （用 <code>ip addr</code> 查，类似 <code>http://10.x.x.x:8096</code>）。
            </p>
          )}

          <button
            type="button"
            onClick={() => void connect()}
            disabled={
              busy ||
              baseUrl.trim().length === 0 ||
              username.trim().length === 0 ||
              password.length === 0
            }
            className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? "连接中…" : "连接"}
          </button>

          <p className="text-xs text-neutral-500">
            密码仅用于换取访问令牌，**不会保存**；保存的是令牌本身，且只存在服务端。
          </p>
        </div>
      </section>

      {notice && (
        <p className="rounded border border-sky-900 bg-sky-950/30 px-3 py-2 text-sm text-sky-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
