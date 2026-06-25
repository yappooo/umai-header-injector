const input = document.getElementById("apiKey");
const status = document.getElementById("status");

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  if (apiKey) input.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = input.value.trim();
  await chrome.storage.local.set({ apiKey });
  status.textContent = apiKey
    ? "Active: header injection ON for umai.io / letsumai.com"
    : "Cleared: header injection OFF";
});
