"""Локальный сервер без кэширования: браузер всегда берёт свежие модули после правок.

Запуск: python3 scripts/serve.py [порт]  (по умолчанию 8080), из корня проекта.
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f'http://localhost:{port}')
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
