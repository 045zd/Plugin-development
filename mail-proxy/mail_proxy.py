#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习通作业截止提醒 —— 本地 SMTP 邮件代理。

只监听 127.0.0.1，供同机的 Edge 扩展调用，把提醒邮件通过用户自己配置的
SMTP 账号发给自己。仅使用 Python 标准库，兼容 Python 3.10+。

用法：
    python mail_proxy.py [--port 8765] [--config config.json]

设计契约见 docs/design.md 「本地邮件代理 HTTP 协议（mail-proxy）」。
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import re
import smtplib
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import parseaddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

VERSION = "1.0.0"
DEFAULT_PORT = 8765
DEFAULT_HEARTBEAT_TIMEOUT_MINUTES = 180
DEFAULT_WATCHDOG_INTERVAL_SECONDS = 60
ALERT_INTERVAL_SECONDS = 6 * 60 * 60  # 同类提醒至少间隔 6 小时
SMTP_TIMEOUT_SECONDS = 20
MAX_BODY_BYTES = 1024 * 1024  # 请求体上限 1 MB
LOG_MAX_BYTES = 5 * 1024 * 1024  # proxy.log 超过 5MB 轮转一次
LOG_BACKUP_COUNT = 1

# OAuth2（Microsoft identity platform / Outlook SMTP XOAUTH2）
DEFAULT_OAUTH_TENANT = "common"
DEFAULT_OAUTH_SCOPE = "https://outlook.office.com/SMTP.Send offline_access"
OAUTH_HTTP_TIMEOUT_SECONDS = 20
OAUTH_EXPIRY_SKEW_SECONDS = 120
OAUTH_TOKEN_FILENAME = "oauth_token.json"
OAUTH_DEVICE_CODE_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode"
OAUTH_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"

BASE_DIR = Path(__file__).resolve().parent

#: 所有响应（含错误响应与 OPTIONS 预检）都带这些 CORS 头。
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
}


# ---------------------------------------------------------------------------
# 配置读取
# ---------------------------------------------------------------------------


class ConfigError(ValueError):
    """config.json 结构非法。错误消息中绝不包含配置值。"""


def _pick(raw: dict, *keys: str) -> Any:
    """按顺序取第一个存在且非 None 的键（兼容 snake_case 与 camelCase）。"""
    for key in keys:
        if key in raw and raw[key] is not None:
            return raw[key]
    return None


def _as_int(value: Any, default: int) -> int:
    """尽力把配置值转成整数，失败返回默认值。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _as_bool(value: Any, default: bool) -> bool:
    """尽力把配置值转成布尔，失败返回默认值。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("1", "true", "yes", "on", "y"):
            return True
        if low in ("0", "false", "no", "off", "n", ""):
            return False
    return default


def _split_recipients(value: Any) -> list[str]:
    """mail_to 支持字符串（逗号/分号分隔）或字符串数组。"""
    if isinstance(value, (list, tuple)):
        raw: list[str] = []
        for item in value:
            raw.extend(re.split(r"[,;]", str(item)))
    elif isinstance(value, str):
        raw = re.split(r"[,;]", value)
    else:
        return []
    return [part.strip() for part in raw if part.strip()]


def normalize_config(raw: Any) -> dict:
    """把 config.json 的原始对象规范化为内部配置字典。

    只做类型归一化，不校验必填项；是否可发送邮件由 is_configured() 判断。
    """
    if not isinstance(raw, dict):
        raise ConfigError("config.json 顶层必须是 JSON 对象")

    heartbeat_timeout = _as_int(
        _pick(raw, "heartbeat_timeout_minutes", "heartbeatTimeoutMinutes"),
        DEFAULT_HEARTBEAT_TIMEOUT_MINUTES,
    )
    if heartbeat_timeout < 1:
        heartbeat_timeout = DEFAULT_HEARTBEAT_TIMEOUT_MINUTES

    port = _as_int(raw.get("port"), DEFAULT_PORT)
    if not (1 <= port <= 65535):
        port = DEFAULT_PORT

    auth_method = str(_pick(raw, "auth_method", "authMethod") or "password").strip().lower()
    if auth_method not in ("password", "oauth2"):
        auth_method = "password"

    oauth_tenant = str(
        _pick(raw, "oauth_tenant", "oauthTenant") or DEFAULT_OAUTH_TENANT
    ).strip()
    # 只接受租户名/GUID，避免把完整 URL 拼进请求地址。
    if not oauth_tenant or not re.fullmatch(r"[A-Za-z0-9.-]+", oauth_tenant):
        oauth_tenant = DEFAULT_OAUTH_TENANT

    oauth_scope = str(_pick(raw, "oauth_scope", "oauthScope") or "").strip()
    if not oauth_scope:
        oauth_scope = DEFAULT_OAUTH_SCOPE

    return {
        "smtp_host": str(raw.get("smtp_host") or "").strip(),
        "smtp_port": _as_int(raw.get("smtp_port"), 0),
        "smtp_user": str(raw.get("smtp_user") or "").strip(),
        "smtp_pass": str(raw.get("smtp_pass") or "").strip(),
        "mail_from": str(raw.get("mail_from") or "").strip(),
        "mail_to": _split_recipients(raw.get("mail_to")),
        "use_ssl": _as_bool(raw.get("use_ssl"), True),
        "auth_method": auth_method,
        "oauth_client_id": str(
            _pick(raw, "oauth_client_id", "oauthClientId") or ""
        ).strip(),
        "oauth_tenant": oauth_tenant,
        "oauth_scope": oauth_scope,
        "oauth_token_file": str(
            _pick(raw, "oauth_token_file", "oauthTokenFile") or ""
        ).strip(),
        "heartbeat_timeout_minutes": heartbeat_timeout,
        "port": port,
    }


