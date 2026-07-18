#!/usr/bin/env python3
"""
UMAI extension native messaging host.
Actions:
  send_otp  -- POST /widget/api/v2/email_otps via Python requests (bypasses CF browser check)
  read_otp  -- Poll IMAP for OTP code (default when action missing)
Chrome native messaging protocol: 4-byte LE length-prefixed JSON on stdin/stdout.
"""
import sys
import json
import struct
import imaplib
import email as email_lib
import email.header
import re
import time
try:
    import urllib.request
    import urllib.error
except ImportError:
    pass


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    data = sys.stdin.buffer.read(n)
    return json.loads(data.decode("utf-8"))


def send_msg(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def decode_header_val(val):
    parts = email_lib.header.decode_header(val or "")
    out = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(charset or "utf-8", errors="ignore"))
        else:
            out.append(str(chunk))
    return " ".join(out)


def get_body(msg):
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct in ("text/plain", "text/html"):
                payload = part.get_payload(decode=True)
                if payload:
                    body += payload.decode("utf-8", errors="ignore")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode("utf-8", errors="ignore")
    return body


def find_otp(host, user, password, after_ts_ms, timeout_s):
    """Poll IMAP until a 6-digit OTP code is found or timeout expires."""
    deadline = time.time() + timeout_s
    after_ts_s = after_ts_ms / 1000.0 if after_ts_ms else 0

    while time.time() < deadline:
        try:
            M = imaplib.IMAP4_SSL(host)
            M.login(user, password)
            M.select("INBOX")
            _, data = M.search(None, "UNSEEN")
            uids = (data[0] or b"").split()
            for uid in reversed(uids):
                _, msg_data = M.fetch(uid, "(RFC822)")
                raw = msg_data[0][1]
                msg = email_lib.message_from_bytes(raw)

                from_h = decode_header_val(msg.get("From", "")).lower()
                subj = decode_header_val(msg.get("Subject", "")).lower()

                # Only look at UMAI-related emails
                umai = any(
                    k in from_h or k in subj
                    for k in ("umai", "letsumai", "reservation", "booking",
                               "verify", "verification", "otp", "code", "passcode")
                )
                if not umai:
                    continue

                body = get_body(msg)
                combined = body + " " + subj
                codes = re.findall(r"\b(\d{6})\b", combined)
                if codes:
                    M.close()
                    M.logout()
                    return codes[0]

            M.close()
            M.logout()
        except Exception:
            pass

        time.sleep(3)

    return None


def send_otp_request(api_url, venue_api_key, email_addr):
    """POST email_otps via Python urllib (bypasses CF browser challenge)."""
    url = api_url or "https://letsumai.com/widget/api/v2/email_otps"
    payload = json.dumps({"email": email_addr, "locale": "en"}).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "venue-api-key": venue_api_key or "",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return {"ok": True, "status": resp.status, "body": body[:200]}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        return {"ok": False, "status": e.code, "body": body[:200]}
    except Exception as ex:
        return {"ok": False, "status": 0, "body": str(ex)}


if __name__ == "__main__":
    msg = read_msg()
    if not msg:
        send_msg({"ok": False, "error": "no message received"})
        sys.exit(0)

    action = msg.get("action", "read_otp")

    if action == "send_otp":
        result = send_otp_request(
            msg.get("api_url", ""),
            msg.get("venue_api_key", ""),
            msg.get("email", ""),
        )
        send_msg(result)
        sys.exit(0)

    # default: read_otp
    code = find_otp(
        msg.get("host", "imap.gmail.com"),
        msg.get("email", ""),
        msg.get("password", ""),
        msg.get("after_ts", 0),
        msg.get("timeout", 120),
    )

    if code:
        send_msg({"ok": True, "code": code})
    else:
        send_msg({"ok": False, "code": "", "error": "OTP not found within timeout"})
