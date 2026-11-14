import respan_gateway as rg
try:
    gw = rg.Gateway()
    print('gateway built')
    with gw.serve(port=0) as server:
        print('url', server.url)
except Exception as e:
    print(type(e).__name__, e)
