// Runs in MAIN world at document_start on UMAI tabs.
// Wraps window.fetch: if a booking POST returns 422 email_otp_required,
// requests OTP from extension (via bridge) then retries with email_otp injected.
(function () {
  if (window.__umai_otp_interceptor) return;
  window.__umai_otp_interceptor = true;

  const _orig = window.fetch;

  function requestOTPCode() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const TIMEOUT_MS = 130000;

      function handler(e) {
        if (
          e.source === window &&
          e.data &&
          e.data.__umai_otp_response === true &&
          e.data.__id === id
        ) {
          window.removeEventListener("message", handler);
          resolve(e.data.code || null);
        }
      }

      window.addEventListener("message", handler);
      window.postMessage({ __umai_otp_request: true, __id: id }, "*");

      setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, TIMEOUT_MS);
    });
  }

  window.fetch = async function (input, init) {
    const resp = await _orig.call(this, input, init);

    if (resp.status !== 422) return resp;

    const url =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
        ? input.url
        : "";

    // Only intercept reservation booking endpoints
    if (!url.includes("/reservations")) return resp;

    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (_) {}

    if (!bodyText.includes("email_otp_required")) return resp;

    console.log("[OTP-INTERCEPT] 422 email_otp_required — requesting OTP via extension...");

    const code = await requestOTPCode();
    if (!code) {
      console.log("[OTP-INTERCEPT] No code received — returning original 422 response");
      return resp;
    }

    console.log("[OTP-INTERCEPT] Got code, retrying booking with email_otp injected");

    let newInit = { ...init };
    if (init && init.body) {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed.reservation && typeof parsed.reservation === "object") {
          parsed.reservation.email_otp = code;
        } else {
          parsed.email_otp = code;
        }
        newInit = { ...init, body: JSON.stringify(parsed) };
      } catch (_) {}
    }

    return _orig.call(this, input, newInit);
  };
})();
