import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { watchDb } from "ashiato";

// ashiato watches the app's database with SELECT only and checks what each step changed in it.
const db = watchDb(`sqlite:${process.env.APP_DB ?? new URL("../app.db", import.meta.url).pathname}`, { ignoreColumns: ["updated_at"] });
test.afterAll(() => db.close());

// Every test starts from the same rows (stock 3 = 50, 4 = 20), whatever ran before it.
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:3000";
test.beforeEach(async () => {
  await fetch(`${appUrl}/api/reset`, { method: "POST" });
});

test("保存ボタン(ロケーター: モデルなし)", async ({ app, screen }) => {
  await app.open("/");
  await db.expectChanges(
    async () => {
      await screen.getByRole("button", "保存").tap();
      await expect(screen.getByText("saved")).toBeVisible();
    },
    {
      orders: { inserted: [{ customer_id: 7, qty: 10 }] },
      stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
    },
  );
});

test("保存ボタン(agent.act)", async ({ app, screen, agent }) => {
  await app.open("/");
  await db.expectChanges(
    async () => {
      await agent.act("「保存」ボタンを押す");
      await expect(screen.getByText("saved")).toBeVisible();
    },
    {
      orders: { inserted: [{ customer_id: 7, qty: 10 }] },
      stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
    },
  );
});

test("注文(agent.act: 品目と数量を入れて注文)", async ({ app, screen, agent, browser }) => {
  await app.open("/");
  const off = await browser.onDialog("accept");
  await db.expectChanges(
    async () => {
      await agent.act("品目にナットを選び、数量に 5 を入れて「注文」ボタンを押す");
      await expect(screen.getByText("ordered")).toBeVisible();
    },
    { stock: { updated: [{ where: { item_id: 4 }, set: { qty: 15 } }] } },
  );
  await off();
});
