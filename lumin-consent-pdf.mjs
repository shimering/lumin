// Render the prepared consent locally, one A4 page at a time. No patient data
// leaves the device, and the canvas size stays below iOS's memory limits.
export async function consentPdf(document) {
  const { PDFDocument, PrintScaling } = await import('./vendor/pdf-lib-1.17.1.min.mjs');
  const win = document.defaultView;
  if (!win.html2canvas) throw new Error('PDF renderer unavailable');
  const source = document.querySelector('.consent-print-page');
  const stage = document.createElement('section');
  stage.className = 'consent-pdf-stage';
  stage.setAttribute('aria-hidden', 'true');
  stage.inert = true;
  const header = document.createElement('div'), clip = document.createElement('div'), flow = document.createElement('div');
  header.className = 'consent-pdf-header';
  header.append(source.querySelector('.consent-page-header').cloneNode(true));
  clip.className = 'consent-pdf-clip';
  flow.className = 'consent-rich-content consent-pdf-flow';
  const copy = source.closest('.consent-copy');
  if (copy.classList.contains('consent-draft-copy')) {
    flow.classList.add('consent-draft-copy');
    if (copy.classList.contains('ql-editor')) flow.classList.add('ql-editor');
    flow.style.cssText = copy.style.cssText;
  }
  for (const row of source.tBodies[0].rows) flow.append(row.cells[0].firstElementChild.cloneNode(true));
  clip.append(flow);
  const footer = document.querySelector('.consent-page-footer').cloneNode(true);
  footer.className = 'consent-pdf-footer';
  stage.append(header, clip, footer);
  document.body.append(stage);
  try {
    await document.fonts?.ready;
    const width = stage.getBoundingClientRect().width, height = stage.getBoundingClientRect().height;
    const headerHeight = header.getBoundingClientRect().height, footerHeight = footer.getBoundingClientRect().height;
    const available = height - headerHeight - footerHeight;
    if (available < 100) throw new Error('Letterhead leaves too little space');
    clip.style.top = headerHeight + 'px';
    clip.style.height = available + 'px';
    const columnWidth = clip.getBoundingClientRect().width;
    // Let the browser paginate line boxes, including Arabic font ascenders and
    // mixed inline sizes. Cropping a tall paragraph by pixel offsets cuts glyphs.
    Object.assign(flow.style, { height: available + 'px', columnWidth: columnWidth + 'px', columnGap: '0px', columnFill: 'auto' });
    const origin = flow.getBoundingClientRect();
    const rtl = win.getComputedStyle(flow).direction === 'rtl';
    const extent = [...flow.children].reduce((max, node) => {
      const rect = node.getBoundingClientRect();
      return Math.max(max, rtl ? origin.right - rect.left : rect.right - origin.left);
    }, columnWidth);
    const count = Math.ceil((extent - .5) / columnWidth);
    if (count > 100) throw new Error('Consent exceeds 100 pages');
    const pdf = await PDFDocument.create();
    pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
    for (let index = 0; index < count; index++) {
      flow.style.transform = `translateX(${(rtl ? 1 : -1) * index * columnWidth}px)`;
      const canvas = await win.html2canvas(stage, {
        backgroundColor: '#ffffff', logging: false, scale: Math.min(2, Math.sqrt(2900000 / (width * height))),
        width, height, windowWidth: Math.ceil(width), windowHeight: Math.ceil(height), scrollX: 0, scrollY: 0,
        onclone(clone) { Object.assign(clone.querySelector('.consent-pdf-stage').style, { position: 'absolute', left: '0', top: '0' }); }
      });
      try {
        const image = await pdf.embedPng(canvas.toDataURL('image/png'));
        const page = pdf.addPage([210 * 72 / 25.4, 297 * 72 / 25.4]);
        page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      } finally { canvas.width = canvas.height = 0; }
    }
    return pdf.save();
  } finally { stage.remove(); }
}
