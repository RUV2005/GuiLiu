"""Browser page for the Google OAuth redirect.

Google sends the user's browser back to the Backend. Instead of raw JSON, show where the authorization ended up and send
the user back to the setup tab, which polls /initialization and updates on its own.
"""
from html import escape

from fastapi.responses import HTMLResponse

# The 归流 mark (assets/app-icon-small.svg in the frontend), inlined so the page needs no other request.
ICON = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="15" fill="#1b1e23"/><g transform="translate(32 32) scale(1.0644) translate(-33.55 -33.24)"><g transform="rotate(-12 32 32)"><path d="M20.28 39.34L20.1 38.61 19.96 37.86 19.85 37.12 19.78 36.37 19.74 35.61 19.74 34.86 19.77 34.11 19.84 33.36 19.94 32.61 20.08 31.88 20.25 31.15 20.45 30.43 20.69 29.72 20.95 29.02 21.25 28.34 21.58 27.67 21.93 27.02 22.32 26.38 22.73 25.77 23.16 25.17 23.62 24.6 24.11 24.04 24.62 23.51 25.15 23.01 25.7 22.52 26.26 22.07 26.85 21.63 27.45 21.23 28.07 20.85 28.71 20.49 29.35 20.17 30.01 19.87 30.68 19.6 31.36 19.36 32.05 19.15 32.74 18.96 33.44 18.8 34.15 18.68 34.86 18.58 35.57 18.51 36.28 18.46 37 18.45A0.55 0.55 0 0 1 37 19.55L36.33 19.57 35.67 19.61 35 19.69 34.35 19.81 33.69 19.95 33.05 20.12 32.42 20.32 31.79 20.55 31.18 20.81 30.58 21.1 30 21.42 29.43 21.76 28.88 22.12 28.35 22.51 27.84 22.92 27.35 23.36 26.87 23.81 26.42 24.28 26 24.78 25.59 25.29 25.21 25.81 24.85 26.36 24.52 26.91 24.21 27.48 23.93 28.06 23.68 28.65 23.44 29.25 23.24 29.85 23.06 30.47 22.91 31.08 22.78 31.71 22.68 32.34 22.61 32.97 22.56 33.6 22.54 34.23 22.54 34.86 22.57 35.49 22.62 36.12 22.7 36.74 22.8 37.36 22.93 37.98 23.08 38.59A1.45 1.45 0 0 1 20.28 39.34Z" fill="#6ec6e0"/><path d="M9.43 44.62L9.44 43.87 9.47 43.13 9.52 42.38 9.59 41.64 9.68 40.9 9.79 40.16 9.92 39.42 10.07 38.69 10.24 37.97 10.43 37.24 10.64 36.53 10.87 35.82 11.12 35.11 11.39 34.42 11.67 33.73 11.98 33.04 12.3 32.37 12.64 31.71 13 31.05 13.38 30.41 13.77 29.77 14.18 29.15 14.61 28.54 15.05 27.94 15.51 27.35 15.99 26.77 16.48 26.21 16.98 25.66 17.51 25.13 18.04 24.6 18.59 24.1 19.15 23.61 19.73 23.13 20.32 22.67 20.92 22.23 21.53 21.8 22.15 21.39 22.79 21 23.43 20.62 24.09 20.26 24.75 19.92 25.42 19.6 26.11 19.29 26.8 19.01 27.49 18.74 28.2 18.49 28.91 18.26 29.62 18.05 30.35 17.86 31.07 17.69 31.8 17.54 32.54 17.41 33.28 17.3 34.02 17.21 34.76 17.14 35.51 17.09 36.25 17.06 37 17.05 37.78 17.07 38.55 17.12 39.32 17.2 40.09 17.32 40.85 17.47 41.61 17.66 42.36 17.87 43.09 18.12 43.82 18.41 44.53 18.72 45.22 19.06 45.91 19.44 46.57 19.84 47.22 20.27 47.84 20.73 48.45 21.22 49.03 21.73 49.59 22.27 50.13 22.83 50.64 23.41 51.13 24.02 51.59 24.64 52.02 25.29 52.42 25.95 52.8 26.64 53.14 27.33 53.45 28.04 53.74 28.77 53.99 29.5 54.2 30.25 54.39 31.01 54.54 31.77 54.66 32.54 54.74 33.31 54.79 34.08 54.81 34.86 54.78 35.68 54.7 36.49 54.55 37.29 54.36 38.09 54.1 38.87 53.8 39.62 53.44 40.36 53.03 41.07 52.57 41.74 52.07 42.39 51.52 42.99 50.94 43.56 50.31 44.09 49.65 44.57 48.95 45 48.23 45.38 47.49 45.72 46.72 46 45.93 46.22A1.95 1.95 0 0 1 44.99 42.44L45.51 42.29 46.03 42.1 46.52 41.88 47.01 41.62 47.47 41.33 47.91 41.01 48.33 40.66 48.72 40.29 49.08 39.88 49.42 39.45 49.72 39 50 38.53 50.23 38.04 50.44 37.53 50.61 37.01 50.74 36.48 50.83 35.95 50.89 35.4 50.91 34.86 50.9 34.25 50.86 33.65 50.79 33.04 50.7 32.44 50.58 31.85 50.44 31.26 50.27 30.68 50.07 30.1 49.85 29.54 49.61 28.98 49.34 28.44 49.05 27.9 48.73 27.39 48.39 26.88 48.04 26.39 47.66 25.92 47.26 25.46 46.84 25.02 46.4 24.6 45.94 24.2 45.47 23.82 44.98 23.47 44.47 23.13 43.95 22.81 43.42 22.52 42.88 22.25 42.32 22.01 41.76 21.79 41.18 21.59 40.6 21.42 40.01 21.28 39.42 21.16 38.82 21.07 38.21 21 37.61 20.96 37 20.95 36.36 20.96 35.72 20.98 35.08 21.03 34.44 21.09 33.8 21.17 33.17 21.26 32.54 21.37 31.91 21.5 31.29 21.65 30.67 21.81 30.05 21.99 29.44 22.19 28.84 22.4 28.24 22.63 27.65 22.88 27.06 23.14 26.48 23.41 25.91 23.71 25.35 24.02 24.8 24.34 24.25 24.68 23.72 25.03 23.19 25.4 22.68 25.78 22.17 26.17 21.68 26.58 21.19 27 20.72 27.44 20.26 27.88 19.82 28.34 19.38 28.81 18.96 29.3 18.55 29.79 18.16 30.3 17.78 30.81 17.41 31.34 17.06 31.87 16.72 32.42 16.4 32.97 16.09 33.53 15.79 34.1 15.52 34.68 15.26 35.27 15.01 35.86 14.78 36.46 14.57 37.06 14.37 37.67 14.19 38.29 14.03 38.91 13.88 39.53 13.75 40.16 13.64 40.79 13.55 41.42 13.47 42.06 13.41 42.7 13.36 43.34 13.34 43.98 13.33 44.62A1.95 1.95 0 0 1 9.43 44.62Z" fill="#f0f2f5"/><g fill="#fff"><circle cx="39.57" cy="43.49" r="2.3"/><circle cx="37.01" cy="38.23" r="1.85"/></g></g></g></svg>'

