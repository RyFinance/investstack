"""python -m valora serve [port] | api GET|POST <path> [json] | demo | market"""
import json
import sys


def main():
    a = sys.argv[1:] or ["serve"]
    if a[0] == "serve":
        from .server import serve
        serve(int(a[1]) if len(a) > 1 else 8780)
    elif a[0] == "api":
        from .server import api_get, api_post
        from urllib.parse import urlparse, parse_qs
        u = urlparse(a[2])
        r = api_get(u.path, {k: v[-1] for k, v in parse_qs(u.query).items()}) if a[1] == "GET" else api_post(u.path, json.loads(a[3]) if len(a) > 3 else {}, cli=True)
        code, body = r or (404, b'{"error":"not found"}')
        sys.stdout.write(body.decode())
    elif a[0] == "demo":
        from . import db, demo
        with db.db(True) as c:
            print(demo.build(c))
    elif a[0] == "market":
        from .jobs import JOB
        JOB._run(len(a) > 1 and a[1] == "force")
        print(JOB.state())


if __name__ == "__main__":
    main()
