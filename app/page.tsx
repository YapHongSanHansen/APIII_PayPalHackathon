"use client";

import { useCallback, useEffect, useState } from "react";

type Res = { status: number; headers: Record<string, string>; body: any };
type LogEntry = { id: number; at: string; method: string; url: string; status: number; body: any };

const STORE = "apiii-test-v1";
const money = (cents?: number | null) => (cents == null ? "–" : `$${(cents / 100).toFixed(2)}`);

export default function TestConsole() {
  const [status, setStatus] = useState<any>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // 1. Seller
  const [seller, setSeller] = useState({
    baseUrl: "",
    samplePath: "deals?q=airpods pro",
    keyHeader: "x-demo-key",
    keyValue: "demo-secret-key",
    sellerEmail: "seller-dealfinder@example.com",
    paypalEmail: "",
  });
  const [draft, setDraft] = useState<any>(null);
  const [edit, setEdit] = useState({ name: "", slug: "", description: "", price: 2, promise: "" });
  const [apis, setApis] = useState<any[]>([]);

  // 2. Owner wallet
  const [walletForm, setWalletForm] = useState({ ownerEmail: "owner-alice@example.com", budgetUsd: 20, maxPrice: 10 });
  const [wallet, setWallet] = useState<{ id: string; key: string } | null>(null);
  const [walletInfo, setWalletInfo] = useState<any>(null);

  // 3. Agent calls
  const [slug, setSlug] = useState("");
  const [mode, setMode] = useState<"escrow" | "direct">("escrow");
  const [callPath, setCallPath] = useState("deals?q=airpods pro");
  const [pack, setPack] = useState<{ id: string; token: string } | null>(null);
  const [packInfo, setPackInfo] = useState<any>(null);
  const [lastCall, setLastCall] = useState<Res | null>(null);
  const [demoMode, setDemoMode] = useState("ok");
  const [settlement, setSettlement] = useState<any>(null);

  // 4. Agent run + tables
  const [goal, setGoal] = useState("Find me the cheapest AirPods Pro");
  const [agentRun, setAgentRun] = useState<any>(null);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [packs, setPacks] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);

  const call = useCallback(async (method: string, url: string, body?: unknown, token?: string | null): Promise<Res> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k.startsWith("x-apiii")) h[k] = v;
    });
    setLog((l) => [{ id: Date.now() + Math.random(), at: new Date().toLocaleTimeString(), method, url, status: r.status, body: parsed }, ...l].slice(0, 60));
    return { status: r.status, headers: h, body: parsed };
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setLog((l) => [{ id: Date.now(), at: new Date().toLocaleTimeString(), method: "ERR", url: label, status: 0, body: String(err) }, ...l]);
    } finally {
      setBusy(null);
    }
  };

  const refreshStatus = useCallback(async () => {
    const r = await fetch("/api/status");
    const s = await r.json();
    setStatus(s);
    setDemoMode(s.demo_seller_mode ?? "ok");
  }, []);

  const refreshApis = useCallback(async () => {
    const list = await (await fetch("/v1/apis")).json();
    setApis(Array.isArray(list) ? list : []);
    if (Array.isArray(list) && list.length) setSlug((s) => s || list[0].slug);
  }, []);

  const refreshTables = useCallback(async () => {
    const [r, p, o] = await Promise.all([fetch("/v1/receipts?limit=50"), fetch("/api/packs"), fetch("/api/payouts")]);
    setReceipts(await r.json());
    setPacks(await p.json());
    setPayouts(await o.json());
  }, []);

  const refreshWallet = useCallback(async (id?: string) => {
    const wid = id ?? wallet?.id;
    if (!wid) return;
    const r = await fetch(`/api/wallets/${wid}`);
    if (r.ok) setWalletInfo(await r.json());
  }, [wallet]);

  const refreshPack = useCallback(async (id?: string) => {
    const pid = id ?? pack?.id;
    if (!pid) return;
    const r = await fetch(`/v1/packs/${pid}`);
    if (r.ok) setPackInfo(await r.json());
  }, [pack]);

  // Restore saved state + handle PayPal redirects (?vault=connected, ?pack=…&approved=1)
  useEffect(() => {
    setSeller((s) => ({ ...s, baseUrl: `${window.location.origin}/demo-seller` }));
    let saved: any = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    } catch {}
    if (saved.wallet) setWallet(saved.wallet);
    if (saved.pack) setPack(saved.pack);
    if (saved.slug) setSlug(saved.slug);
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("vault") || sp.get("pack")) window.history.replaceState({}, "", "/");
    refreshStatus();
    refreshApis();
    refreshTables();
    if (saved.wallet) fetch(`/api/wallets/${saved.wallet.id}`).then(async (r) => { if (r.ok) setWalletInfo(await r.json()); });
    if (saved.pack) fetch(`/v1/packs/${saved.pack.id}`).then(async (r) => { if (r.ok) setPackInfo(await r.json()); });
  }, [refreshStatus, refreshApis, refreshTables]);

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ wallet, pack, slug }));
    } catch {}
  }, [wallet, pack, slug]);

  // ---- Actions ----

  const probe = () =>
    run("probe", async () => {
      const r = await call("POST", "/api/onboard/probe", {
        baseUrl: seller.baseUrl,
        samples: [{ method: "GET", path: seller.samplePath }],
        keyHeader: seller.keyHeader || undefined,
        keyValue: seller.keyValue || undefined,
      });
      if (r.status !== 200) return;
      setDraft(r.body);
      const d = r.body.draft;
      setEdit({ name: d.name, slug: "", description: d.description, price: d.pricePerCallCents, promise: JSON.stringify(d.promise, null, 2) });
    });

  const publish = () =>
    run("publish", async () => {
      let promise: any;
      try {
        promise = JSON.parse(edit.promise);
      } catch {
        alertLog("Promise is not valid JSON");
        return;
      }
      const r = await call("POST", "/api/onboard/publish", {
        sellerEmail: seller.sellerEmail,
        paypalEmail: seller.paypalEmail || undefined,
        name: edit.name,
        slug: edit.slug || undefined,
        description: edit.description,
        category: draft?.draft?.category,
        baseUrl: seller.baseUrl,
        keyHeader: seller.keyHeader || undefined,
        keyValue: seller.keyValue || undefined,
        samples: [{ method: "GET", path: seller.samplePath }],
        promise,
        pricePerCallCents: edit.price,
        probes: draft?.probes,
      });
      if (r.status === 201) {
        setSlug(r.body.slug);
        await refreshApis();
      }
    });

  const alertLog = (msg: string) =>
    setLog((l) => [{ id: Date.now(), at: new Date().toLocaleTimeString(), method: "NOTE", url: "", status: 0, body: msg }, ...l]);

  const createWallet = () =>
    run("wallet", async () => {
      const r = await call("POST", "/api/wallets", {
        ownerEmail: walletForm.ownerEmail,
        budgetCents: Math.round(walletForm.budgetUsd * 100),
        maxPricePerCallCents: walletForm.maxPrice,
      });
      if (r.status === 201) {
        setWallet({ id: r.body.wallet.id, key: r.body.walletKey });
        setWalletInfo(r.body.wallet);
      }
    });

  const connectPayPal = () =>
    run("vault", async () => {
      if (!wallet) return;
      const r = await call("POST", `/api/wallets/${wallet.id}/vault`);
      if (r.body?.approveUrl) window.location.href = r.body.approveUrl;
    });

  const callWithoutPack = () => run("402", async () => setLastCall(await call("GET", `/v1/apis/${slug}/${callPath}`)));

  const buyPack = () =>
    run("buy", async () => {
      if (!wallet) return alertLog("Create a wallet first (step 2)");
      const r = await call("POST", "/v1/packs", { api: slug, mode }, wallet.key);
      if (r.body?.pack_token) {
        setPack({ id: r.body.pack.id, token: r.body.pack_token });
        setPackInfo(r.body.pack);
        setSettlement(null);
      }
      refreshWallet();
    });

  const approvePack = () => {
    const url = packInfo?.paypal?.approve_url;
    if (url) window.location.href = url;
  };

  const callApi = (times = 1) =>
    run("call", async () => {
      for (let i = 0; i < times; i++) {
        setLastCall(await call("GET", `/v1/apis/${slug}/${callPath}`, undefined, pack?.token));
      }
      await refreshPack();
      await refreshTables();
    });

  const closePack = () =>
    run("close", async () => {
      if (!pack) return;
      const r = await call("POST", `/v1/packs/${pack.id}/close`, undefined, pack.token);
      if (r.status === 200) {
        setSettlement(r.body.settlement);
        setPackInfo(r.body.pack);
      }
      await refreshWallet();
      await refreshTables();
    });

  const setSellerMode = (m: string) =>
    run("mode", async () => {
      const r = await call("POST", "/api/demo-seller/mode", { mode: m });
      if (r.status === 200) setDemoMode(r.body.mode);
    });

  const resetApi = () =>
    run("reset", async () => {
      await call("POST", `/api/apis/${slug}/reset`);
      await refreshApis();
    });

  const runAgent = () =>
    run("agent", async () => {
      if (!wallet) return alertLog("Create a wallet first (step 2)");
      const r = await call("POST", "/api/agent", { goal, walletKey: wallet.key, mode });
      setAgentRun(r.body);
      await refreshWallet();
      await refreshTables();
    });

  const runPayouts = () =>
    run("payouts", async () => {
      await call("POST", "/api/payouts");
      await refreshTables();
    });

  const resetLocal = () => {
    setWallet(null);
    setWalletInfo(null);
    setPack(null);
    setPackInfo(null);
    setSettlement(null);
    setLastCall(null);
    setAgentRun(null);
  };

  const selectedApi = apis.find((a) => a.slug === slug);
  const isMock = status?.paypal?.mode === "mock";

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>
            APIII <span className="muted">test console</span>
          </h1>
          <p className="muted">
            List an API → owner funds an agent wallet with PayPal → agent buys a pack, calls, pays only for answers that keep the promise.
          </p>
        </div>
        <div className="pills">
          <Pill ok={status?.paypal?.mode === "sandbox"} label={`PayPal: ${status?.paypal?.mode ?? "…"}`} />
          <Pill ok={status?.openai?.enabled} label={`OpenAI: ${status?.openai?.enabled ? status.openai.model : "off (heuristics)"}`} />
          <Pill ok label={`DB: ${status?.database ?? "…"}`} />
          <Pill ok={status?.channel3} label={`Channel3: ${status?.channel3 ? "on" : "mock data"}`} />
          <button className="ghost" onClick={refreshStatus}>↻</button>
        </div>
      </header>

      {isMock && (
        <div className="banner">
          PayPal is in <b>mock mode</b> (no <code>PAYPAL_CLIENT_ID</code>/<code>PAYPAL_CLIENT_SECRET</code> in <code>.env.local</code>). Every flow works with fake IDs, and approval links loop straight back.
          Add sandbox credentials and restart to use the real PayPal sandbox.
        </div>
      )}

      <div className="grid">
        <div className="col">
          {/* STEP 1 */}
          <section className="card">
            <h2><span className="step">1</span> Seller: list an API in 3 minutes</h2>
            <div className="form">
              <Field label="Base URL"><input value={seller.baseUrl} onChange={(e) => setSeller({ ...seller, baseUrl: e.target.value })} /></Field>
              <Field label="Sample request (GET)"><input value={seller.samplePath} onChange={(e) => setSeller({ ...seller, samplePath: e.target.value })} /></Field>
              <Field label="Upstream key header"><input value={seller.keyHeader} onChange={(e) => setSeller({ ...seller, keyHeader: e.target.value })} /></Field>
              <Field label="Upstream key (sealed)"><input value={seller.keyValue} onChange={(e) => setSeller({ ...seller, keyValue: e.target.value })} /></Field>
              <Field label="Seller email"><input value={seller.sellerEmail} onChange={(e) => setSeller({ ...seller, sellerEmail: e.target.value })} /></Field>
              <Field label="Payout PayPal email (sandbox)"><input placeholder="defaults to seller email" value={seller.paypalEmail} onChange={(e) => setSeller({ ...seller, paypalEmail: e.target.value })} /></Field>
            </div>
            <div className="row">
              <button onClick={probe} disabled={!!busy}>{busy === "probe" ? "Probing…" : "Probe + AI draft"}</button>
            </div>
            {draft && (
              <>
                <p className="hint">
                  Draft by <b>{draft.draft.source}</b>. {draft.draft.notes} Probe: HTTP {draft.probes[0]?.status} in {draft.probes[0]?.latencyMs}ms.
                </p>
                <div className="form">
                  <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                  <Field label="Slug (optional)"><input value={edit.slug} placeholder="auto from name" onChange={(e) => setEdit({ ...edit, slug: e.target.value })} /></Field>
                  <Field label="Price per call (¢)"><input type="number" min={1} value={edit.price} onChange={(e) => setEdit({ ...edit, price: Number(e.target.value) })} /></Field>
                  <Field label="Description" wide><textarea rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
                  <Field label="Promise (JSON Schema + freshness): every answer is graded against this" wide>
                    <textarea className="mono" rows={10} value={edit.promise} onChange={(e) => setEdit({ ...edit, promise: e.target.value })} />
                  </Field>
                </div>
                <div className="row">
                  <button onClick={publish} disabled={!!busy}>Publish listing</button>
                </div>
              </>
            )}
            {apis.length > 0 && (
              <p className="hint">
                Live listings: {apis.map((a) => `${a.slug} (${a.price_per_call_cents}¢, ${a.status})`).join(" · ")}
              </p>
            )}
          </section>

          {/* STEP 2 */}
          <section className="card">
            <h2><span className="step">2</span> Owner: fund an agent wallet with PayPal</h2>
            <div className="form">
              <Field label="Owner email"><input value={walletForm.ownerEmail} onChange={(e) => setWalletForm({ ...walletForm, ownerEmail: e.target.value })} /></Field>
              <Field label="Weekly budget ($)"><input type="number" value={walletForm.budgetUsd} onChange={(e) => setWalletForm({ ...walletForm, budgetUsd: Number(e.target.value) })} /></Field>
              <Field label="Max price per call (¢)"><input type="number" value={walletForm.maxPrice} onChange={(e) => setWalletForm({ ...walletForm, maxPrice: Number(e.target.value) })} /></Field>
            </div>
            <div className="row">
              <button onClick={createWallet} disabled={!!busy}>Create wallet</button>
              <button onClick={connectPayPal} disabled={!!busy || !wallet}>Connect PayPal (Vault, one approval)</button>
              <button className="ghost" onClick={() => refreshWallet()} disabled={!wallet}>↻</button>
            </div>
            {wallet && (
              <div className="kv">
                <div><span>Wallet</span><code>{wallet.id}</code></div>
                <div><span>Agent key</span><code className="secret">{wallet.key}</code></div>
                <div><span>PayPal</span><b className={walletInfo?.paypal_connected ? "good" : "warn"}>{walletInfo?.paypal_connected ? `vaulted (${walletInfo.paypal_vault_id})` : "not connected: pack purchases will need approval"}</b></div>
                <div><span>Budget</span>{money(walletInfo?.spent_cents)} spent of {money(walletInfo?.budget_cents)} · {money(walletInfo?.remaining_cents)} left</div>
              </div>
            )}
          </section>

          {/* STEP 3 */}
          <section className="card">
            <h2><span className="step">3</span> Agent: 402 → buy pack → call → settle</h2>
            <div className="form">
              <Field label="API">
                <select value={slug} onChange={(e) => setSlug(e.target.value)}>
                  <option value="">–</option>
                  {apis.map((a) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
                </select>
              </Field>
              <Field label="Settlement">
                <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                  <option value="escrow">escrow: authorize, capture good answers only</option>
                  <option value="direct">direct: capture now, refund unused</option>
                </select>
              </Field>
              <Field label="Path + query" wide><input value={callPath} onChange={(e) => setCallPath(e.target.value)} /></Field>
            </div>
            {selectedApi && (
              <p className="hint">
                {selectedApi.pack.calls} calls × {selectedApi.price_per_call_cents}¢ = {money(selectedApi.pack.total_cents)} · promise <code>{selectedApi.promise.hash.slice(0, 20)}…</code> · status <b>{selectedApi.status}</b>
              </p>
            )}
            <div className="row">
              <button className="ghost" onClick={callWithoutPack} disabled={!!busy || !slug}>a. Call without pack (expect 402)</button>
              <button onClick={buyPack} disabled={!!busy || !slug}>b. Buy pack with PayPal</button>
              {packInfo?.status === "pending_approval" && <button className="warnbtn" onClick={approvePack}>Owner: approve in PayPal →</button>}
            </div>
            <div className="row">
              <button onClick={() => callApi(1)} disabled={!!busy || !pack}>c. Call API</button>
              <button onClick={() => callApi(5)} disabled={!!busy || !pack}>Call ×5</button>
              <button onClick={closePack} disabled={!!busy || !pack || packInfo?.status !== "active"}>d. Close pack (settle on PayPal)</button>
              <button className="ghost" onClick={() => refreshPack()} disabled={!pack}>↻</button>
            </div>
            <div className="row modes">
              <span className="muted">Demo seller answers:</span>
              {["ok", "stale", "broken", "down"].map((m) => (
                <button key={m} className={demoMode === m ? "chip on" : "chip"} onClick={() => setSellerMode(m)}>{m}</button>
              ))}
              <button className="ghost" onClick={resetApi} disabled={!slug}>Mark API live again</button>
            </div>
            {packInfo && (
              <div className="kv">
                <div><span>Pack</span><code>{packInfo.id}</code> · {packInfo.mode} · <b>{packInfo.status}</b></div>
                <div><span>Credits</span>{packInfo.credits_used} used (good answers) · {packInfo.credits_left} left of {packInfo.credits_total}</div>
                <div><span>Money</span>held/paid {money(packInfo.amount_cents)} · captured {money(packInfo.captured_cents)} · refunded {money(packInfo.refunded_cents)}</div>
                <div><span>PayPal</span><code>{packInfo.paypal?.order_id ?? "–"}</code> auth <code>{packInfo.paypal?.authorization_id ?? "–"}</code> capture <code>{packInfo.paypal?.capture_id ?? "–"}</code></div>
                {packInfo.error && <div><span>Error</span><b className="bad">{packInfo.error}</b></div>}
              </div>
            )}
            {lastCall && (
              <div className={`result s${String(lastCall.status)[0]}`}>
                <div className="resulthead">
                  HTTP {lastCall.status} {lastCall.headers["x-apiii-verdict"] && <>· verdict <b>{lastCall.headers["x-apiii-verdict"]}</b></>}{" "}
                  {lastCall.headers["x-apiii-credits-left"] && <>· credits left {lastCall.headers["x-apiii-credits-left"]}</>}
                </div>
                <pre>{JSON.stringify(lastCall.body, null, 2)}</pre>
              </div>
            )}
            {settlement && (
              <div className="result s2">
                <div className="resulthead">Settlement: agent paid {money(settlement.owed_cents)} for {settlement.good_answers} good answers</div>
                <pre>{JSON.stringify(settlement, null, 2)}</pre>
              </div>
            )}
          </section>

          {/* STEP 4 */}
          <section className="card">
            <h2><span className="step">4</span> Autonomous agent (OpenAI)</h2>
            <p className="hint">Uses the wallet from step 2. The agent finds an API, buys an escrow pack via PayPal, calls it and closes the pack, with no human in the loop if PayPal is vaulted.</p>
            <div className="row">
              <input className="grow" value={goal} onChange={(e) => setGoal(e.target.value)} />
              <button onClick={runAgent} disabled={!!busy || !wallet}>{busy === "agent" ? "Running…" : "Run agent"}</button>
            </div>
            {agentRun?.steps && (
              <ol className="steps">
                {agentRun.steps.map((s: any, i: number) => (
                  <li key={i} className={s.kind}>
                    <b>{s.kind}{s.name ? `: ${s.name}` : ""}</b>
                    <pre>{typeof s.data === "string" ? s.data : JSON.stringify(s.data, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* STEP 5 */}
          <section className="card">
            <h2><span className="step">5</span> Receipts, packs & seller payouts</h2>
            <div className="row">
              <button className="ghost" onClick={() => run("tables", refreshTables)}>Refresh</button>
              <button onClick={runPayouts} disabled={!!busy}>Run seller payouts (PayPal Payouts, −3% fee)</button>
              <a className="link" href="/v1/receipts/public-key" target="_blank">Receipt public key</a>
              <a className="link" href="/.well-known/apiii.json" target="_blank">Manifest</a>
            </div>
            <h3>Signed receipts</h3>
            <Table
              rows={receipts}
              cols={[
                ["ts", (r) => new Date(r.ts).toLocaleTimeString()],
                ["api", (r) => r.api_slug],
                ["path", (r) => r.path],
                ["verdict", (r) => <b className={r.verdict === "pass" ? "good" : "bad"}>{r.verdict}</b>],
                ["charged", (r) => (r.charged ? "yes" : "no")],
                ["ms", (r) => r.latency_ms],
                ["detail", (r) => r.detail ?? ""],
              ]}
            />
            <h3>Packs</h3>
            <Table
              rows={packs}
              cols={[
                ["pack", (r) => r.id],
                ["api", (r) => r.api],
                ["mode", (r) => r.mode],
                ["status", (r) => r.status],
                ["used", (r) => `${r.credits_used}/${r.credits_total}`],
                ["amount", (r) => money(r.amount_cents)],
                ["captured", (r) => money(r.captured_cents)],
                ["refunded", (r) => money(r.refunded_cents)],
              ]}
            />
            <h3>Payouts</h3>
            <Table
              rows={payouts}
              cols={[
                ["seller", (r) => r.seller_email],
                ["amount", (r) => money(r.amount_cents)],
                ["fee", (r) => money(r.fee_cents)],
                ["status", (r) => r.status],
                ["batch", (r) => r.paypal_batch_id ?? r.error ?? ""],
              ]}
            />
            <div className="row">
              <button className="ghost" onClick={resetLocal}>Forget wallet & pack in this browser</button>
            </div>
          </section>
        </div>

        <aside className="col log">
          <section className="card sticky">
            <h2>Request log <button className="ghost small" onClick={() => setLog([])}>clear</button></h2>
            {log.length === 0 && <p className="muted">Every request this page makes shows up here.</p>}
            {log.map((e) => (
              <details key={e.id} className={`logrow s${String(e.status)[0]}`}>
                <summary>
                  <span className="t">{e.at}</span> <b>{e.method}</b> {e.url.replace(/^https?:\/\/[^/]+/, "")} <span className="st">{e.status || ""}</span>
                </summary>
                <pre>{typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2)}</pre>
              </details>
            ))}
          </section>
        </aside>
      </div>
    </main>
  );
}

function Pill({ ok, label }: { ok?: boolean; label: string }) {
  return <span className={`pill ${ok ? "ok" : "off"}`}>{label}</span>;
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Table({ rows, cols }: { rows: any[]; cols: [string, (r: any) => React.ReactNode][] }) {
  if (!Array.isArray(rows) || rows.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>{cols.map(([h]) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>{cols.map(([h, f]) => <td key={h}>{f(r)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