TEXT = {
    "zh": {
        "lang": "zh-CN", "brand": "归流",
        "connected_title": "Gmail 已连接",
        "connected_body": "授权已完成。回到归流的设置页面，它会自动更新，接着完成剩下的步骤。",
        "cancelled_title": "已取消 Gmail 授权",
        "cancelled_body": "Gmail 没有连接。回到归流后可以重新授权，也可以先连接网易 163 邮箱。",
        "failed_title": "Gmail 授权没有完成",
        "failed_body": "这次授权没有保存。请回到归流的设置页面，重新点击 Gmail 授权。",
        "close": "关闭此页", "close_hint": "如果此页没有关闭，可以直接关闭这个标签页，回到归流继续。",
        "detail": "详细信息",
        "OAuth state is invalid or expired": "授权链接已过期，或已被新的授权链接替换。",
        "Grant Gmail and Google profile access; authorize again": "需要同时允许读取 Gmail 和 Google 基本资料。重新授权时请勾选全部权限。",
        "Google did not return a refresh token; authorize offline access again": "Google 没有返回长期授权，请重新授权一次。",
        "Gmail authorization is not the current setup step": "当前不在连接邮箱这一步，这次授权没有保存。",
        "Changing the bound Gmail account requires a separate environment": "这个环境已经绑定了另一个 Gmail 账号，不能直接更换。",
        "Google identity does not match Gmail": "选择的 Google 账号与 Gmail 邮箱不一致，请使用同一个账号授权。",
        "Mailbox selection is locked after vector import starts; use a separate environment": "邮件索引开始后，已连接的邮箱就固定了，不能再增加。",
    },
    "ja": {
        "lang": "ja", "brand": "归流",
        "connected_title": "Gmail を接続しました",
        "connected_body": "認証が完了しました。归流の設定画面に戻ると自動で更新されるので、残りの手順に進んでください。",
        "cancelled_title": "Gmail の認証をキャンセルしました",
        "cancelled_body": "Gmail は接続されていません。归流に戻ってもう一度認証するか、先に NetEase 163 メールを接続できます。",
        "failed_title": "Gmail の認証が完了しませんでした",
        "failed_body": "今回の認証は保存されていません。归流の設定画面に戻り、もう一度 Gmail を認証してください。",
        "close": "このページを閉じる", "close_hint": "閉じない場合は、このタブを手動で閉じて归流に戻ってください。",
        "detail": "詳細",
        "OAuth state is invalid or expired": "認証リンクの有効期限が切れたか、新しいリンクに置き換えられました。",
        "Grant Gmail and Google profile access; authorize again": "Gmail と Google プロフィールの両方へのアクセスが必要です。すべての権限を許可して再認証してください。",
        "Google did not return a refresh token; authorize offline access again": "Google から長期の認証が返されませんでした。もう一度認証してください。",
        "Gmail authorization is not the current setup step": "現在はメール接続の手順ではないため、認証は保存されませんでした。",
        "Changing the bound Gmail account requires a separate environment": "この環境は別の Gmail アカウントに紐付いているため、変更できません。",
        "Google identity does not match Gmail": "選択した Google アカウントが Gmail と一致しません。同じアカウントで認証してください。",
        "Mailbox selection is locked after vector import starts; use a separate environment": "メールの索引作成を始めた後は、接続するメールを追加できません。",
    },
    "en": {
        "lang": "en", "brand": "AutoBookkeeping",
        "connected_title": "Gmail is connected",
        "connected_body": "Authorization is complete. Go back to the AutoBookkeeping setup page; it updates on its own so you can finish the remaining steps.",
        "cancelled_title": "Gmail authorization was cancelled",
        "cancelled_body": "Gmail is not connected. Go back to AutoBookkeeping to authorize again, or connect NetEase 163 Mail first.",
        "failed_title": "Gmail authorization did not finish",
        "failed_body": "Nothing was saved. Go back to the AutoBookkeeping setup page and authorize Gmail again.",
        "close": "Close this page", "close_hint": "If this page stays open, close the tab and return to AutoBookkeeping.",
        "detail": "Details",
        "OAuth state is invalid or expired": "The authorization link expired or was replaced by a newer one.",
        "Grant Gmail and Google profile access; authorize again": "Both Gmail and Google profile access are required. Allow every permission when you authorize again.",
        "Google did not return a refresh token; authorize offline access again": "Google did not return lasting access. Please authorize once more.",
        "Gmail authorization is not the current setup step": "Setup is not on the mailbox step, so this authorization was not saved.",
        "Changing the bound Gmail account requires a separate environment": "This environment is already bound to another Gmail account and cannot switch.",
        "Google identity does not match Gmail": "The Google account you chose does not match the Gmail address. Authorize with the same account.",
        "Mailbox selection is locked after vector import starts; use a separate environment": "Mailboxes cannot be added once mail indexing has started.",
    },
}

