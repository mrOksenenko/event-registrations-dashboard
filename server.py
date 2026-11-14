#!/usr/bin/env python3
"""Веб-приложение для анализа данных из registrations.csv.

Только стандартная библиотека Python 3.9+, ничего устанавливать не нужно.

    python3 server.py                 # анализирует registrations.csv рядом со скриптом
    python3 server.py путь/к/файлу.csv

Файл перечитывается при каждом запросе, если он изменился, поэтому правки в CSV
сразу видны на дашборде. Сервер файл НЕ изменяет.

Переменные окружения:
    HOST            адрес прослушивания (по умолчанию 127.0.0.1; 0.0.0.0 — доступ из сети)
    PORT            порт (по умолчанию 8000)
    CSV_PATH        путь к CSV (можно вместо аргумента)
    ADMIN_PASSWORD  если задан — доступ только по логину/паролю (Basic Auth)
    ADMIN_USER      логин (по умолчанию admin)
"""
import base64
import csv
import hmac
import io
import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
CSV_FILE = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CSV_PATH", BASE / "registrations.csv")).expanduser().resolve()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

MAX_FILE = 20 * 1024 * 1024
YES = {"да", "yes", "true", "1", "y", "оплачено", "paid"}
ALIASES = {
    "name": ("name", "имя", "фио", "участник"),
    "city": ("city", "город"),
    "registered": ("registered", "date", "дата", "дата регистрации"),
    "source": ("source", "источник"),
    "ticket": ("ticket", "билет", "тип билета"),
    "paid": ("paid", "оплата", "оплачено"),
}


class DataError(Exception):
    pass


def read_csv():
    """Читает файл мягко: ничего не отбрасывает, проблемы показывает дашборд."""
    try:
        st = CSV_FILE.stat()
    except FileNotFoundError:
        raise DataError(f"Файл не найден: {CSV_FILE}")
    if st.st_size > MAX_FILE:
        raise DataError("Файл слишком большой (больше 20 МБ)")
    text = CSV_FILE.read_text(encoding="utf-8-sig")
    sample = text[:2048]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    table = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]
    if len(table) < 2:
        raise DataError("В файле нет данных")
    head = [h.strip().lower() for h in table[0]]
    idx = {}
    for key, names in ALIASES.items():
        found = [i for i, h in enumerate(head) if h in names]
        if not found:
            raise DataError(f"В файле не найдена колонка «{key}»")
        idx[key] = found[0]
    rows = []
    for r in table[1:]:
        row = {k: (r[i].strip() if i < len(r) else "") for k, i in idx.items() if k != "paid"}
        row["paid"] = (r[idx["paid"]].strip().lower() in YES) if idx["paid"] < len(r) else False
        rows.append(row)
    return {"file": CSV_FILE.name, "modified": int(st.st_mtime), "rows": rows}


class Handler(BaseHTTPRequestHandler):
    server_version = "RegistrationsDashboard/1.0"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args))

    def send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="Dashboard", charset="UTF-8"')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, data, status=200):
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def authorized(self):
        if not ADMIN_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, _, pwd = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except Exception:
            return False
        return (hmac.compare_digest(user.encode(), ADMIN_USER.encode())
                and hmac.compare_digest(pwd.encode(), ADMIN_PASSWORD.encode()))

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        is_api = path.startswith("/api/")
        try:
            if not self.authorized():
                return self.fail(401, "Требуется вход", is_api)
            if path == "/api/data":
                try:
                    return self.send_json(read_csv())
                except DataError as e:
                    return self.send_json({"error": str(e)}, 422)
            if is_api:
                return self.fail(404, "Неизвестный адрес API", True)
            if path in ("", "/"):
                path = "/index.html"
            target = (STATIC / path.lstrip("/")).resolve()
            if STATIC.resolve() not in target.parents or not target.is_file():
                return self.fail(404, "Не найдено", False)
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self.send_bytes(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})
        except Exception as e:  # внутренности наружу не отдаём
            print("ERROR:", repr(e))
            self.fail(500, "Внутренняя ошибка сервера", is_api)

    do_HEAD = do_GET

    def fail(self, status, message, is_api):
        if is_api:
            self.send_json({"error": message}, status)
        else:
            self.send_bytes(status, message.encode("utf-8"), "text/plain; charset=utf-8")

    def do_POST(self):  # приложение только читает данные
        self.fail(405, "Метод не поддерживается", True)

    do_PUT = do_PATCH = do_DELETE = do_POST


def main():
    where = "http://localhost" if HOST in ("127.0.0.1", "0.0.0.0") else f"http://{HOST}"
    print(f"Файл данных: {CSV_FILE}" + ("" if CSV_FILE.exists() else "  (НЕ НАЙДЕН)"))
    print(f"Дашборд:     {where}:{PORT}/")
    print("Пароль:      " + (f"включён (логин {ADMIN_USER})" if ADMIN_PASSWORD else "выключен (задайте ADMIN_PASSWORD)"))
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено")


if __name__ == "__main__":
    main()
