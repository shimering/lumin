// Render the prepared consent locally, one A4 page at a time. No patient data
// leaves the device, and the canvas size stays below iOS's memory limits.
function listNumber(value,style){
  if(style==='lower-alpha'){
    let label='';for(let n=value;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(97+(n-1)%26)+label;
    return label;
  }
  if(style==='lower-roman'){
    let label='';for(const [amount,symbol] of [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']])while(value>=amount){label+=symbol;value-=amount;}
    return label;
  }
  return String(value);
}

function preparePdfLists(flow){
  const win=flow.ownerDocument.defaultView;
  for(const list of flow.querySelectorAll('ol,ul')){
    const counters=Array(9).fill(0);let number=(Number(list.getAttribute('start'))||1)-1;
    for(const item of [...list.children].filter(node=>node.tagName==='LI')){
      const quill=item.hasAttribute('data-list'),level=Number([...item.classList].find(name=>/^ql-indent-[1-8]$/.test(name))?.split('-').at(-1)||0);
      const ordered=quill?item.dataset.list==='ordered':list.tagName==='OL';
      let text='•';
      if(ordered){
        const value=quill?++counters[level]:++number;
        text=listNumber(value,quill?['decimal','lower-alpha','lower-roman'][level%3]:win.getComputedStyle(item).listStyleType)+'.';
      }
      counters.fill(0,level+1);
      const style=win.getComputedStyle(item),rtl=style.direction==='rtl',font=parseFloat(style.fontSize);
      const inset=parseFloat(rtl?style.paddingRight:style.paddingLeft)-(quill?2:1.8)*font;
      const marker=item.querySelector(':scope>.ql-ui')||flow.ownerDocument.createElement('span');
      // Freeze markers as real text. Canvas renderers cannot reliably resolve
      // Quill counters or logical positioning on generated ::before content.
      marker.className='consent-pdf-list-marker';marker.textContent=text;
      marker.style.cssText=`position:absolute;top:0;${rtl?'right':'left'}:${inset}px;width:${1.5*font}px;margin:0;padding:0;border:0;white-space:nowrap;direction:ltr;unicode-bidi:isolate;text-align:${rtl?'left':'right'};font:inherit;color:inherit`;
      item.style.position='relative';item.style.listStyleType='none';item.prepend(marker);
    }
  }
}

function preserveArabicWords(stage){
  const doc=stage.ownerDocument,walker=doc.createTreeWalker(stage,4),nodes=[];
  while(walker.nextNode())if(/[\u0600-\u06ff]/.test(walker.currentNode.textContent)&&/\s/.test(walker.currentNode.textContent))nodes.push(walker.currentNode);
  // A word plus its trailing space can span two line boxes. html2canvas then
  // draws individual Arabic letters, losing their joined forms. Separate word
  // nodes keep shaping intact. Do this before pagination so any wrapping is
  // measured from the exact text nodes the canvas renderer will receive.
  for(const node of nodes){
    const fragment=doc.createDocumentFragment();
    for(const part of node.textContent.split(/(\s+)/)){
      if(!part)continue;
      fragment.append(doc.createTextNode(part));
    }
    node.replaceWith(fragment);
  }
}

export async function prepareConsentPages(document) {
  const win = document.defaultView;
  const source = document.querySelector('.consent-print-page');
  const layout = win.LuminConsentLayout?.normalize(JSON.parse(document.querySelector('#consent-print-root').dataset.consentLayout||'{}'))||{margin_top_mm:0,margin_bottom_mm:0,margin_left_mm:12,margin_right_mm:12,logo_pages:'all'};
  const stage = document.createElement('section');
  stage.className = 'consent-pdf-stage';
  if(win.LuminConsentLayout)stage.style.cssText=win.LuminConsentLayout.styles(layout);
  stage.setAttribute('aria-hidden', 'true');
  stage.inert = true;
  const header = document.createElement('div'), clip = document.createElement('div'), flow = document.createElement('div');
  header.className = 'consent-pdf-header';
  header.style.paddingTop=layout.margin_top_mm+'mm';
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
  if(win.LuminConsentLayout)stage.insertAdjacentHTML('beforeend',win.LuminConsentLayout.frameMarkup(layout));
  document.body.append(stage);
  try {
    await document.fonts?.ready;
    preserveArabicWords(stage);
    preparePdfLists(flow);
    const width = stage.getBoundingClientRect().width, height = stage.getBoundingClientRect().height;
    const headerHeight = header.getBoundingClientRect().height, footerHeight = footer.getBoundingClientRect().height;
    const available = height - headerHeight - footerHeight - layout.margin_bottom_mm*96/25.4;
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
    function select(index){
      flow.style.transform = `translateX(${(rtl ? 1 : -1) * index * columnWidth}px)`;
      const logo=header.querySelector('[data-consent-letterhead-logo]');if(logo)logo.style.visibility=layout.logo_pages==='first'&&index>0?'hidden':'visible';
    }
    return {stage,count,width,height,select,dispose:()=>stage.remove()};
  }catch(error){stage.remove();throw error;}
}

export async function prepareNativePages(document){
  const root=document.querySelector('#consent-print-root');root.querySelector('.consent-native-pages')?.remove();
  const pages=await prepareConsentPages(document),host=document.createElement('div');host.className='consent-native-pages';
  try{
    for(let index=0;index<pages.count;index++){
      pages.select(index);const sheet=pages.stage.cloneNode(true);sheet.className='consent-native-sheet';sheet.removeAttribute('aria-hidden');sheet.inert=false;host.append(sheet);
    }
    root.append(host);root.dataset.consentPaged='true';
    if(!document.querySelector('[data-consent-page-size]')){const style=document.createElement('style');style.dataset.consentPageSize='';style.textContent='@page{size:A4;margin:0}';document.head.append(style);}
  }finally{pages.dispose();}
}

export async function consentPdf(document) {
  const { PDFDocument, PrintScaling } = await import('./vendor/pdf-lib-1.17.1.min.mjs');
  const win=document.defaultView;if(!win.html2canvas)throw new Error('PDF renderer unavailable');
  const pages=await prepareConsentPages(document),{stage,width,height}=pages;
  try{
    const pdf=await PDFDocument.create();pdf.setTitle(document.title||'Consent');pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
    for(let index=0;index<pages.count;index++){
      pages.select(index);
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
  } finally { pages.dispose(); }
}
