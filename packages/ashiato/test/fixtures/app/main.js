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

document.getElementById("save-all").addEventListener("click", () => {
  // one init object reused for every call: each request must still send its own body
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  for (const id of [11, 12, 13]) {
    init.body = JSON.stringify({ id });
    fetch("/api/items", init);
  }
  done("saving");
});

document.getElementById("xhr-cancel").addEventListener("click", () => {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/slow");
  xhr.send();
  // re-opening cancels the request (Chromium fires no loadend for it); nothing is sent after that
  setTimeout(() => xhr.open("POST", "/api/slow"), 100);
});