def config_problems(cfg: Optional[dict]) -> list[str]:
    """返回配置存在的问题（字段名或简短说明），绝不包含配置值。"""
    if cfg is None:
        return ["config.json 不存在或不是合法 JSON"]
    problems: list[str] = []
    if not cfg.get("smtp_host"):
        problems.append("smtp_host")
    if not (0 < int(cfg.get("smtp_port") or 0) <= 65535):
        problems.append("smtp_port")
    from_addr = parseaddr(str(cfg.get("mail_from") or ""))[1]
    if not from_addr or "@" not in from_addr:
        problems.append("mail_from")
    if not any(parseaddr(str(addr))[1] for addr in cfg.get("mail_to") or []):
        problems.append("mail_to")

    user = cfg.get("smtp_user") or ""
    method = cfg.get("auth_method") or "password"
    if method == "oauth2":
        if not user or "@" not in parseaddr(str(user))[1]:
            problems.append("smtp_user（OAuth2 需要完整登录邮箱地址）")
        if not cfg.get("oauth_client_id"):
            problems.append(
                "oauth_client_id（OAuth2 需要 Microsoft Entra 应用的客户端 ID）"
            )
    else:
        password = cfg.get("smtp_pass") or ""
        if user and not password:
            problems.append("smtp_pass（填写了 smtp_user 时必须填写授权码）")
        if password and not user:
            problems.append("smtp_user（填写了 smtp_pass 时必须填写账号）")
    return problems


def is_configured(cfg: Optional[dict]) -> bool:
    """SMTP 配置是否完整到可以发信。"""
    return cfg is not None and not config_problems(cfg)


class ConfigStore:
    """读取同目录 config.json，按 mtime + 大小做缓存，支持热更新。

    文件不存在、JSON 损坏、字段不完整时 get() 返回 None 或返回不完整配置，
    调用方用 is_configured() 判断；解析错误只记一次日志，避免刷屏。
    """

    def __init__(self, path: Path | str, logger: logging.Logger):
        self._path = Path(path)
        self._logger = logger
        self._lock = threading.Lock()
        self._cfg: Optional[dict] = None
        self._stamp: Optional[tuple[int, int]] = None
        self._last_error: Optional[str] = None

    @property
    def path(self) -> Path:
        return self._path

    def get(self) -> Optional[dict]:
        try:
            stat = self._path.stat()
        except FileNotFoundError:
            with self._lock:
                self._cfg = None
                self._stamp = None
                self._last_error = None
            return None
        except OSError as exc:
            self._log_error(f"无法读取配置文件：{type(exc).__name__}")
            return None

        stamp = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            if self._stamp == stamp:
                return self._cfg
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError) as exc:
                self._cfg = None
                self._stamp = stamp
                self._log_error(f"配置文件不是合法 JSON：{type(exc).__name__}")
                return None
            try:
                cfg = normalize_config(raw)
            except ConfigError as exc:
                self._cfg = None
                self._stamp = stamp
                self._log_error(str(exc))
                return None
            # 内部字段：解析相对 oauth_token_file 时以配置文件所在目录为基准。
            cfg["_config_path"] = str(self._path)
            self._cfg = cfg
            self._stamp = stamp
            if self._last_error is not None:
                self._logger.info("配置文件已重新加载：%s", self._path)
            self._last_error = None
            return cfg

    def _log_error(self, message: str) -> None:
        if message != self._last_error:
            self._logger.warning("%s（%s）", message, self._path)
            self._last_error = message


# ---------------------------------------------------------------------------
# OAuth2（Outlook / Microsoft identity platform，SMTP XOAUTH2）
# ---------------------------------------------------------------------------


class OAuth2Error(RuntimeError):
    """OAuth2 失败的基类；code 是可以安全返回给调用方的短错误码。"""

    code = "oauth_error"

    def __init__(self, message: str = "", code: Optional[str] = None):
        super().__init__(message or self.code)
        if code:
            self.code = code


class OAuth2LoginRequired(OAuth2Error):
    code = "oauth_login_required"


class OAuth2RefreshFailed(OAuth2Error):
    code = "oauth_refresh_failed"


class OAuth2NetworkError(OAuth2Error):
    code = "oauth_network_error"


class OAuth2TokenFileError(OAuth2Error):
    code = "oauth_token_file_error"


class OAuth2HTTPError(OAuth2Error):
    """token/devicecode 端点返回的 HTTP 错误。

    只保留 error 代码，不把 error_description 拼进异常字符串，避免把
    可能出现的敏感内容带进日志或 HTTP 响应。
    """

    def __init__(self, status: int, error_code: str = "", description: str = ""):
        self.status = int(status)
        self.error_code = (error_code or "http_error").strip() or "http_error"
        self.description = description or ""
        super().__init__(self.error_code, code=self.error_code)


