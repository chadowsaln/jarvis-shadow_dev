import os
import respan_gateway as rg

cases = {
 'two providers, one key': '''
[providers.anthropic]
vendor = "anthropic"
key = "env:ANTHROPIC_API_KEY"
[providers.openai]
vendor = "openai"
key = "env:OPENAI_API_KEY"
[routes.roamies-side]
to = ["anthropic/claude-haiku-5-5", "openai/gpt-6-luna"]
tries = 2
''',
 'route only, no providers': '''
[routes.roamies-side]
to = "anthropic/claude-haiku-5-5"
''',
}
os.environ['OPENAI_API_KEY'] = 'sk-test-not-real'
for name, cfg in cases.items():
    try:
        gw = rg.Gateway(config=cfg)
        print(name, '-> ok', gw.providers(), gw.models()[:3])
    except Exception as e:
        print(name, '->', type(e).__name__, str(e)[:300])
