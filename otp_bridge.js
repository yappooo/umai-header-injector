// Runs in ISOLATED world. Bridges postMessage from MAIN world to chrome.runtime.

window.addEventListener("message", async (e) => {
  if (e.source !== window || !e.data) return;
  const { __id } = e.data;

  // Check if extension has a fresh stored OTP code (no IMAP call — just storage)
  if (e.data.__umai_stored_code_check === true) {
    chrome.storage.local.get("otpCode", ({ otpCode }) => {
      const fresh = otpCode && otpCode.code && (Date.now() - otpCode.ts < 600000);
      window.postMessage({
        __umai_stored_code_response: true,
        __id,
        code: fresh ? otpCode.code : null,
      }, "*");
    });
    return;
  }

  // Send+read OTP via native host (full round-trip)
  if (e.data.__umai_otp_request === true) {
    chrome.runtime.sendMessage("requestOTPBackground", (res) => {
      window.postMessage({
        __umai_otp_response: true,
        __id,
        code: res && res.code ? res.code : null,
      }, "*");
    });
    return;
  }
});