def _oauth_post_json(
    url: str,
    data: dict[str, str],
    timeout: float = OAUTH_HTTP_TIMEOUT_SECONDS,
) -> dict:
    """向 Microsoft identity platform 端点 POST 表单并解析 JSON。

    失败时抛出 OAuth2HTTPError（端点返回错误码）或 OAuth2NetworkError。
    """
    body = urllib.parse.urlencode(data).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": f"chaoxing-mail-proxy/{VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        payload: Any = {}
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        raise OAuth2HTTPError(
            exc.code,
            str(payload.get("error") or ""),
            str(payload.get("error_description") or ""),
        ) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        raise OAuth2NetworkError(type(exc).__name__) from None

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise OAuth2RefreshFailed("invalid_token_response") from None
    if not isinstance(payload, dict):
        raise OAuth2RefreshFailed("invalid_token_response")
    return payload


def _oauth_url(template: str, tenant: str) -> str:
    return template.format(tenant=urllib.parse.quote(str(tenant), safe=""))


def oauth_token_path(config: dict) -> Path:
    """返回 OAuth2 令牌文件路径。

    相对路径以 config.json 所在目录为基准（ConfigStore 会写入内部字段
    ``_config_path``）；没有配置文件上下文时退回脚本目录。
    """
    base_dir = BASE_DIR
    config_path = config.get("_config_path")
    if config_path:
        try:
            base_dir = Path(str(config_path)).resolve().parent
        except OSError:
            pass
    raw = str(config.get("oauth_token_file") or "").strip()
    if not raw:
        return base_dir / OAUTH_TOKEN_FILENAME
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path


class OAuth2TokenStore:
    """本地令牌文件。只保存 refresh_token / access_token 等令牌，不含密码。"""

    def __init__(self, path: Path | str):
        self.path = Path(path)

    def load(self) -> dict:
        try:
            raw = self.path.read_text(encoding="utf-8-sig")
        except FileNotFoundError:
            return {}
        except OSError:
            raise OAuth2TokenFileError("read_failed") from None
        try:
            data = json.loads(raw)
        except ValueError:
            raise OAuth2TokenFileError("invalid_json") from None
        if not isinstance(data, dict):
            raise OAuth2TokenFileError("invalid_json")
        return data

    def save(self, data: dict) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.path)
        except OSError:
            raise OAuth2TokenFileError("write_failed") from None

    def delete(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            raise OAuth2TokenFileError("delete_failed") from None


class OAuth2TokenManager:
    """获取/刷新 SMTP XOAUTH2 所需的 access token。"""

    def __init__(self, config: dict, logger: Optional[logging.Logger] = None):
        self.config = config
        self.logger = logger or logging.getLogger("mail_proxy")
        self.store = OAuth2TokenStore(oauth_token_path(config))
        self._lock = threading.Lock()

    def _token_url(self) -> str:
        tenant = self.config.get("oauth_tenant") or DEFAULT_OAUTH_TENANT
        return _oauth_url(OAUTH_TOKEN_URL, tenant)

    def get_access_token(self) -> str:
        with self._lock:
            data = self.store.load()
            access = str(data.get("access_token") or "")
            expires_at = _as_int(data.get("expires_at"), 0)
            if access and expires_at > time.time() + OAUTH_EXPIRY_SKEW_SECONDS:
                return access

            refresh = str(data.get("refresh_token") or "")
            if not refresh:
                raise OAuth2LoginRequired("no_refresh_token")
            return self._refresh_locked(refresh)

    def _refresh_locked(self, refresh_token: str) -> str:
        try:
            payload = _oauth_post_json(
                self._token_url(),
                {
                    "grant_type": "refresh_token",
                    "client_id": str(self.config.get("oauth_client_id") or ""),
                    "refresh_token": refresh_token,
                    "scope": str(
                        self.config.get("oauth_scope") or DEFAULT_OAUTH_SCOPE
                    ),
                },
            )
        except OAuth2HTTPError as exc:
            if exc.error_code in (
                "invalid_grant",
                "interaction_required",
                "consent_required",
                "login_required",
            ):
                raise OAuth2LoginRequired(exc.error_code) from None
            raise OAuth2RefreshFailed(exc.error_code) from None

        error = str(payload.get("error") or "")
        if error:
            if error in (
                "invalid_grant",
                "interaction_required",
                "consent_required",
                "login_required",
            ):
                raise OAuth2LoginRequired(error) from None
            raise OAuth2RefreshFailed(error) from None

        access = str(payload.get("access_token") or "")
        if not access:
            raise OAuth2RefreshFailed("missing_access_token")

        expires_in = _as_int(payload.get("expires_in"), 3600)
        data = {
            "access_token": access,
            "refresh_token": str(payload.get("refresh_token") or refresh_token),
            "expires_at": int(time.time()) + max(60, expires_in),
            "scope": str(
                payload.get("scope") or self.config.get("oauth_scope") or ""
            ),
            "token_type": str(payload.get("token_type") or "Bearer"),
            "client_id": str(self.config.get("oauth_client_id") or ""),
            "username": str(self.config.get("smtp_user") or ""),
            "tenant": str(
                self.config.get("oauth_tenant") or DEFAULT_OAUTH_TENANT
            ),
            "updated_at": int(time.time()),
        }
        self.store.save(data)
        self.logger.info("OAuth2 访问令牌已刷新")
        return access


def oauth_device_code_login(
    config: dict,
    logger: Optional[logging.Logger] = None,
    output: Callable[[str], None] = print,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """执行 OAuth2 device authorization grant，成功后保存令牌文件。

    这是交互式一次性操作，由命令行 ``--oauth-login`` 调用；HTTP 服务本身
    不会触发它。
    """
    client_id = str(config.get("oauth_client_id") or "").strip()
    if not client_id:
        raise OAuth2LoginRequired("oauth_client_id_missing")

    tenant = str(config.get("oauth_tenant") or DEFAULT_OAUTH_TENANT)
    scope = str(config.get("oauth_scope") or DEFAULT_OAUTH_SCOPE)

    device = _oauth_post_json(
        _oauth_url(OAUTH_DEVICE_CODE_URL, tenant),
        {"client_id": client_id, "scope": scope},
    )
    device_code = str(device.get("device_code") or "")
    user_code = str(device.get("user_code") or "")
    verification_uri = str(device.get("verification_uri") or "")
    message = str(device.get("message") or "")
    interval = max(1, _as_int(device.get("interval"), 5))
    expires_in = max(60, _as_int(device.get("expires_in"), 900))
    if not device_code or not user_code or not verification_uri:
        raise OAuth2RefreshFailed("invalid_device_code_response")

    output("请在浏览器中打开以下地址，并输入显示的代码：")
    output(f"  地址：{verification_uri}")
    output(f"  代码：{user_code}")
    if message:
        output(f"  {message}")
    output("等待授权完成……（Ctrl+C 可取消）")

    deadline = time.time() + expires_in
    while time.time() < deadline:
        try:
            payload = _oauth_post_json(
                _oauth_url(OAUTH_TOKEN_URL, tenant),
                {
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": client_id,
                    "device_code": device_code,
                },
            )
        except OAuth2HTTPError as exc:
            code = exc.error_code
            if code == "authorization_pending":
                sleep(interval)
                continue
            if code == "slow_down":
                interval += 5
                sleep(interval)
                continue
            if code in (
                "authorization_declined",
                "expired_token",
                "bad_verification_code",
            ):
                raise OAuth2LoginRequired(code) from None
            raise OAuth2RefreshFailed(code) from None

        access = str(payload.get("access_token") or "")
        if not access:
            raise OAuth2RefreshFailed("missing_access_token")

        token_expires_in = _as_int(payload.get("expires_in"), 3600)
        data = {
            "access_token": access,
            "refresh_token": str(payload.get("refresh_token") or ""),
            "expires_at": int(time.time()) + max(60, token_expires_in),
            "scope": str(payload.get("scope") or scope),
            "token_type": str(payload.get("token_type") or "Bearer"),
            "client_id": client_id,
            "username": str(config.get("smtp_user") or ""),
            "tenant": tenant,
            "updated_at": int(time.time()),
        }
        OAuth2TokenStore(oauth_token_path(config)).save(data)
        if not data["refresh_token"]:
            output(
                "警告：服务器没有返回 refresh_token；访问令牌过期后需要重新授权。"
                "请确认 oauth_scope 包含 offline_access。"
            )
        output("授权成功，令牌已保存。")
        if logger is not None:
            logger.info("OAuth2 授权成功，令牌文件：%s", oauth_token_path(config))
        return data

    raise OAuth2LoginRequired("expired_token")


def oauth_status_text(config: dict) -> str:
    """生成不包含令牌内容的 OAuth2 状态说明。"""
    path = oauth_token_path(config)
    try:
        data = OAuth2TokenStore(path).load()
    except OAuth2TokenFileError as exc:
        return f"令牌文件不可读：{exc.code}\n文件：{path}"
    if not data:
        return f"尚未授权（未找到令牌文件）\n文件：{path}"

    expires_at = _as_int(data.get("expires_at"), 0)
    if expires_at > time.time():
        expiry = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(expires_at))
        state = f"访问令牌有效至 {expiry}"
    else:
        state = "访问令牌已过期（发送邮件时会自动用 refresh_token 刷新）"
    username = data.get("username") or config.get("smtp_user") or "（未记录）"
    tenant = data.get("tenant") or config.get("oauth_tenant") or DEFAULT_OAUTH_TENANT
    scope = data.get("scope") or config.get("oauth_scope") or ""
    return (
        f"{state}\n"
        f"文件：{path}\n"
        f"账号：{username}\n"
        f"租户：{tenant}\n"
        f"scope：{scope}"
    )


# ---------------------------------------------------------------------------
# SMTP 发送
# ---------------------------------------------------------------------------


def build_message(config: dict, subject: str, text: str, html: Optional[str] = None) -> EmailMessage:
    """用 EmailMessage 组一封纯文本 + 可选 HTML 的邮件。"""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = config["mail_from"]
    msg["To"] = ", ".join(config["mail_to"])
    msg.set_content(text or "", subtype="plain", charset="utf-8")
    if html:
        msg.add_alternative(html, subtype="html", charset="utf-8")
    return msg


def sanitize_error(exc: BaseException, config: Optional[dict]) -> str:
    """把异常转成可返回给调用方的短错误串，并抹掉账号/授权码。"""
    text = f"{type(exc).__name__}: {exc}"
    for secret in (
        (config or {}).get("smtp_pass"),
        (config or {}).get("smtp_user"),
    ):
        if secret:
            text = text.replace(str(secret), "***")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 240:
        text = text[:237] + "..."
    return text


def send_mail(
    config: dict,
    subject: str,
    text: str,
    html: Optional[str] = None,
    timeout: float = SMTP_TIMEOUT_SECONDS,
) -> tuple[bool, str]:
    """同步发送一封邮件。

    返回 (ok, error)。error 为空串表示成功；失败时是脱敏后的简短原因。
    任何网络/SMTP 异常都在这里被捕获，绝不向上抛。
    """
    try:
        msg = build_message(config, subject, text, html)
        from_addr = parseaddr(str(config.get("mail_from") or ""))[1] or str(config.get("mail_from") or "")
        to_addrs = [
            addr
            for _, addr in (parseaddr(str(item)) for item in config.get("mail_to") or [])
            if addr
        ]
        if not from_addr or not to_addrs:
            return False, "smtp_no_recipients"
    except Exception as exc:  # 组邮件失败（配置畸形等）
        return False, "message_build_error: " + sanitize_error(exc, config)

    server: Optional[smtplib.SMTP] = None
    try:
        auth_method = str(config.get("auth_method") or "password").lower()
        xoauth2_string: Optional[str] = None
        if auth_method == "oauth2":
            access_token = OAuth2TokenManager(config).get_access_token()
            user = str(config.get("smtp_user") or "")
            # SASL XOAUTH2: base64 由 smtplib.auth() 负责编码。
            xoauth2_string = f"user={user}\x01auth=Bearer {access_token}\x01\x01"

        context = ssl.create_default_context()
        if config.get("use_ssl"):
            server = smtplib.SMTP_SSL(
                str(config["smtp_host"]),
                int(config["smtp_port"]),
                timeout=timeout,
                context=context,
            )
        else:
            server = smtplib.SMTP(
                str(config["smtp_host"]),
                int(config["smtp_port"]),
                timeout=timeout,
            )
            try:
                server.starttls(context=context)
            except smtplib.SMTPNotSupportedError:
                # 服务器没广告 STARTTLS：按需求继续用明文（用户显式选了 use_ssl=false）。
                pass
        if xoauth2_string is not None:
            def _xoauth2_authobject(challenge: Optional[bytes] = None) -> str:
                # 首次调用返回认证串；服务器再发 challenge 时返回空串结束认证。
                return "" if challenge else xoauth2_string

            server.auth("XOAUTH2", _xoauth2_authobject)
        elif config.get("smtp_user"):
            server.login(str(config["smtp_user"]), str(config.get("smtp_pass") or ""))
        refused = server.send_message(msg, from_addr=from_addr, to_addrs=to_addrs)
        if refused:
            return False, "smtp_recipients_refused"
        return True, ""
    except OAuth2Error as exc:
        # 固定错误码，绝不回显令牌或 Microsoft 返回的原始描述。
        return False, exc.code
    except smtplib.SMTPAuthenticationError:
        # 认证失败固定返回错误码，绝不回显服务器响应或账号。
        return False, "smtp_auth_failed"
    except smtplib.SMTPNotSupportedError as exc:
        return False, "smtp_auth_not_supported: " + sanitize_error(exc, config)
    except smtplib.SMTPRecipientsRefused:
        return False, "smtp_recipients_refused"
    except smtplib.SMTPSenderRefused:
        return False, "smtp_sender_refused"
    except smtplib.SMTPDataError as exc:
        return False, "smtp_data_error: " + sanitize_error(exc, config)
    except smtplib.SMTPConnectError as exc:
        return False, "smtp_connect_failed: " + sanitize_error(exc, config)
    except smtplib.SMTPServerDisconnected as exc:
        return False, "smtp_disconnected: " + sanitize_error(exc, config)
    except smtplib.SMTPException as exc:
        return False, "smtp_error: " + sanitize_error(exc, config)
    except (TimeoutError, socket.timeout):
        return False, "smtp_timeout"
    except ssl.SSLError as exc:
        return False, "smtp_tls_error: " + sanitize_error(exc, config)
    except OSError as exc:
        return False, "network_error: " + sanitize_error(exc, config)
    except Exception as exc:  # 兜底：任何异常都不能让进程崩溃
        return False, "smtp_error: " + sanitize_error(exc, config)
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                try:
                    server.close()
                except Exception:
                    pass


class MailService:
    """在 send_mail 外面包一层日志：只记主题与结果，不记正文。"""

    def __init__(self, logger: logging.Logger):
        self.logger = logger

    def send(
        self,
        config: dict,
        subject: str,
        text: str,
        html: Optional[str] = None,
    ) -> tuple[bool, str]:
        ok, error = send_mail(config, subject, text, html)
        if ok:
            self.logger.info("邮件发送成功 | 主题: %s", subject)
        else:
            self.logger.warning("邮件发送失败 | 主题: %s | 原因: %s", subject, error)
        return ok, error


# ---------------------------------------------------------------------------
# 运行状态与心跳守护
# ---------------------------------------------------------------------------


class ProxyState:
    """进程内状态：最后心跳时间、最后告警时间。

    last_heartbeat 内部用 time.time() 秒；对外 /health、/heartbeat 返回
    epoch 毫秒（与扩展侧其他时间戳单位一致）。
    """

    def __init__(self, last_heartbeat: float = 0.0):
        self._lock = threading.Lock()
        self._last_heartbeat = float(last_heartbeat)
        self._last_alert_at = 0.0
        self._last_meta: dict = {}

    @property
    def last_heartbeat(self) -> float:
        with self._lock:
            return self._last_heartbeat

    @property
    def last_heartbeat_ms(self) -> int:
        with self._lock:
            return int(self._last_heartbeat * 1000)

    @property
    def last_alert_at(self) -> float:
        with self._lock:
            return self._last_alert_at

    def touch(self, meta: Optional[dict] = None) -> int:
        """记录一次心跳，返回 epoch 毫秒。"""
        now = time.time()
        with self._lock:
            self._last_heartbeat = now
            self._last_meta = dict(meta or {})
        return int(now * 1000)

    def mark_alert(self, when: float) -> None:
        with self._lock:
            self._last_alert_at = float(when)


def _format_local_time(timestamp: float) -> str:
    if timestamp <= 0:
        return "从未收到"
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp))


