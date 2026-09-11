// One physical page layout for both the Admin preview and the printable PDF.
// Coordinates are PDF points (72/inch); canvas uses native font shaping for Arabic.
const PT_PER_MM = 72 / 25.4;
const INK = '#172033';
const MUTED = '#475569';
const LINE = '#d8dfe7';
const PAPER_TINT = '#f8fafc';

export function pageGeometry(settings) {
  const size = settings.pageSize === 'A4' ? [210, 297] : [148, 210];
  const [widthMm, heightMm] = settings.orientation === 'landscape' ? size.reverse() : size;
  const margin = key => Math.max(0, Math.min(40, Number(settings[key]) || 0)) * PT_PER_MM;
  const width = widthMm * PT_PER_MM;
  const height = heightMm * PT_PER_MM;
  const left = margin('marginLeftMm');
  const top = margin('marginTopMm');
  const right = width - margin('marginRightMm');
  const bottom = height - margin('marginBottomMm');
  return { width, height, widthMm, heightMm, left, top, right, bottom };
}

function rtl(text) {
  return /^[^A-Za-z\u0590-\u08ff]*[\u0590-\u08ff]/u.test(text);
}

function font(size, family, bold = false) {
  return `${bold ? '700' : '400'} ${size}px "${family}"`;
}

