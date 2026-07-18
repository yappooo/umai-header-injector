// Runs in ISOLATED world. Bridges postMessage from MAIN world otp_interceptor.js
// to chrome.runtime.sendMessage, then posts the code back.
window.addEventListener("message", async (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.__umai_otp_request !== true) return;

  const id = e.data.__id;

  chrome.runtime.sendMessage("requestOTPBackground", (res) => {
    const code = res && res.code ? res.code : null;
    window.postMessage({ __umai_otp_response: true, __id: id, code }, "*");
  });
});