class HeartbeatGuard:
    """检测扩展心跳是否超时，必要时发「插件监控可能未运行」提醒。

    - 判断基准取 max(最后心跳, 代理启动时间)，避免代理刚启动就误报；
    - 同类提醒用独立的 last_alert_at 限流，至少间隔 6 小时；
    - 未配置 SMTP 时只写日志、不发送，也不消耗限流时间戳。
    """

    def __init__(
        self,
        state: ProxyState,
        config_store: ConfigStore,
        logger: logging.Logger,
        sender: Callable[[dict, str, str], tuple[bool, str]],
        started_at: Optional[float] = None,
        alert_interval: float = ALERT_INTERVAL_SECONDS,
    ):
        self.state = state
        self.config_store = config_store
        self.logger = logger
        self._sender = sender
        self._started_at = time.time() if started_at is None else float(started_at)
        self._alert_interval = float(alert_interval)

    def timeout_seconds(self, cfg: Optional[dict]) -> int:
        minutes = DEFAULT_HEARTBEAT_TIMEOUT_MINUTES
        if cfg:
            try:
                minutes = int(cfg.get("heartbeat_timeout_minutes") or DEFAULT_HEARTBEAT_TIMEOUT_MINUTES)
            except (TypeError, ValueError):
                minutes = DEFAULT_HEARTBEAT_TIMEOUT_MINUTES
        return max(1, minutes) * 60

    def check_once(self, now: Optional[float] = None) -> bool:
        """检查一次；真正发出提醒邮件返回 True。"""
        now = time.time() if now is None else float(now)
        cfg = self.config_store.get()
        timeout = self.timeout_seconds(cfg)
        reference = max(self.state.last_heartbeat, self._started_at)

        if now - reference <= timeout:
            return False
        if now - self.state.last_alert_at < self._alert_interval:
            return False
        if not is_configured(cfg):
            self.logger.debug("插件心跳已超时，但邮件未配置，跳过提醒")
            return False

        last_text = _format_local_time(self.state.last_heartbeat)
        subject = "【学习通截止提醒】邮件代理：插件监控可能未运行"
        text = (
            f"本地邮件代理已超过 {timeout // 60} 分钟没有收到浏览器扩展的心跳。\n\n"
            f"最后一次心跳：{last_text}\n"
            f"检查时间：{_format_local_time(now)}\n\n"
            "可能原因：\n"
            "1. Edge 浏览器未启动，或「学习通截止提醒」扩展被禁用/卸载；\n"
            "2. 扩展设置里的邮件代理地址填写不正确（默认 http://127.0.0.1:8765）；\n"
            "3. 电脑休眠、关机或网络中断后刚刚恢复。\n\n"
            "请打开 Edge，确认扩展已启用，并在扩展设置页检查代理地址。\n"
            "本邮件由本机邮件代理自动发送，同类提醒 6 小时内最多一次。\n"
        )

        # 先记限流时间戳，避免发送失败时每 60 秒重试造成邮件风暴。
        self.state.mark_alert(now)
        try:
            ok, error = self._sender(cfg, subject, text)
        except Exception as exc:  # sender 自身异常也不能让守护线程退出
            self.logger.exception("发送心跳超时提醒时发生异常")
            ok, error = False, sanitize_error(exc, cfg)

        if ok:
            self.logger.warning(
                "超过 %d 分钟未收到插件心跳，已发送提醒邮件", timeout // 60
            )
        else:
            self.logger.warning(
                "超过 %d 分钟未收到插件心跳，提醒邮件发送失败：%s",
                timeout // 60,
                error,
            )
        return bool(ok)


