import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

/**
 * A small order app for the browser tests of `pack`, `verify --auto` and `export-tests`: a menu, an
 * order form and a list of orders whose rows can be cancelled (after a confirm dialog). It writes to
 * the test's SQLite database (orders, stock).
 */
const layout = (title: string, body: string) => `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${title}</title>
<body><nav><ul><li><a href="/">ホーム</a></li><li><a href="/orders">受注一覧</a></li><li><a href="/orders/new">新規受注</a></li><li><a href="/logout">ログアウト</a></li></ul></nav>
<main>${body}</main></body></html>`;

const HOME = layout("受注管理", `<h1>受注管理</h1><p>ようこそ 鈴木さん。今日の受注は 3 件です。</p>`);

const NEW = layout(
  "新規受注",
  `<h1>新規受注</h1>
<form id="f">
  <label for="customer">得意先</label>
  <select id="customer"><option value="7">鈴木商事</option><option value="8">田中物産</option></select>
  <label>数量 <input id="qty" type="number"></label>
  <input id="note" placeholder="備考">
  <button type="submit">登録</button>
</form>
<p id="done" role="status"></p>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer: Number(document.getElementById("customer").value), qty: Number(document.getElementById("qty").value) }) });
    document.getElementById("done").textContent = res.ok ? "登録しました" : "在庫が足りません";
  });
</script>`,
);

const list = (rows: { id: number; customer_id: number; qty: number }[]) =>
  layout(
    "受注一覧",
    `<h1>受注一覧</h1>
<table><thead><tr><th>番号</th><th>得意先</th><th>数量</th><th></th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${r.id}</td><td>${r.customer_id === 7 ? "鈴木商事" : "田中物産"}</td><td>${r.qty}</td><td><button data-id="${r.id}">取消</button></td></tr>`).join("\n")}
</tbody></table>
<p id="done" role="status"></p>
<script>
  for (const b of document.querySelectorAll("button[data-id]")) b.addEventListener("click", async () => {
    if (!confirm("取り消しますか？")) return;
    await fetch("/api/orders/" + b.dataset.id, { method: "DELETE" });
    b.closest("tr").remove();
    document.getElementById("done").textContent = "取り消しました";
  });
</script>`,
  );

export async function startOrdersApp(db: DatabaseSync): Promise<{ url: string; server: Server; visits: string[] }> {
  const visits: string[] = [];
  const server = createServer((req, res) => {
    visits.push(`${req.method} ${req.url}`);
    const html = (body: string) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(body);
    };
    if (req.method === "POST" && req.url === "/api/orders") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { customer, qty } = JSON.parse(body) as { customer: number; qty: number };
        const stock = db.prepare("SELECT qty FROM stock WHERE item_id = 3").get() as { qty: number };
        if (stock.qty < qty) {
          res.statusCode = 409;
          return void res.end("{}");
        }
        db.prepare("INSERT INTO orders (customer_id, qty, updated_at) VALUES (?, ?, datetime('now'))").run(customer, qty);
        db.prepare("UPDATE stock SET qty = qty - ? WHERE item_id = 3").run(qty);
        res.end("{}");
      });
      return;
    }
    const cancel = /^\/api\/orders\/(\d+)$/.exec(req.url ?? "");
    if (req.method === "DELETE" && cancel) {
      const order = db.prepare("SELECT qty FROM orders WHERE id = ?").get(Number(cancel[1])) as { qty: number } | undefined;
      if (order) {
        db.prepare("DELETE FROM orders WHERE id = ?").run(Number(cancel[1]));
        db.prepare("UPDATE stock SET qty = qty + ? WHERE item_id = 3").run(order.qty);
      }
      return void res.end("{}");
    }
    if (req.url === "/") return html(HOME);
    if (req.url === "/orders/new") return html(NEW);
    if (req.url === "/orders") return html(list(db.prepare("SELECT id, customer_id, qty FROM orders ORDER BY id").all() as never));
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, visits };
}
