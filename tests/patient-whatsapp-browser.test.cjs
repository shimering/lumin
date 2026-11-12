const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const fileUrl = 'file://' + path.join(root, 'patient-whatsapp.html').replace(/\\/g, '/');

test('Patient WhatsApp Discrete Page - Complete Functionality Suite', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();

  try {
    // 1. Navigate to patient-whatsapp.html
    await page.goto(fileUrl);
    await page.waitForLoadState('domcontentloaded');

    // 2. Verify Title Bar Elements
    const titleText = await page.locator('.brand-text h1').textContent();
    assert.match(titleText, /Patient WhatsApp/i, 'Title bar must show brand');

    const messagePicker = page.locator('#messagePicker');
    assert.equal(await messagePicker.isVisible(), true, 'Message picker should be visible in title bar');

    const openDrawerBtn = page.locator('#openDrawerBtn');
    assert.equal(await openDrawerBtn.isVisible(), true, 'Insert template button must be visible in title bar');

    const resetCheckboxesBtn = page.locator('#resetCheckboxesBtn');
    assert.equal(await resetCheckboxesBtn.isVisible(), true, 'Reset checkboxes button must be visible in title bar');

    // 3. Verify Table Columns (Only Checkbox, Name, Phone, WhatsApp)
    const tableHeaders = await page.locator('.patient-table th').allTextContents();
    const cleanHeaders = tableHeaders.map(h => h.trim()).filter(Boolean);
    assert.deepEqual(cleanHeaders, ['Patient Name', 'Phone Number', 'WhatsApp'], 'Columns must be only Checkbox, Name, Phone, WhatsApp');

    // Verify rows exist
    const rows = page.locator('.patient-table tbody tr.patient-row');
    const rowCount = await rows.count();
    assert.ok(rowCount > 0, 'Table should render patient rows');

    // 4. Test Checkbox & Translucent Green Row
    const firstRow = rows.first();
    const firstCheckbox = firstRow.locator('.patient-row-checkbox');
    assert.equal(await firstRow.evaluate(el => el.classList.contains('row-checked')), false, 'Row initially unchecked');

    // Click checkbox
    await firstCheckbox.check();
    assert.equal(await firstRow.evaluate(el => el.classList.contains('row-checked')), true, 'Row has row-checked class');
    
    // Check computed background color is translucent green (rgba with 16, 185, 129)
    const bgColor = await firstRow.locator('td').first().evaluate(el => window.getComputedStyle(el).backgroundColor);
    assert.ok(bgColor.includes('16, 185, 129') || bgColor.includes('16,185,129'), `Expected translucent green background, got: ${bgColor}`);

    // Check checked badge
    const badgeText = await page.locator('#checkedCountText').textContent();
    assert.match(badgeText, /1 checked/i, 'Badge should update count');

    // Test Reset Checkboxes Button in Title Bar
    await resetCheckboxesBtn.click();
    assert.equal(await firstRow.evaluate(el => el.classList.contains('row-checked')), false, 'Row must not have row-checked class after reset');
    assert.equal(await firstCheckbox.isChecked(), false, 'Checkbox must be unchecked after reset');
    const badgeAfterReset = await page.locator('#checkedCountText').textContent();
    assert.match(badgeAfterReset, /0 checked/i, 'Badge should show 0 checked');

    // 5. Test Side Panel (Drawer) & Variable Insertion
    assert.equal(await page.locator('#drawerPanel').evaluate(el => el.classList.contains('open')), false, 'Drawer initially closed');
    await openDrawerBtn.click();
    assert.equal(await page.locator('#drawerPanel').evaluate(el => el.classList.contains('open')), true, 'Drawer opens on insert button click');

    // Clear and fill title
    await page.locator('#templateTitleInput').fill('VIP Recall');
    const bodyTextarea = page.locator('#templateBodyInput');
    await bodyTextarea.fill('Hello ');

    // Click {{patient_name}} variable insertion button
    await page.locator('#varPatientNameBtn').click();
    const currentBody = await bodyTextarea.inputValue();
    assert.equal(currentBody, 'Hello {{patient_name}}', 'Variable {{patient_name}} must be inserted at cursor');

    // Check live preview has replaced {{patient_name}}
    const previewText = await page.locator('#templateLivePreview').textContent();
    assert.ok(previewText.includes('أحمد محمد') || previewText.includes('Ahmed Mohamed'), 'Live preview should replace {{patient_name}} with sample name');

    // Save Template
    await page.locator('#saveTemplateBtn').click();
    assert.equal(await page.locator('#drawerPanel').evaluate(el => el.classList.contains('open')), false, 'Drawer closes on save');

    // Verify picker now has the active template selected
    const selectedTitle = await messagePicker.evaluate(el => el.options[el.selectedIndex].text);
    assert.match(selectedTitle, /VIP Recall/i, 'Message picker should select the newly saved template');

    // 6. Verify WhatsApp Link with Variable Replacement
    const firstRowWaLink = firstRow.locator('a.whatsapp-btn');
    const waHref = await firstRowWaLink.getAttribute('href');
    assert.ok(waHref.startsWith('https://web.whatsapp.com/') || waHref.startsWith('https://api.whatsapp.com/'), 'WhatsApp link must target web.whatsapp.com or api.whatsapp.com to avoid emoji corruption');
    assert.ok(waHref.includes('text='), 'WhatsApp link must include encoded text parameter');

    const firstPatientName = (await firstRow.locator('.patient-name-text').textContent()).trim();
    const decodedUrl = decodeURIComponent(waHref);
    assert.ok(decodedUrl.includes(firstPatientName), `WhatsApp URL must contain the resolved patient name "${firstPatientName}". Decoded URL: ${decodedUrl}`);
    assert.equal(waHref.includes('%EF%BF%BD'), false, 'WhatsApp link must NEVER contain corrupted emoji replacement bytes (%EF%BF%BD)');

    // 7. Verify Pagination: 1, 20, 50
    const pageSizeSelect = page.locator('#pageSizeSelect');
    
    // Switch to 1 patient per page
    await pageSizeSelect.selectOption('1');
    assert.equal(await rows.count(), 1, 'Page size 1 should show exactly 1 patient');
    const pageDisplay1 = await page.locator('#pageCurrentDisplay').textContent();
    assert.match(pageDisplay1, /Page 1 of/i, 'Page indicator should show Page 1');

    // Next page button
    await page.locator('#nextPageBtn').click();
    const pageDisplay2 = await page.locator('#pageCurrentDisplay').textContent();
    assert.match(pageDisplay2, /Page 2 of/i, 'Next page button advances to Page 2');

    // Switch to 50 patients per page
    await pageSizeSelect.selectOption('50');
    const count50 = await rows.count();
    assert.ok(count50 > 1, 'Page size 50 should show loaded patients');

    // 8. Verify Dynamic Database Update (Adding patients to database updates table)
    const countBeforeAdd = await rows.count();
    await page.evaluate(() => {
      window.addPatientRecord({
        id: 'realtime-patient-999',
        name: 'Dr. Ziad Mostafa Al-Ghamdi',
        phone: '01011223344',
        created_at: new Date().toISOString()
      });
    });

    const countAfterAdd = await rows.count();
    assert.equal(countAfterAdd, countBeforeAdd + 1, 'Table must immediately update when a new patient is added to the database');
    const newPatientNameOnPage = await page.locator('#patient-row-realtime-patient-999 .patient-name-text').textContent();
    assert.equal(newPatientNameOnPage.trim(), 'Dr. Ziad Mostafa Al-Ghamdi', 'New patient name must be rendered in table');

    // 9. Verify Checked State Persistence Across Page Reload / Reopen
    // Check the new patient row
    const realtimeRow = page.locator('#patient-row-realtime-patient-999');
    const realtimeCheckbox = realtimeRow.locator('.patient-row-checkbox');
    await realtimeCheckbox.check();
    assert.equal(await realtimeRow.evaluate(el => el.classList.contains('row-checked')), true, 'New patient row marked with row-checked class');

    // Check localStorage has the ID persisted
    const savedCheckedIds = await page.evaluate(() => localStorage.getItem('lumin_discrete_checked_patient_ids'));
    assert.ok(savedCheckedIds && savedCheckedIds.includes('realtime-patient-999'), 'Checked patient ID must be persisted in localStorage');

    // Reload the page to simulate closing and reopening
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Confirm that the checked patient maintains green translucent row and checkbox checked
    const reloadedBadge = await page.locator('#checkedCountText').textContent();
    assert.match(reloadedBadge, /[1-9]\d*\s*checked/i, 'Checked count must be maintained after page reload');

    // 10. Verify Auth Modal & Sign In Flow
    const authBtn = page.locator('#authBtn');
    assert.equal(await authBtn.isVisible(), true, 'Auth button must be visible in header');
    await authBtn.click();
    assert.equal(await page.locator('#authModal').evaluate(el => el.classList.contains('open')), true, 'Auth modal opens on click');

    // Press Escape to close modal
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#authModal').evaluate(el => el.classList.contains('open')), false, 'Auth modal closes on Escape key');

    // 11. Verify Unauthenticated State Does NOT Reset Checked Patients or Wipe Cache
    // Simulate unauthenticated fetch (empty session)
    await page.evaluate(() => {
      localStorage.setItem('lumin_discrete_checked_patient_ids', JSON.stringify(['demo-1', 'demo-2']));
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    const demoRow1 = page.locator('#patient-row-demo-1');
    const demoRow2 = page.locator('#patient-row-demo-2');
    assert.equal(await demoRow1.evaluate(el => el.classList.contains('row-checked')), true, 'demo-1 remains marked green after unauthenticated reload');
    assert.equal(await demoRow2.evaluate(el => el.classList.contains('row-checked')), true, 'demo-2 remains marked green after unauthenticated reload');
    assert.equal(await demoRow1.locator('.patient-row-checkbox').isChecked(), true, 'demo-1 checkbox is checked');
    assert.equal(await demoRow2.locator('.patient-row-checkbox').isChecked(), true, 'demo-2 checkbox is checked');

    // Reset checkboxes to clean up
    await resetCheckboxesBtn.click();
    assert.equal(await demoRow1.evaluate(el => el.classList.contains('row-checked')), false, 'demo-1 unchecked after reset');
    assert.equal(await demoRow2.evaluate(el => el.classList.contains('row-checked')), false, 'demo-2 unchecked after reset');

    // 12. Verify Clicking WhatsApp Chat Button Marks Row Checked and Persists
    const demoRow3 = page.locator('#patient-row-demo-3');
    const demo3WaBtn = page.locator('#patient-row-demo-3 .whatsapp-btn');
    assert.equal(await demoRow3.evaluate(el => el.classList.contains('row-checked')), false, 'demo-3 initially unchecked');
    
    // Intercept click on WhatsApp button to prevent navigation to external WhatsApp web in headless test
    await page.evaluate(() => {
      const btn = document.querySelector('#patient-row-demo-3 .whatsapp-btn');
      if (btn) {
        btn.removeAttribute('target');
        btn.addEventListener('click', e => e.preventDefault());
      }
    });
    await demo3WaBtn.click();
    assert.equal(await demoRow3.evaluate(el => el.classList.contains('row-checked')), true, 'demo-3 row becomes green and checked when Chat button is clicked');
    assert.equal(await demoRow3.locator('.patient-row-checkbox').isChecked(), true, 'demo-3 checkbox is checked');

    // Reload and check it persists
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(await page.locator('#patient-row-demo-3').evaluate(el => el.classList.contains('row-checked')), true, 'demo-3 green marking persists after reload');

    // 13. Verify Real UUID Two-Way Merge & Re-signing Persistence
    // Check real UUID patient
    await page.evaluate(() => {
      localStorage.setItem('lumin_discrete_cached_patients', JSON.stringify([
        { id: '3b4526f5-ced3-4474-bc2d-84bdefd2123f', name: 'مي عبدالله', phone: '01012345678', whatsapp_checked: false }
      ]));
      localStorage.setItem('lumin_discrete_checked_patient_ids', JSON.stringify([
        '3b4526f5-ced3-4474-bc2d-84bdefd2123f'
      ]));
    });

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    const realRow = page.locator('#patient-row-3b4526f5-ced3-4474-bc2d-84bdefd2123f');
    assert.equal(await realRow.evaluate(el => el.classList.contains('row-checked')), true, 'Real patient remains green checked across resign-in/reload');
    assert.equal(await realRow.locator('.patient-row-checkbox').isChecked(), true, 'Real patient checkbox remains checked');
    const finalBadge = await page.locator('#checkedCountText').textContent();
    assert.match(finalBadge, /[1-9]\d*\s*checked/i, 'Checked count badge is never 0 when patients were selected');

  } finally {
    await browser.close();
  }
});