def heartbeat_watcher_loop(
    guard: HeartbeatGuard,
    stop_event: threading.Event,
    interval: float = DEFAULT_WATCHDOG_INTERVAL_SECONDS,
) -> None:
    """后台守护线程：每 interval 秒检查一次心跳。"""
    while not stop_event.wait(interval):
        try:
            guard.check_once()
        except Exception:
            guard.logger.exception("心跳检查出现未捕获异常")


# ---------------------------------------------------------------------------
# HTTP 应用
# ---------------------------------------------------------------------------


def validate_send_payload(payload: Any) -> Optional[str]:
    """校验 /send 请求体，返回错误码或 None。"""
    if not isinstance(payload, dict):
        return "invalid_request"
    subject = payload.get("subject")
    if not isinstance(subject, str) or not subject.strip():
        return "invalid_request"
    text = payload.get("text", "")
    if text is None:
        text = ""
    if not isinstance(text, str):
        return "invalid_request"
    html = payload.get("html")
    if html is not None and not isinstance(html, str):
        return "invalid_request"
    if not text.strip() and not (isinstance(html, str) and html.strip()):
        return "invalid_request"
    return None


class MailProxyApp:
    """与 HTTP 传输无关的业务逻辑，方便单元测试。"""

    def __init__(
        self,
        config_store: ConfigStore,
        state: ProxyState,
        logger: logging.Logger,
        mail_service: Optional[MailService] = None,
    ):
        self.config_store = config_store
        self.state = state
        self.logger = logger
        self.mail_service = mail_service or MailService(logger)

    def health_payload(self) -> dict:
        cfg = self.config_store.get()
        payload = {
            "ok": True,
            "version": VERSION,
            "lastHeartbeat": self.state.last_heartbeat_ms,
            "mailConfigured": is_configured(cfg),
        }
        # 仅在 OAuth2 模式下附加，保持原有 password 模式的响应完全不变。
        if cfg and (cfg.get("auth_method") or "password") == "oauth2":
            try:
                token = OAuth2TokenStore(oauth_token_path(cfg)).load()
                payload["oauthAuthorized"] = bool(
                    token.get("refresh_token")
                    or (
                        token.get("access_token")
                        and _as_int(token.get("expires_at"), 0) > time.time()
                    )
                )
            except OAuth2TokenFileError:
                payload["oauthAuthorized"] = False
        return payload

    def handle_heartbeat(self, payload: dict) -> tuple[int, dict]:
        last_ms = self.state.touch(
            {
                "source": payload.get("source"),
                "loggedIn": payload.get("loggedIn"),
                "pending": payload.get("pending"),
            }
        )
        self.logger.debug(
            "收到心跳 source=%r loggedIn=%r pending=%r",
            payload.get("source"),
            payload.get("loggedIn"),
            payload.get("pending"),
        )
        return 200, {"ok": True, "lastHeartbeat": last_ms}

    def handle_send(self, payload: dict) -> tuple[int, dict]:
        error = validate_send_payload(payload)
        if error:
            return 400, {"ok": False, "error": error}

        cfg = self.config_store.get()
        if not is_configured(cfg):
            self.logger.warning("收到 /send 请求，但邮件未配置，拒绝发送")
            return 200, {"ok": False, "error": "mail_not_configured"}

        subject = str(payload["subject"]).strip()
        text = payload.get("text") or ""
        html = payload.get("html") or None
        ok, send_error = self.mail_service.send(cfg, subject, text, html)
        if ok:
            return 200, {"ok": True}
        return 200, {"ok": False, "error": send_error}