export function wrapText(text, width, measure) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/u)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      const joined = line ? `${line} ${word}` : word;
      if (measure(joined) <= width) {
        line = joined;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      // Split pathological unbroken input as well, so no cell can overflow.
      for (const character of Array.from(word)) {
        if (line && measure(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line.trim());
  }
  return lines.length ? lines : [''];
}

export function layoutPrescription(model, settings, context, logo = null) {
  const geometry = pageGeometry(settings);
  const { left, top, right, bottom } = geometry;
  const family = ['Arial', 'Georgia', 'Tahoma', 'Trebuchet MS'].includes(settings.fontFamily) ? settings.fontFamily : 'Arial';
  // Existing Admin font sizes are CSS px. Convert once to physical PDF points.
  const size = Math.min(24, Math.max(8, Number(settings.fontSize) || 11)) * .75;
  const leading = size * 1.45;
  const pad = 6;
  const contentLeft = left + 1;
  const contentWidth = right - left - 2;
  const textLines = (text, w, textSize = size, bold = false) => {
    context.font = font(textSize, family, bold);
    return wrapText(text, Math.max(1, w), value => context.measureText(value).width);
  };
  const textCommand = (text, x, y, w, textSize = size, bold = false, color = INK, align) => ({
    type: 'text', text: String(text), x, y, width: w, size: textSize, family, bold, color,
    align: align || (rtl(String(text)) ? 'right' : 'left'), direction: rtl(String(text)) ? 'rtl' : 'ltr'
  });
  const lineCommand = y => ({ type: 'line', x: contentLeft, y, width: contentWidth, color: LINE });
  const paragraphCommands = (lines, x, y, w, textSize = size, bold = false, color = INK, align) =>
    lines.map((value, index) => textCommand(value, x, y + index * textSize * 1.45, w, textSize, bold, color, align));

  const header = [];
  let y = top + 1;
  if (settings.logoVisible) {
    if (logo) {
      const ratio = Math.min(contentWidth * .64 / logo.width, 60 / logo.height);
      const w = logo.width * ratio;
      const h = logo.height * ratio;
      header.push({ type: 'image', x: contentLeft + (contentWidth - w) / 2, y, width: w, height: h });
      y += h + 14;
    } else {
      header.push(textCommand('LUMIN', contentLeft, y, contentWidth, size * 2.2, true, INK, 'center'));
      y += size * 2.4;
      header.push(textCommand('Dental Clinic', contentLeft, y, contentWidth, size, true, MUTED, 'center'));
      y += leading + 14;
    }
  }
  for (const [text, textSize, bold] of [[settings.title, size * 1.25, true], [settings.subtitle, size, false]]) {
    if (!text) continue;
    const lines = textLines(text, contentWidth - 2 * pad, textSize, bold);
    header.push(...paragraphCommands(lines, contentLeft + pad, y, contentWidth - 2 * pad, textSize, bold, INK, 'center'));
    y += lines.length * textSize * 1.45 + 6;
  }
  y += 6;
  const fieldWidth = contentWidth / 2;
  const labelWidth = fieldWidth * .43;
  for (let index = 0; index < model.fields.length; index += 2) {
    const fields = model.fields.slice(index, index + 2).map(([label, value]) => ({
      label: textLines(label, labelWidth - 2 * pad, size, true),
      value: textLines(value, fieldWidth - labelWidth - 2 * pad)
    }));
    const rowHeight = Math.max(...fields.map(field => Math.max(field.label.length, field.value.length))) * leading + 2 * pad;
    fields.forEach((field, column) => {
      const x = contentLeft + column * fieldWidth;
      header.push({ type: 'rect', x, y, width: labelWidth, height: rowHeight, color: PAPER_TINT });
      header.push(...paragraphCommands(field.label, x + pad, y + pad, labelWidth - 2 * pad, size, true));
      header.push(...paragraphCommands(field.value, x + labelWidth + pad, y + pad, fieldWidth - labelWidth - 2 * pad));
    });
    y += rowHeight;
    header.push(lineCommand(y));
  }
  y += 14;
  // Use ordinary glyphs: the prescription Unicode symbol is absent in some fonts.
  header.push({ ...textCommand('R', contentLeft, y, size * 1.5, size * 1.8, true), family: 'Georgia' });
  header.push({ ...textCommand('x', contentLeft + size * 1.25, y + size, size, size, true), family: 'Georgia' });
  y += size * 2.1 + 8;
  const bodyTop = y;
  const footerLines = settings.footerVisible && settings.footerText ? textLines(settings.footerText, contentWidth - 2 * pad) : [];
  const footerHeight = footerLines.length ? footerLines.length * leading + 13 : 0;
  const bodyBottom = bottom - footerHeight - 2;
  const weights = model.columns.map((column, index) => index === 0 ? 2.6 : (column.key === 'route' ? 1.2 : 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const columns = model.columns.map((column, index) => ({ ...column, width: contentWidth * weights[index] / totalWeight }));
  const tableHeadingLines = columns.map(column => textLines(column.label, column.width - 2 * pad, size * .82, true));
  const tableHeadingHeight = Math.max(...tableHeadingLines.map(lines => lines.length)) * leading * .82 + 2 * pad;
  if (contentWidth < 80 || bodyBottom - bodyTop < tableHeadingHeight + leading + 2 * pad) {
    throw new Error('The selected margins, header or footer leave too little room. Reduce them or choose a smaller font.');
  }
  const pages = [];
  let commands;
  const newPage = (withTable = true) => {
    if (pages.length >= 100) throw new Error('This prescription is too long to print.');
    commands = [...header];
    pages.push({ commands });
    y = bodyTop;
    if (settings.bordered) commands.push({ type: 'border', x: left + .25, y: top + .25, width: right - left - .5, height: bottom - top - .5, color: LINE });
    if (footerLines.length) {
      const footerTop = bottom - footerHeight;
      commands.push(lineCommand(footerTop));
      commands.push(...paragraphCommands(footerLines, contentLeft + pad, footerTop + 10, contentWidth - 2 * pad, size, false, MUTED, 'center'));
    }
    if (withTable) {
      commands.push({ type: 'rect', x: contentLeft, y, width: contentWidth, height: tableHeadingHeight, color: PAPER_TINT });
      let x = contentLeft;
      columns.forEach((column, index) => {
        commands.push(...paragraphCommands(tableHeadingLines[index], x + pad, y + pad, column.width - 2 * pad, size * .82, true));
        x += column.width;
      });
      y += tableHeadingHeight;
      commands.push(lineCommand(y));
    }
  };
  newPage();
  model.rows.forEach((row, rowIndex) => {
    const cellLines = columns.map((column, columnIndex) => {
      const value = columnIndex === 0 ? `${rowIndex + 1}) ${row[column.key]}` : row[column.key];
      return textLines(value, column.width - 2 * pad, size, columnIndex === 0);
    });
    const count = Math.max(...cellLines.map(lines => lines.length));
    const fullHeight = count * leading + 2 * pad;
    if (y + fullHeight > bodyBottom && y > bodyTop + tableHeadingHeight) newPage();
    let offset = 0;
    while (offset < count) {
      const capacity = Math.floor((bodyBottom - y - 2 * pad) / leading);
      if (capacity < 1) { newPage(); continue; }
      const take = Math.min(capacity, count - offset);
      let x = contentLeft;
      columns.forEach((column, columnIndex) => {
        commands.push(...paragraphCommands(cellLines[columnIndex].slice(offset, offset + take), x + pad, y + pad, column.width - 2 * pad, size, columnIndex === 0));
        x += column.width;
      });
      y += take * leading + 2 * pad;
      commands.push(lineCommand(y));
      offset += take;
      if (offset < count) newPage();
    }
  });
  if (model.notes) {
    const lines = textLines(`Note: ${model.notes}`, contentWidth - 2 * pad);
    y += 14;
    for (const line of lines) {
      if (y + leading > bodyBottom) newPage(false);
      commands.push(textCommand(line, contentLeft + pad, y, contentWidth - 2 * pad));
      y += leading;
    }
  }
  return { ...geometry, pages, logo, title: settings.title || 'Prescription' };
}

export function paintPrescriptionPage(layout, pageIndex, canvas, requestedScale = 300 / 72) {
  // Bound the raster below 4 MP, including A4, to avoid iPad canvas memory failures.
  const scale = Math.min(requestedScale, Math.sqrt(4_000_000 / (layout.width * layout.height)));
  canvas.width = Math.floor(layout.width * scale);
  canvas.height = Math.floor(layout.height * scale);
  const context = canvas.getContext('2d');
  context.scale(canvas.width / layout.width, canvas.height / layout.height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, layout.width, layout.height);
  for (const command of layout.pages[pageIndex].commands) {
    context.fillStyle = command.color || INK;
    context.strokeStyle = command.color || LINE;
    context.lineWidth = .5;
    if (command.type === 'rect') context.fillRect(command.x, command.y, command.width, command.height);
    if (command.type === 'border') context.strokeRect(command.x, command.y, command.width, command.height);
    if (command.type === 'line') {
      context.beginPath(); context.moveTo(command.x, command.y); context.lineTo(command.x + command.width, command.y); context.stroke();
    }
    if (command.type === 'image') context.drawImage(layout.logo, command.x, command.y, command.width, command.height);
    if (command.type === 'text') {
      context.font = font(command.size, command.family, command.bold);
      context.textAlign = command.align;
      context.direction = command.direction;
      context.textBaseline = 'top';
      const x = command.x + (command.align === 'center' ? command.width / 2 : command.align === 'right' ? command.width : 0);
      context.fillText(command.text, x, command.y);
    }
  }
  return canvas;
}

export async function preparePrescriptionPages(model, settings) {
  if (document.fonts?.ready) await document.fonts.ready;
  let logo = null;
  if (settings.logoVisible && settings.logoDataUrl) {
    logo = await new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => reject(new Error('The clinic logo could not be loaded. Please try again.')), 10000);
      image.onload = () => { clearTimeout(timeout); resolve(image); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('The clinic logo could not be loaded.')); };
      image.src = settings.logoDataUrl;
    });
  }
  return layoutPrescription(model, settings, document.createElement('canvas').getContext('2d'), logo);
}

export async function prescriptionPdfBytes(layout, createCanvas = () => document.createElement('canvas')) {
  const { PDFDocument, PrintScaling } = await import('./vendor/pdf-lib-1.17.1.min.mjs');
  const pdf = await PDFDocument.create();
  pdf.setTitle(layout.title);
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  for (let index = 0; index < layout.pages.length; index++) {
    const canvas = paintPrescriptionPage(layout, index, createCanvas());
    try {
      const image = await pdf.embedPng(canvas.toDataURL('image/png'));
      const page = pdf.addPage([layout.width, layout.height]);
      page.drawImage(image, { x: 0, y: 0, width: layout.width, height: layout.height });
      await pdf.flush();
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
  return pdf.save();
}
