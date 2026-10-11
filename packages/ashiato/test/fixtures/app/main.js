const status = document.getElementById("status");
const done = (s) => (status.textContent = s);

document.getElementById("save").addEventListener("click", async () => {
  await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: 3, qty: 10 }) });
  await fetch("/api/orders");
  done("saved");
});

document.getElementById("delete").addEventListener("click", async () => {
  await fetch("/api/orders/1", { method: "DELETE" });
  done("deleted");
});

document.getElementById("tab").addEventListener("click", () => done("tab"));

let nextId = 1;
window.chrome?.webview?.addEventListener("message", (e) => {
  if (e.data?.result) done("rpc ok");
});
document.getElementById("rpc").addEventListener("click", () => {
  window.chrome.webview.postMessage({ jsonrpc: "2.0", id: nextId++, method: "orders.save", params: { item: 4, qty: 1 } });
});
