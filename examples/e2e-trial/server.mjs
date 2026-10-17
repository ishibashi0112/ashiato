// The sample app from ashiato's browser test as a standalone dev server: the page in ./app, a JSON
// API that writes a SQLite database (APP_DB, default ./app.db, recreated at start), port APP_PORT.
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const file = process.env.APP_DB ?? fileURLToPath(new URL("./app.db", import.meta.url));
if (existsSync(file)) unlinkSync(file);
const db = new DatabaseSync(file);
db.exec(`
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, qty INTEGER, updated_at TEXT);
  CREATE TABLE stock (item_id INTEGER PRIMARY KEY, qty INTEGER);
  CREATE TABLE audit_log (message TEXT);
`);
// The starting rows (stock 3 = 50, 4 = 20); POST /api/reset puts them back so every test starts the same.
const reset = () => db.exec("DELETE FROM orders; DELETE FROM stock; DELETE FROM audit_log; INSERT INTO stock VALUES (3, 50), (4, 20)");
reset();

const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });

const vite = await createServer({
  root: fileURLToPath(new URL("./app", import.meta.url)),
  logLevel: "silent",
  server: { port: Number(process.env.APP_PORT ?? 3000), host: "127.0.0.1", strictPort: true },
  plugins: [
    {
      name: "api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const send = (body) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          if (req.url === "/api/reset" && req.method === "POST") {
            reset();
            return send({ ok: true });
          }
          if (req.url === "/api/orders" && req.method === "POST") {
            const id = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM orders").get().id;
            db.prepare("INSERT INTO orders (id, customer_id, qty, updated_at) VALUES (?, 7, 10, 'now')").run(id);
            db.exec("UPDATE stock SET qty = qty - 10 WHERE item_id = 3");
            return send({ id });
          }
          if (req.url === "/api/orders" && req.method === "GET") return send(db.prepare("SELECT * FROM orders").all());
          if (req.url === "/api/orders/1" && req.method === "DELETE") {
            db.exec("DELETE FROM orders WHERE id = 1");
            return send({ ok: true });
          }
          if (req.url === "/api/items" && req.method === "POST") {
            const { id } = await readBody(req);
            db.prepare("INSERT OR IGNORE INTO orders (id, customer_id, qty, updated_at) VALUES (?, 9, 1, 'now')").run(id);
            return send({ id });
          }
          if (req.url === "/api/stock" && req.method === "POST") {
            const { item, qty } = await readBody(req);
            db.prepare("UPDATE stock SET qty = qty - ? WHERE item_id = ?").run(qty, item);
            return send({ ok: true });
          }
          next();
        });
      },
    },
  ],
});
await vite.listen();
console.log(`app: http://127.0.0.1:${vite.config.server.port}  db: ${file}`);
