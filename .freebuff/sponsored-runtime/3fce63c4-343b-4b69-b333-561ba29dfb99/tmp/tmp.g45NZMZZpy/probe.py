import json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx
import respan_gateway as rg

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        out = {
            "id": "chatcmpl-fixture", "object": "chat.completion", "created": 0,
            "model": body.get("model", "fixture"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "{\"summary\":\"fixture ok\",\"facts\":[]}"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        data = json.dumps({"object":"list","data":[{"id":"fixture-model","object":"model"}]}).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(data))); self.end_headers(); self.wfile.write(data)

srv = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
print('fixture on', port)

cfg = f'''
listen = "127.0.0.1:0"
[providers.local]
formats = ["openai-chat"]
base_url = "http://127.0.0.1:{port}/v1"
[routes.roamies-side]
to = "local/fixture-model"
'''
gw = rg.Gateway(config=cfg)
print('providers', gw.providers() if True else None)
print('models', gw.models())
r = gw.request("POST", "/v1/chat/completions", json={"model": "roamies-side", "messages": [{"role":"user","content":"hi"}]})
print('status', r.status_code)
print(r.text[:400])
print('requests', gw.requests(limit=5))