PAGE = """<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>{title} · {brand}</title>
<style>
:root {{ color-scheme: dark; --canvas: #0b0c0e; --surface: #111317; --line: #2a2d33; --ink: #f1f0ec; --soft: #c8c8c4;
  --muted: #9a9da5; --positive: #759b84; --warning: #c59655; --danger: #d26873; }}
@media (prefers-color-scheme: light) {{ :root {{ color-scheme: light; --canvas: #f8f9fb; --surface: #fff; --line: #dce1e7;
  --ink: #25292f; --soft: #424951; --muted: #5d6671; --positive: #26734b; --warning: #876018; --danger: #b63f51; }} }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--canvas);
  color: var(--ink); font: 15px/1.8 Inter, "Segoe UI", "Noto Sans SC", "Noto Sans JP", "PingFang SC", sans-serif; }}
main {{ width: min(100%, 460px); padding: 36px 32px 32px; border: 1px solid var(--line); border-top: 3px solid var(--accent); border-radius: 10px; background: var(--surface); }}
.brand {{ display: flex; align-items: center; gap: 10px; margin-bottom: 30px; color: var(--soft); font-weight: 600; }}
.brand svg {{ width: 28px; height: 28px; }}
h1 {{ margin: 0 0 12px; font-size: 24px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }}
p {{ margin: 0; color: var(--soft); overflow-wrap: anywhere; }}
.reason {{ margin-top: 14px; padding: 12px 14px; border-radius: 6px; background: var(--canvas); color: var(--ink); font-size: 14px; }}
details {{ margin-top: 12px; color: var(--muted); font-size: 12px; }}
details code {{ display: block; margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 ui-monospace, Consolas, monospace; }}
button {{ margin-top: 28px; min-height: 42px; padding: 10px 20px; border: 1px solid var(--ink); border-radius: 6px; background: var(--ink);
  color: var(--canvas); font: inherit; font-size: 14px; font-weight: 600; line-height: 1.5; cursor: pointer; }}
button:hover {{ filter: brightness(.92); }}
button:focus-visible {{ outline: 2px solid var(--muted); outline-offset: 3px; }}
.hint {{ margin-top: 12px; color: var(--muted); font-size: 12px; }}
</style></head>
<body><main style="--accent: var(--{tone})">
<div class="brand">{icon}<span>{brand}</span></div>
<h1>{title}</h1>
<p>{body}</p>{reason}
<button type="button" id="close">{close}</button>
<p class="hint">{close_hint}</p>
</main>
<script>
// Drop the one-time code and state from the address bar and history.
history.replaceState(null, '', location.pathname);
document.getElementById('close').addEventListener('click', () => window.close());
</script></body></html>"""

CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


def callback_language(accept_language):
    """Pick the first supported language from the browser's Accept-Language header."""
    for part in str(accept_language or "").split(","):
        tag = part.split(";")[0].strip().lower()
        for language in ("zh", "ja", "en"):
            if tag == language or tag.startswith(language + "-"):
                return language
    return "en"


def callback_page(language, outcome, detail="", status_code=200):
    """outcome: connected, cancelled or failed. A known Backend error is explained; any other is shown as sent."""
    text = TEXT.get(language, TEXT["en"])
    tone = {"connected": "positive", "cancelled": "warning"}.get(outcome, "danger")
    reason = ""
    if outcome == "failed" and detail:
        explained = text.get(detail)
        reason = (f'<p class="reason">{escape(explained)}</p>' if explained else "") + \
            f'<details><summary>{escape(text["detail"])}</summary><code>{escape(detail)}</code></details>'
    html = PAGE.format(lang=text["lang"], brand=escape(text["brand"]), icon=ICON, tone=tone,
                       title=escape(text[outcome + "_title"]), body=escape(text[outcome + "_body"]), reason=reason,
                       close=escape(text["close"]), close_hint=escape(text["close_hint"]))
    return HTMLResponse(html, status_code=status_code, headers={
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff"})
