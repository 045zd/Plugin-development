#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mail_proxy.py 的单元测试（只依赖标准库）。

运行方式（在 mail-proxy 目录下）：
    python -m unittest discover -s tests -v
或：
    python tests/test_mail_proxy.py
"""

from __future__ import annotations

import email
import email.policy
import http.client
import json
import logging
import shutil
import smtplib
import socketserver
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import mail_proxy  # noqa: E402  (需要先插入 sys.path)


# ---------------------------------------------------------------------------
# 测试辅助
# ---------------------------------------------------------------------------


class _TempDir:
    """项目内的临时目录（普通 mkdir，兼容受限 Windows 沙箱）。"""

    def __init__(self, path: Path):
        self.name = str(path)

    def cleanup(self) -> None:
        shutil.rmtree(self.name, ignore_errors=True)

    def __enter__(self) -> str:
        return self.name

    def __exit__(self, *exc_info) -> None:
        self.cleanup()


def make_tempdir() -> _TempDir:
    """创建测试用临时目录。

    不使用 tempfile.TemporaryDirectory：在部分受限 Windows 沙箱里
    mkdtemp 创建的目录不可写；这里在项目内用普通 mkdir 创建并自行清理。
    """
    root = BASE_DIR / ".test-tmp"
    root.mkdir(parents=True, exist_ok=True)
    path = root / ("case-" + uuid.uuid4().hex)
    path.mkdir()
    return _TempDir(path)


def cleanup_tempdir(tmp: _TempDir) -> None:
    tmp.cleanup()


def tearDownModule() -> None:
    # 清理回退目录本身（若为空）。
    try:
        (BASE_DIR / ".test-tmp").rmdir()
    except OSError:
        pass


def make_config(**overrides) -> dict:
    """一份最小可用的测试配置（默认指向本机假 SMTP 端口，use_ssl=false）。"""
    cfg = {
        "smtp_host": "127.0.0.1",
        "smtp_port": 2525,
        "smtp_user": "",
        "smtp_pass": "",
        "mail_from": "sender@example.com",
        "mail_to": "rcpt@example.com",
        "use_ssl": False,
        "heartbeat_timeout_minutes": 180,
        "port": 8765,
    }
    cfg.update(overrides)
    return cfg


class FakeSMTPHandler(socketserver.StreamRequestHandler):
    """最小 SMTP 服务端：只实现 smtplib 发送一封邮件所需的命令。"""

    def handle(self) -> None:
        self.wfile.write(b"220 fake-smtp ready\r\n")
        self.wfile.flush()
        mail_from = None
        recipients: list[str] = []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            upper = text.upper()
            if upper.startswith("EHLO") or upper.startswith("HELO"):
                # 故意不广告 STARTTLS，以覆盖“服务器不支持时降级明文”的分支。
                self.wfile.write(b"250-fake-smtp\r\n250-8BITMIME\r\n250 HELP\r\n")
                self.wfile.flush()
            elif upper.startswith("MAIL FROM"):
                mail_from = text[10:].strip()
                self.wfile.write(b"250 OK\r\n")
                self.wfile.flush()
            elif upper.startswith("RCPT TO"):
                recipients.append(text[8:].strip())
                self.wfile.write(b"250 OK\r\n")
                self.wfile.flush()
            elif upper == "DATA":
                self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                self.wfile.flush()
                chunks = []
                while True:
                    data_line = self.rfile.readline()
                    if not data_line:
                        break
                    if data_line in (b".\r\n", b".\n"):
                        break
                    if data_line.startswith(b".."):
                        data_line = data_line[1:]  # 还原 dot-stuffing
                    chunks.append(data_line)
                with self.server.lock:  # type: ignore[attr-defined]
                    self.server.messages.append(  # type: ignore[attr-defined]
                        {
                            "from": mail_from,
                            "rcpt": list(recipients),
                            "data": b"".join(chunks),
                        }
                    )
                self.wfile.write(b"250 OK queued\r\n")
                self.wfile.flush()
                recipients = []
            elif upper == "QUIT":
                self.wfile.write(b"221 Bye\r\n")
                self.wfile.flush()
                return
            elif upper == "RSET":
                recipients = []
                self.wfile.write(b"250 OK\r\n")
                self.wfile.flush()
            else:
                self.wfile.write(b"250 OK\r\n")
                self.wfile.flush()


class FakeSMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address=("127.0.0.1", 0)):
        super().__init__(server_address, FakeSMTPHandler)
        self.messages: list[dict] = []
        self.lock = threading.Lock()


class RecordingSender:
    """替代 MailService.send，记录被发送的提醒邮件，可选返回失败。"""

    def __init__(self, result: tuple[bool, str] = (True, "")):
        self.calls: list[tuple[str, str]] = []
        self.result = result

    def __call__(self, config: dict, subject: str, text: str) -> tuple[bool, str]:
        self.calls.append((subject, text))
        return self.result


class ProxyHTTPTestCase(unittest.TestCase):
    """启动一个随机端口的代理服务器，测试结束自动关闭。"""

    def setUp(self) -> None:
        self._tmp = make_tempdir()
        self.addCleanup(cleanup_tempdir, self._tmp)
        self.tmpdir = Path(self._tmp.name)
        self.config_path = self.tmpdir / "config.json"
        self.logger = mail_proxy.setup_logging(None, level=logging.CRITICAL)
        self.state = mail_proxy.ProxyState()
        self.server = None
        self.thread: threading.Thread | None = None
        self.port: int | None = None

    def start_proxy(self, config=None) -> None:
        if config is not None:
            self.config_path.write_text(
                json.dumps(config, ensure_ascii=False), encoding="utf-8"
            )
        store = mail_proxy.ConfigStore(self.config_path, self.logger)
        app = mail_proxy.MailProxyApp(store, self.state, self.logger)
        self.server = mail_proxy.create_server("127.0.0.1", 0, app)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.02},
            daemon=True,
        )
        self.thread.start()
        self.addCleanup(self.stop_proxy)

    def stop_proxy(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
        if self.thread is not None:
            self.thread.join(timeout=5)
            self.thread = None

    def request(
        self,
        method: str,
        path: str,
        payload=None,
        raw: bytes | None = None,
        headers=None,
    ):
        assert self.port is not None
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            body = raw
            req_headers = dict(headers or {})
            if payload is not None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json; charset=utf-8")
            conn.request(method, path, body=body, headers=req_headers)
            resp = conn.getresponse()
            data = resp.read()
            resp_headers = {key.lower(): value for key, value in resp.getheaders()}
            parsed = json.loads(data.decode("utf-8")) if data else None
            return resp.status, resp_headers, parsed
        finally:
            conn.close()

    def assert_cors(self, headers: dict) -> None:
        self.assertEqual(headers.get("access-control-allow-origin"), "*")
        self.assertEqual(
            headers.get("access-control-allow-methods"), "GET, POST, OPTIONS"
        )
        self.assertEqual(
            headers.get("access-control-allow-headers"), "Content-Type"
        )
        self.assertEqual(
            headers.get("access-control-allow-private-network"), "true"
        )


# ---------------------------------------------------------------------------
# HTTP 协议：健康检查、CORS、预检
# ---------------------------------------------------------------------------


class HealthAndCorsTests(ProxyHTTPTestCase):
    def test_health_defaults_and_cors(self):
        self.start_proxy(None)
        status, headers, payload = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assert_cors(headers)
        self.assertEqual(
            headers.get("content-type"), "application/json; charset=utf-8"
        )
        self.assertEqual(
            payload,
            {
                "ok": True,
                "version": mail_proxy.VERSION,
                "lastHeartbeat": 0,
                "mailConfigured": False,
            },
        )

    def test_options_preflight_returns_204(self):
        self.start_proxy(None)
        status, headers, payload = self.request("OPTIONS", "/send")
        self.assertEqual(status, 204)
        self.assertIsNone(payload)
        self.assert_cors(headers)

    def test_health_mail_configured_true(self):
        self.start_proxy(make_config())
        status, _, payload = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["mailConfigured"])

    def test_health_oauth2_reports_authorization_state(self):
        self.start_proxy(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
                oauth_client_id="client-id",
            )
        )
        _, _, payload = self.request("GET", "/health")
        self.assertTrue(payload["mailConfigured"])
        self.assertFalse(payload["oauthAuthorized"])

        (self.tmpdir / "oauth_token.json").write_text(
            json.dumps({"refresh_token": "refresh"}), encoding="utf-8"
        )
        _, _, payload = self.request("GET", "/health")
        self.assertTrue(payload["oauthAuthorized"])

    def test_unknown_path_returns_404_with_cors(self):
        self.start_proxy(None)
        status, headers, payload = self.request("GET", "/no-such-path")
        self.assertEqual(status, 404)
        self.assertEqual(payload["ok"], False)
        self.assert_cors(headers)

    def test_get_send_is_method_not_allowed(self):
        self.start_proxy(None)
        status, headers, payload = self.request("GET", "/send")
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"], "method_not_allowed")
        self.assert_cors(headers)

    def test_health_reloads_config_after_file_created(self):
        self.start_proxy(None)
        _, _, before = self.request("GET", "/health")
        self.assertFalse(before["mailConfigured"])

        self.config_path.write_text(json.dumps(make_config()), encoding="utf-8")
        _, _, after = self.request("GET", "/health")
        self.assertTrue(after["mailConfigured"])


# ---------------------------------------------------------------------------
# 心跳
# ---------------------------------------------------------------------------


class HeartbeatTests(ProxyHTTPTestCase):
    def test_heartbeat_updates_health(self):
        self.start_proxy(None)
        status, _, first = self.request(
            "POST",
            "/heartbeat",
            {"source": "extension", "loggedIn": True, "pending": 2},
        )
        self.assertEqual(status, 200)
        self.assertTrue(first["ok"])
        self.assertIsInstance(first["lastHeartbeat"], int)
        # 返回的是 epoch 毫秒，2020 年之后的值应大于 1.6e12。
        self.assertGreater(first["lastHeartbeat"], 1_600_000_000_000)

        _, _, health = self.request("GET", "/health")
        self.assertEqual(health["lastHeartbeat"], first["lastHeartbeat"])

    def test_heartbeat_accepts_empty_body(self):
        self.start_proxy(None)
        status, _, payload = self.request("POST", "/heartbeat")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertGreater(payload["lastHeartbeat"], 0)


# ---------------------------------------------------------------------------
# /send 参数校验与未配置行为
# ---------------------------------------------------------------------------


class SendValidationTests(ProxyHTTPTestCase):
    def test_send_not_configured_returns_http_200(self):
        self.start_proxy(None)
        status, headers, payload = self.request(
            "POST", "/send", {"subject": "s", "text": "t"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": False, "error": "mail_not_configured"})
        self.assert_cors(headers)

    def test_send_missing_subject(self):
        self.start_proxy(None)
        status, _, payload = self.request("POST", "/send", {"text": "t"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_request")

    def test_send_invalid_json(self):
        self.start_proxy(None)
        status, _, payload = self.request("POST", "/send", raw=b"{not-json")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_json")

    def test_send_empty_content(self):
        self.start_proxy(make_config())
        status, _, payload = self.request(
            "POST", "/send", {"subject": "s", "text": "   "}
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_request")

    def test_send_accepts_html_only(self):
        # 合法请求会走到 SMTP；这里用假 SMTP 分支验证 html-only 不被判非法。
        self.start_proxy(make_config())
        with mock.patch("mail_proxy.smtplib.SMTP") as smtp_cls:
            smtp_cls.return_value.send_message.return_value = {}
            status, _, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "", "html": "<p>x</p>"}
            )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


# ---------------------------------------------------------------------------
# 真实 smtplib 代码路径：本地假 SMTP 服务器
# ---------------------------------------------------------------------------


class SendWithFakeSMTPServerTests(ProxyHTTPTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.smtp = FakeSMTPServer()
        self.smtp_thread = threading.Thread(
            target=self.smtp.serve_forever,
            kwargs={"poll_interval": 0.02},
            daemon=True,
        )
        self.smtp_thread.start()
        # addCleanup 是 LIFO：shutdown -> join -> server_close
        self.addCleanup(self.smtp.server_close)
        self.addCleanup(self.smtp_thread.join, 3)
        self.addCleanup(self.smtp.shutdown)

    def test_send_success_through_smtplib(self):
        self.start_proxy(make_config(smtp_port=self.smtp.server_address[1]))

        status, headers, payload = self.request(
            "POST",
            "/send",
            {
                "subject": "测试主题",
                "text": "这是纯文本正文",
                "html": "<p>这是 HTML 正文</p>",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})
        self.assert_cors(headers)

        self.assertEqual(len(self.smtp.messages), 1)
        record = self.smtp.messages[0]
        self.assertTrue(record["from"].endswith("sender@example.com>"))
        self.assertTrue(record["rcpt"][0].endswith("rcpt@example.com>"))

        parsed = email.message_from_bytes(record["data"], policy=email.policy.default)
        self.assertEqual(parsed["Subject"], "测试主题")
        self.assertEqual(parsed["From"], "sender@example.com")
        self.assertEqual(parsed["To"], "rcpt@example.com")

        plain_part = parsed.get_body(preferencelist=("plain",))
        html_part = parsed.get_body(preferencelist=("html",))
        self.assertIsNotNone(plain_part)
        self.assertIsNotNone(html_part)
        self.assertEqual(plain_part.get_content().strip(), "这是纯文本正文")
        self.assertEqual(html_part.get_content().strip(), "<p>这是 HTML 正文</p>")


# ---------------------------------------------------------------------------
# 发送失败与分支覆盖（monkeypatch smtplib）
# ---------------------------------------------------------------------------


class SendFailureTests(ProxyHTTPTestCase):
    def test_connection_error_returns_ok_false_and_server_survives(self):
        self.start_proxy(make_config())
        with mock.patch(
            "mail_proxy.smtplib.SMTP",
            side_effect=ConnectionRefusedError("refused"),
        ):
            status, headers, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "t"}
            )
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertIn("network_error", payload["error"])
        self.assert_cors(headers)

        # 进程和 HTTP 服务必须继续可用。
        status, _, health = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])

    def test_timeout_returns_ok_false(self):
        self.start_proxy(make_config())
        with mock.patch("mail_proxy.smtplib.SMTP", side_effect=TimeoutError("timed out")):
            status, _, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "t"}
            )
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": False, "error": "smtp_timeout"})

    def test_auth_failure_does_not_leak_credentials(self):
        secret = "SECRET-AUTH-CODE"
        self.start_proxy(
            make_config(smtp_user="user@example.com", smtp_pass=secret)
        )
        with mock.patch("mail_proxy.smtplib.SMTP") as smtp_cls:
            smtp_cls.return_value.login.side_effect = smtplib.SMTPAuthenticationError(
                535, b"bad credentials"
            )
            status, _, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "t"}
            )
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "smtp_auth_failed")
        dumped = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn(secret, dumped)
        self.assertNotIn("user@example.com", dumped)

    def test_starttls_falls_back_when_server_does_not_support_it(self):
        self.start_proxy(make_config())
        with mock.patch("mail_proxy.smtplib.SMTP") as smtp_cls:
            smtp_cls.return_value.starttls.side_effect = smtplib.SMTPNotSupportedError(
                "no tls"
            )
            smtp_cls.return_value.send_message.return_value = {}
            status, _, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "t"}
            )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        smtp_cls.return_value.send_message.assert_called_once()

    def test_smtp_ssl_branch_is_used(self):
        self.start_proxy(
            make_config(
                use_ssl=True, smtp_user="user@example.com", smtp_pass="code"
            )
        )
        with mock.patch("mail_proxy.smtplib.SMTP_SSL") as smtp_ssl_cls:
            smtp_ssl_cls.return_value.send_message.return_value = {}
            status, _, payload = self.request(
                "POST", "/send", {"subject": "s", "text": "t"}
            )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        smtp_ssl_cls.assert_called_once()
        self.assertEqual(smtp_ssl_cls.call_args.kwargs["timeout"], 20)
        smtp_ssl_cls.return_value.login.assert_called_once_with(
            "user@example.com", "code"
        )


# ---------------------------------------------------------------------------
# 心跳超时守护
# ---------------------------------------------------------------------------


class HeartbeatGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = make_tempdir()
        self.addCleanup(cleanup_tempdir, self._tmp)
        self.tmpdir = Path(self._tmp.name)
        self.config_path = self.tmpdir / "config.json"
        self.logger = mail_proxy.setup_logging(None, level=logging.CRITICAL)
        self.config_path.write_text(json.dumps(make_config()), encoding="utf-8")
        self.store = mail_proxy.ConfigStore(self.config_path, self.logger)

    def _guard(self, state, sender=None, started_at=0.0, alert_interval=6 * 3600):
        sender = sender or RecordingSender()
        guard = mail_proxy.HeartbeatGuard(
            state,
            self.store,
            self.logger,
            sender,
            started_at=started_at,
            alert_interval=alert_interval,
        )
        return guard, sender

    def test_alert_after_timeout_and_rate_limited_to_six_hours(self):
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=now - 181 * 60)
        guard, sender = self._guard(state)

        self.assertTrue(guard.check_once(now=now))
        self.assertEqual(len(sender.calls), 1)
        self.assertIn("插件监控可能未运行", sender.calls[0][0])
        self.assertIn("6 小时", sender.calls[0][1])

        # 一分钟后再检查：已被 6 小时限流。
        self.assertFalse(guard.check_once(now=now + 60))
        self.assertEqual(len(sender.calls), 1)

        # 超过 6 小时后允许再发一次。
        self.assertTrue(guard.check_once(now=now + 6 * 3600 + 1))
        self.assertEqual(len(sender.calls), 2)

    def test_no_alert_when_heartbeat_is_fresh(self):
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=now - 60)
        guard, sender = self._guard(state)
        self.assertFalse(guard.check_once(now=now))
        self.assertEqual(sender.calls, [])

    def test_startup_grace_period_prevents_immediate_false_alarm(self):
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=0.0)
        guard, sender = self._guard(state, started_at=now)
        self.assertFalse(guard.check_once(now=now + 60))
        self.assertEqual(sender.calls, [])

    def test_no_alert_when_mail_not_configured(self):
        self.config_path.unlink()
        store = mail_proxy.ConfigStore(self.config_path, self.logger)
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=0.0)
        sender = RecordingSender()
        guard = mail_proxy.HeartbeatGuard(
            state, store, self.logger, sender, started_at=0.0
        )
        self.assertFalse(guard.check_once(now=now))
        self.assertEqual(sender.calls, [])
        self.assertEqual(state.last_alert_at, 0.0)

    def test_configured_timeout_is_respected(self):
        self.config_path.write_text(
            json.dumps(make_config(heartbeat_timeout_minutes=10)), encoding="utf-8"
        )
        store = mail_proxy.ConfigStore(self.config_path, self.logger)
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=now - 11 * 60)
        sender = RecordingSender()
        guard = mail_proxy.HeartbeatGuard(
            state, store, self.logger, sender, started_at=0.0
        )
        self.assertTrue(guard.check_once(now=now))
        self.assertEqual(len(sender.calls), 1)

    def test_sender_exception_is_swallowed_and_still_rate_limited(self):
        now = 1_800_000_000.0
        state = mail_proxy.ProxyState(last_heartbeat=now - 200 * 60)

        def bad_sender(config, subject, text):
            raise RuntimeError("boom")

        guard = mail_proxy.HeartbeatGuard(
            state, self.store, self.logger, bad_sender, started_at=0.0
        )
        self.assertFalse(guard.check_once(now=now))
        self.assertEqual(state.last_alert_at, now)


# ---------------------------------------------------------------------------
# 配置解析
# ---------------------------------------------------------------------------


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        cfg = mail_proxy.normalize_config({"smtp_host": "smtp.qq.com"})
        self.assertTrue(cfg["use_ssl"])
        self.assertEqual(cfg["heartbeat_timeout_minutes"], 180)
        self.assertEqual(cfg["port"], 8765)

    def test_camel_case_heartbeat_timeout_compat(self):
        cfg = mail_proxy.normalize_config({"heartbeatTimeoutMinutes": 90})
        self.assertEqual(cfg["heartbeat_timeout_minutes"], 90)

    def test_mail_to_accepts_string_and_list(self):
        cfg = mail_proxy.normalize_config({"mail_to": "a@b.com, c@d.com"})
        self.assertEqual(cfg["mail_to"], ["a@b.com", "c@d.com"])
        cfg = mail_proxy.normalize_config({"mail_to": ["a@b.com", "c@d.com"]})
        self.assertEqual(cfg["mail_to"], ["a@b.com", "c@d.com"])

    def test_invalid_numbers_fall_back_to_defaults(self):
        cfg = mail_proxy.normalize_config(
            {"port": "abc", "heartbeat_timeout_minutes": -5, "smtp_port": "x"}
        )
        self.assertEqual(cfg["port"], 8765)
        self.assertEqual(cfg["heartbeat_timeout_minutes"], 180)
        self.assertEqual(cfg["smtp_port"], 0)

    def test_incomplete_config_is_detected(self):
        cfg = mail_proxy.normalize_config({})
        problems = mail_proxy.config_problems(cfg)
        self.assertIn("smtp_host", problems)
        self.assertIn("smtp_port", problems)
        self.assertIn("mail_from", problems)
        self.assertIn("mail_to", problems)
        self.assertFalse(mail_proxy.is_configured(cfg))

    def test_complete_config_is_configured(self):
        cfg = mail_proxy.normalize_config(make_config())
        self.assertTrue(mail_proxy.is_configured(cfg))

    def test_user_without_password_is_not_configured(self):
        cfg = mail_proxy.normalize_config(
            make_config(smtp_user="u@example.com", smtp_pass="")
        )
        self.assertFalse(mail_proxy.is_configured(cfg))
        self.assertTrue(
            any("smtp_pass" in item for item in mail_proxy.config_problems(cfg))
        )

    def test_invalid_json_returns_none(self):
        with make_tempdir() as tmp_name:
            path = Path(tmp_name) / "config.json"
            path.write_text("{not json", encoding="utf-8")
            logger = mail_proxy.setup_logging(None, level=logging.CRITICAL)
            store = mail_proxy.ConfigStore(path, logger)
            self.assertIsNone(store.get())
            self.assertEqual(
                mail_proxy.config_problems(None),
                ["config.json 不存在或不是合法 JSON"],
            )


# ---------------------------------------------------------------------------
# 邮件构造与错误脱敏
# ---------------------------------------------------------------------------


class MessageAndSanitizeTests(unittest.TestCase):
    def test_build_message_has_plain_and_html_parts(self):
        cfg = mail_proxy.normalize_config(make_config())
        msg = mail_proxy.build_message(cfg, "中文主题", "正文", "<p>HTML</p>")
        self.assertEqual(msg["Subject"], "中文主题")
        self.assertEqual(msg["From"], "sender@example.com")
        self.assertEqual(msg["To"], "rcpt@example.com")
        self.assertTrue(msg.is_multipart())
        types = [part.get_content_type() for part in msg.iter_parts()]
        self.assertIn("text/plain", types)
        self.assertIn("text/html", types)

    def test_sanitize_error_masks_user_and_password(self):
        cfg = {"smtp_user": "user@example.com", "smtp_pass": "TOPSECRET"}
        text = mail_proxy.sanitize_error(
            RuntimeError("login TOPSECRET failed for user@example.com"), cfg
        )
        self.assertNotIn("TOPSECRET", text)
        self.assertNotIn("user@example.com", text)
        self.assertIn("***", text)


# ---------------------------------------------------------------------------
# OAuth2 / XOAUTH2
# ---------------------------------------------------------------------------


class OAuth2ConfigTests(unittest.TestCase):
    def test_oauth2_without_client_id_is_not_configured(self):
        cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
            )
        )
        self.assertEqual(cfg["auth_method"], "oauth2")
        self.assertFalse(mail_proxy.is_configured(cfg))
        self.assertTrue(
            any(
                "oauth_client_id" in item
                for item in mail_proxy.config_problems(cfg)
            )
        )

    def test_oauth2_with_client_id_is_configured_without_password(self):
        cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
                oauth_client_id="client-id",
            )
        )
        self.assertTrue(mail_proxy.is_configured(cfg))

    def test_oauth2_requires_email_username(self):
        cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="not-an-email",
                smtp_pass="",
                oauth_client_id="client-id",
            )
        )
        self.assertFalse(mail_proxy.is_configured(cfg))

    def test_oauth_tenant_rejects_url(self):
        cfg = mail_proxy.normalize_config(
            make_config(oauth_tenant="https://evil.example/")
        )
        self.assertEqual(cfg["oauth_tenant"], mail_proxy.DEFAULT_OAUTH_TENANT)


class OAuth2TokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = make_tempdir()
        self.addCleanup(cleanup_tempdir, self.tmp)
        self.token_path = Path(self.tmp.name) / "oauth_token.json"
        self.cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
                oauth_client_id="client-123",
                oauth_token_file=str(self.token_path),
            )
        )

    def test_cached_access_token_is_reused(self):
        self.token_path.write_text(
            json.dumps(
                {
                    "access_token": "cached-token",
                    "expires_at": int(time.time()) + 3600,
                }
            ),
            encoding="utf-8",
        )
        with mock.patch("mail_proxy._oauth_post_json") as post:
            token = mail_proxy.OAuth2TokenManager(self.cfg).get_access_token()
        self.assertEqual(token, "cached-token")
        post.assert_not_called()

    def test_refresh_token_is_used_and_new_token_saved(self):
        self.token_path.write_text(
            json.dumps({"refresh_token": "refresh-old"}), encoding="utf-8"
        )
        with mock.patch(
            "mail_proxy._oauth_post_json",
            return_value={
                "access_token": "new-access",
                "refresh_token": "refresh-new",
                "expires_in": 3600,
                "scope": "smtp",
                "token_type": "Bearer",
            },
        ) as post:
            token = mail_proxy.OAuth2TokenManager(self.cfg).get_access_token()
        self.assertEqual(token, "new-access")
        post.assert_called_once()
        saved = json.loads(self.token_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "refresh-new")
        self.assertEqual(saved["access_token"], "new-access")
        self.assertGreater(saved["expires_at"], int(time.time()))

    def test_invalid_grant_requires_login(self):
        self.token_path.write_text(
            json.dumps({"refresh_token": "expired"}), encoding="utf-8"
        )
        with mock.patch(
            "mail_proxy._oauth_post_json",
            side_effect=mail_proxy.OAuth2HTTPError(400, "invalid_grant"),
        ):
            with self.assertRaises(mail_proxy.OAuth2LoginRequired):
                mail_proxy.OAuth2TokenManager(self.cfg).get_access_token()

    def test_missing_refresh_token_requires_login(self):
        with self.assertRaises(mail_proxy.OAuth2LoginRequired):
            mail_proxy.OAuth2TokenManager(self.cfg).get_access_token()

    def test_device_code_login_saves_tokens(self):
        device = {
            "device_code": "device-123",
            "user_code": "ABCD-EFGH",
            "verification_uri": "https://example.test/device",
            "interval": 1,
            "expires_in": 900,
            "message": "test message",
        }
        token = {
            "access_token": "access-123",
            "refresh_token": "refresh-123",
            "expires_in": 3600,
            "scope": "smtp",
            "token_type": "Bearer",
        }
        calls = []

        def fake_post(url, data, timeout=20):
            calls.append((url, data))
            if url.endswith("/devicecode"):
                return device
            return token

        output = []
        with mock.patch("mail_proxy._oauth_post_json", side_effect=fake_post):
            mail_proxy.oauth_device_code_login(
                self.cfg, output=output.append, sleep=lambda _: None
            )
        saved = json.loads(self.token_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["refresh_token"], "refresh-123")
        self.assertIn("ABCD-EFGH", "\n".join(output))
        self.assertTrue(any("devicecode" in url for url, _ in calls))
        self.assertTrue(any("token" in url for url, _ in calls))


class OAuth2SendTests(unittest.TestCase):
    def test_oauth2_uses_xoauth2_and_skips_password_login(self):
        cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
                oauth_client_id="client-123",
                mail_from="me@outlook.com",
                mail_to="me@outlook.com",
            )
        )
        fake_server = mock.MagicMock()
        fake_server.send_message.return_value = {}
        with mock.patch(
            "mail_proxy.OAuth2TokenManager.get_access_token",
            return_value="ACCESS-TOKEN",
        ), mock.patch("mail_proxy.smtplib.SMTP", return_value=fake_server):
            ok, error = mail_proxy.send_mail(cfg, "主题", "正文")
        self.assertTrue(ok, error)
        fake_server.auth.assert_called_once()
        mechanism, authobject = fake_server.auth.call_args[0]
        self.assertEqual(mechanism, "XOAUTH2")
        auth_string = authobject()
        self.assertEqual(
            auth_string,
            "user=me@outlook.com\x01auth=Bearer ACCESS-TOKEN\x01\x01",
        )
        self.assertEqual(authobject(b"challenge"), "")
        fake_server.login.assert_not_called()

    def test_oauth2_login_required_is_returned_as_error_code(self):
        cfg = mail_proxy.normalize_config(
            make_config(
                auth_method="oauth2",
                smtp_user="me@outlook.com",
                smtp_pass="",
                oauth_client_id="client-123",
                mail_from="me@outlook.com",
                mail_to="me@outlook.com",
            )
        )
        with mock.patch(
            "mail_proxy.OAuth2TokenManager.get_access_token",
            side_effect=mail_proxy.OAuth2LoginRequired("missing"),
        ):
            ok, error = mail_proxy.send_mail(cfg, "主题", "正文")
        self.assertFalse(ok)
        self.assertEqual(error, "oauth_login_required")


if __name__ == "__main__":
    unittest.main(verbosity=2)