# ---------------------------------------------------------------------------
# HTTP 服务器
# ---------------------------------------------------------------------------


class MailProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ChaoxingMailProxy/" + VERSION
    sys_version = ""
    timeout = 30  # 防止慢连接长期占用线程

    # -- 基础设施 ---------------------------------------------------------

    @property
    def app(self) -> MailProxyApp:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        try:
            self.app.logger.debug("HTTP " + fmt, *args)
        except Exception:
            pass

    def _path(self) -> str:
        try:
            return urlsplit(self.path).path or "/"
        except Exception:
            return "/"

    def _send_headers(self) -> None:
        for name, value in CORS_HEADERS.items():
            self.send_header(name, value)

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self._send_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_empty(self, status: int) -> None:
        try:
            self.send_response(status)
            self._send_headers()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self) -> tuple[Optional[bytes], Optional[str], int]:
        """读取请求体，返回 (raw, error_code, http_status)。"""
        if self.headers.get("Transfer-Encoding"):
            return None, "unsupported_transfer_encoding", 400
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return None, "invalid_content_length", 400
        if length < 0:
            return None, "invalid_content_length", 400
        if length > MAX_BODY_BYTES:
            return None, "payload_too_large", 413
        if length == 0:
            return b"", None, 200
        try:
            return self.rfile.read(length), None, 200
        except (OSError, ValueError):
            return None, "invalid_request", 400

    # -- 路由 -------------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler 约定)
        # OPTIONS 预检：204，无响应体，带全部 CORS 头。
        self._send_empty(204)

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = self._path()
            if path == "/health":
                self._send_json(200, self.app.health_payload())
                return
            if path in ("/send", "/heartbeat"):
                self._send_json(405, {"ok": False, "error": "method_not_allowed"})
                return
            self._send_json(404, {"ok": False, "error": "not_found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.app.logger.exception("处理 GET 请求时发生未捕获异常")
            self._send_json(500, {"ok": False, "error": "internal_error"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = self._path()
            raw, error, status = self._read_body()
            if error:
                self._send_json(status, {"ok": False, "error": error})
                return

            if path not in ("/send", "/heartbeat"):
                self._send_json(404, {"ok": False, "error": "not_found"})
                return

            payload: dict = {}
            if raw and raw.strip():
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    self._send_json(400, {"ok": False, "error": "invalid_json"})
                    return
                if not isinstance(parsed, dict):
                    self._send_json(400, {"ok": False, "error": "invalid_json"})
                    return
                payload = parsed

            if path == "/send":
                status, data = self.app.handle_send(payload)
            else:
                status, data = self.app.handle_heartbeat(payload)
            self._send_json(status, data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.app.logger.exception("处理 POST 请求时发生未捕获异常")
            self._send_json(500, {"ok": False, "error": "internal_error"})

    def _method_not_allowed(self) -> None:
        try:
            self._read_body()
        except Exception:
            pass
        self._send_json(405, {"ok": False, "error": "method_not_allowed"})

    do_PUT = _method_not_allowed  # noqa: N815
    do_DELETE = _method_not_allowed  # noqa: N815
    do_PATCH = _method_not_allowed  # noqa: N815


class MailProxyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], app: MailProxyApp):
        self.app = app
        super().__init__(server_address, MailProxyHandler)


def create_server(
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    app: Optional[MailProxyApp] = None,
) -> MailProxyServer:
    """创建 HTTP 服务器（不启动）。端口传 0 可让系统分配，便于测试。"""
    if app is None:
        raise ValueError("app 不能为空")
    return MailProxyServer((host, int(port)), app)


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------


def setup_logging(
    log_path: Optional[Path | str] = None,
    level: int = logging.INFO,
) -> logging.Logger:
    """配置控制台 + 文件日志；proxy.log 超过 5MB 时轮转一次（proxy.log.1）。"""
    logger = logging.getLogger("mail_proxy")
    logger.setLevel(level)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass

    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"
    )
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)

    if log_path is not None:
        path = Path(log_path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        try:
            file_handler = logging.handlers.RotatingFileHandler(
                str(path),
                maxBytes=LOG_MAX_BYTES,
                backupCount=LOG_BACKUP_COUNT,
                encoding="utf-8",
            )
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except OSError as exc:
            logger.warning("无法写入日志文件 %s：%s（仅输出到控制台）", path, exc)
    return logger


# ---------------------------------------------------------------------------
# 启动入口
# ---------------------------------------------------------------------------


def _configure_console() -> None:
    """Windows 控制台编码较旧时，避免个别字符导致日志抛异常。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(errors="replace")
        except Exception:
            pass


def _missing_config_message(config_path: Path) -> str:
    return (
        "=" * 68
        + "\n提示：未找到配置文件\n  "
        + str(config_path)
        + "\n请把同目录下的 config.example.json 复制为 config.json，\n"
        "然后用记事本/VS Code 打开并填写 SMTP 授权码等字段。\n"
        "HTTP 服务仍会启动（/health 可用），但 /send 会返回 mail_not_configured。\n"
        + "=" * 68
    )


def _incomplete_config_message(config_path: Path, problems: list[str]) -> str:
    lines = [
        "=" * 68,
        "提示：邮件配置不完整或不可用",
        f"  配置文件：{config_path}",
        "  需要检查的字段：",
    ]
    lines.extend(f"    - {item}" for item in problems)
    lines.append("HTTP 服务仍会启动（/health 可用），但 /send 会返回 mail_not_configured。")
    lines.append("=" * 68)
    return "\n".join(lines)


def _port_type(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("端口必须是整数") from exc
    if not (1 <= port <= 65535):
        raise argparse.ArgumentTypeError("端口必须在 1-65535 之间")
    return port


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mail_proxy.py",
        description="学习通作业截止提醒 —— 本地 SMTP 邮件代理（仅监听 127.0.0.1）",
    )
    parser.add_argument(
        "--port",
        type=_port_type,
        default=None,
        help=f"HTTP 监听端口（默认取 config.json 的 port，否则 {DEFAULT_PORT}）",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="配置文件路径（默认使用脚本同目录的 config.json）",
    )
    parser.add_argument(
        "--oauth-login",
        action="store_true",
        help="用 OAuth2 设备代码流程登录 Outlook/Microsoft 365，并保存刷新令牌",
    )
    parser.add_argument(
        "--oauth-status",
        action="store_true",
        help="显示 OAuth2 令牌状态（不显示令牌内容）",
    )
    parser.add_argument(
        "--oauth-logout",
        action="store_true",
        help="删除本地 OAuth2 令牌文件",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {VERSION}",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    _configure_console()

    logger = setup_logging(BASE_DIR / "proxy.log")
    config_path = Path(args.config).expanduser() if args.config else BASE_DIR / "config.json"
    try:
        config_path = config_path.resolve()
    except OSError:
        pass

    store = ConfigStore(config_path, logger)
    cfg = store.get()
    problems = config_problems(cfg)

    # OAuth2 维护命令：不启动 HTTP 服务。
    if args.oauth_login or args.oauth_status or args.oauth_logout:
        if cfg is None:
            print(_missing_config_message(config_path))
            return 1
        if args.oauth_logout:
            try:
                OAuth2TokenStore(oauth_token_path(cfg)).delete()
            except OAuth2TokenFileError as exc:
                print(f"删除令牌文件失败：{exc.code}")
                return 1
            print(f"已删除令牌文件：{oauth_token_path(cfg)}")
            return 0
        if args.oauth_status:
            print(oauth_status_text(cfg))
            return 0
        # --oauth-login
        if problems:
            print(_incomplete_config_message(config_path, problems))
            return 1
        if (cfg.get("auth_method") or "password") != "oauth2":
            print("config.json 的 auth_method 不是 oauth2，无法执行 OAuth2 登录。")
            return 1
        try:
            oauth_device_code_login(cfg, logger)
        except OAuth2HTTPError as exc:
            print(f"授权失败：{exc.error_code}（HTTP {exc.status}）")
            return 1
        except OAuth2NetworkError:
            print("授权失败：无法连接 login.microsoftonline.com，请检查网络或代理设置。")
            return 1
        except OAuth2Error as exc:
            print(f"授权失败：{exc.code}")
            return 1
        return 0

    if not config_path.exists():
        print(_missing_config_message(config_path))
        logger.warning("未找到配置文件 %s，HTTP 服务仍会启动", config_path)
    elif problems:
        print(_incomplete_config_message(config_path, problems))
        logger.warning(
            "邮件配置不完整（%s），/send 将返回 mail_not_configured",
            "、".join(problems),
        )
    else:
        logger.info(
            "SMTP 配置已加载：%s:%s（%s），收件人 %d 个",
            cfg["smtp_host"],
            cfg["smtp_port"],
            "SSL" if cfg["use_ssl"] else "SMTP+STARTTLS",
            len(cfg["mail_to"]),
        )
        if (cfg.get("auth_method") or "password") == "oauth2":
            try:
                token_data = OAuth2TokenStore(oauth_token_path(cfg)).load()
                oauth_ready = bool(
                    token_data.get("refresh_token")
                    or (
                        token_data.get("access_token")
                        and _as_int(token_data.get("expires_at"), 0) > time.time()
                    )
                )
            except OAuth2TokenFileError:
                oauth_ready = False
            if oauth_ready:
                logger.info("认证方式：OAuth2（XOAUTH2），已找到本地令牌")
            else:
                logger.warning(
                    "认证方式：OAuth2（XOAUTH2），尚未授权；"
                    "请先运行 python mail_proxy.py --oauth-login"
                )

    port = args.port if args.port is not None else (cfg["port"] if cfg else DEFAULT_PORT)
    state = ProxyState()
    app = MailProxyApp(store, state, logger)

    try:
        server = create_server("127.0.0.1", port, app)
    except OSError as exc:
        logger.error("无法监听 127.0.0.1:%d：%s", port, exc)
        print(
            f"\n启动失败：无法监听 127.0.0.1:{port}。\n"
            "端口可能已被其他程序占用，可用 --port 指定其他端口，例如：\n"
            f"    python mail_proxy.py --port {DEFAULT_PORT + 1}\n"
        )
        return 1

    guard = HeartbeatGuard(state, store, logger, app.mail_service.send)
    stop_event = threading.Event()
    watcher = threading.Thread(
        target=heartbeat_watcher_loop,
        args=(guard, stop_event),
        name="heartbeat-watcher",
        daemon=True,
    )
    watcher.start()

    logger.info(
        "邮件代理已启动：http://127.0.0.1:%d （健康检查 /health）", port
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        logger.info("收到 Ctrl+C，正在停止邮件代理…")
    finally:
        stop_event.set()
        try:
            server.server_close()
        except Exception:
            pass
        watcher.join(timeout=2)
        logger.info("邮件代理已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
