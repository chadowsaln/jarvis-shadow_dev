import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAutomationController, findBrowserExecutable } from '../browser-intelligence/automation.mjs';

test('BrowserAutomation: findBrowserExecutable discovers installed system browser', () => {
  const bin = findBrowserExecutable();
  assert.ok(bin, 'Should find at least one installed browser executable');
  assert.match(bin, /(chromium|chrome|brave)/);
});

test('BrowserAutomation: launch, navigate, evaluate, and fill/click in headless browser', async () => {
  const browser = new BrowserAutomationController();
  try {
    const launchRes = await browser.launch({ headless: true });
    assert.equal(launchRes.ok, true);
    assert.ok(browser.wsUrl);

    // Set interactive HTML content directly into the page
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>JARVIS Test Page</title></head>
        <body>
          <h1 id="title">Automation Header</h1>
          <input id="test-input" type="text" placeholder="Type here..." />
          <button id="test-btn" onclick="document.getElementById('title').innerText = 'Clicked Successfully!'">Submit</button>
        </body>
      </html>
    `;
    const contentRes = await browser.setContent(html);
    assert.equal(contentRes.ok, true);

    // Verify evaluate and title reading
    const titleText = await browser.getText('#title');
    assert.equal(titleText, 'Automation Header');

    // Fill form input
    const fillRes = await browser.fill('#test-input', 'JARVIS V2 Testing');
    assert.equal(fillRes.ok, true);
    assert.equal(fillRes.value, 'JARVIS V2 Testing');

    // Click button and verify state change
    const clickRes = await browser.click('#test-btn');
    assert.equal(clickRes.ok, true);

    const updatedTitle = await browser.getText('#title');
    assert.equal(updatedTitle, 'Clicked Successfully!');
  } finally {
    await browser.close();
  }
});
