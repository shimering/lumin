(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LuminConsentDocument=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const fonts=['Arial','Tahoma','Amiri','Segoe UI','Times New Roman','Georgia','Courier New'];
  const sizes=['10px','12px','14px','16px','18px','20px','24px','28px','32px','36px','48px'];
  const variables=[['patient_name','Patient name','اسم المريض'],['patient_number','File number','رقم الملف'],['birth_date','Date of birth','تاريخ الميلاد'],['phone','Phone','الهاتف'],['address','Address','العنوان'],['age','Age','العمر'],['gender','Gender','النوع'],['doctor_name','Treating doctor','الطبيب المعالج'],['date','Date','التاريخ'],['procedure','Procedure / teeth','الإجراء / الأسنان'],['details','Treatment details','تفاصيل العلاج']];
  variables.push(['doctor_name_ar','Treating doctor (Arabic)','اسم الطبيب المعالج بالعربية'],['implant_count','Implant count','عدد الزراعات'],['implant_types','Implant types','أنواع الزراعات'],['implant_teeth','Implant teeth','أسنان الزراعة'],['implant_unit_price','Price per implant','ثمن الزرعة الواحدة'],['implant_total','Total implant fee','إجمالي تكلفة الزراعة'],['implant_details','Implant type and tooth details','نوع الزراعة ومكانها'],['payment_arrangement','Payment arrangement','طريقة السداد'],['first_visit_fee_mode','First visit fee method','طريقة حساب الدفعة الأولى'],['first_visit_percent','First visit percentage','نسبة دفعة الزيارة الأولى'],['first_visit_amount','First visit amount','مبلغ الزيارة الأولى'],['restoration_months','Restoration interval (months)','مدة التركيب بالأشهر'],['remaining_amount','Remaining amount','المبلغ المتبقي'],['monthly_installment_count','Monthly installment count','عدد الأقساط الشهرية'],['monthly_installment_amount','Monthly installment amount','قيمة القسط الشهري'],['final_installment_amount','Final installment amount','قيمة القسط الأخير']);
  const keys=variables.map(row=>row[0]);
  const promptedKeys=new Set(keys.filter(key=>key==='doctor_name_ar'||key.startsWith('implant_')||key.startsWith('first_visit_')||key==='payment_arrangement'||key==='restoration_months'||key==='remaining_amount'||key.includes('installment_')));
  let fieldSequence=0;
  const fieldId=()=>`field-${Date.now().toString(36)}-${(++fieldSequence).toString(36)}`;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  function dimensionValid(key,value){if(key==='cellHeight'&&value==='auto')return true;const number=typeof value==='string'&&/^\d+px$/.test(value)?Number(value.slice(0,-2)):NaN;return Number.isInteger(number)&&number>=(key==='cellWidth'?64:16)&&number<=(key==='cellWidth'?640:480);}
  function normalize(value){
    if(!object(value)||Object.keys(value).some(key=>key!=='ops')||!Array.isArray(value.ops)||value.ops.length>2500)throw new Error('document');
    let length=0;
    const ops=value.ops.map(op=>{
      if(!object(op)||Object.keys(op).some(key=>!['insert','attributes'].includes(key)))throw new Error('document');
      let insert;
      if(typeof op.insert==='string'){insert=op.insert;length+=insert.length;}
      else if(object(op.insert)&&Object.keys(op.insert).length===1&&keys.includes(op.insert.consentVariable)){insert={consentVariable:op.insert.consentVariable};length+=op.insert.consentVariable.length+4;}
      else throw new Error('document');
      const attributes={};
      if(op.attributes!==undefined){
        if(!object(op.attributes))throw new Error('document');
        for(const [key,value]of Object.entries(op.attributes)){
          let valid=false;
          if(['bold','italic','underline','strike','blockquote'].includes(key))valid=value===true;
          if(key==='font')valid=fonts.includes(value);
          if(key==='size')valid=sizes.includes(value);
          if(['color','background'].includes(key))valid=typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
          if(key==='header')valid=[1,2,3].includes(value);
          if(key==='indent')valid=Number.isInteger(value)&&value>=1&&value<=8;
          if(key==='align')valid=['left','right','center','justify'].includes(value);
          if(key==='direction')valid=['rtl','ltr'].includes(value);
          if(key==='list')valid=['bullet','ordered'].includes(value);
          if(key==='script')valid=['sub','super'].includes(value);
          if(key==='table')valid=typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
          if(['cellWidth','cellHeight'].includes(key))valid=dimensionValid(key,value);
          if(key==='consentField')valid=keys.includes(value);
          if(key==='consentFieldId')valid=typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
          if(!valid)throw new Error('document');attributes[key]=value;
        }
      }
      return {insert,...(Object.keys(attributes).length?{attributes}:{})};
    }).filter(op=>op.insert!=='');
    if(length>40001||JSON.stringify({ops}).length>200000)throw new Error('document-size');
    if(!ops.length||typeof ops.at(-1).insert!=='string'||!ops.at(-1).insert.endsWith('\n')){ops.push({insert:'\n'});length++;}
    if(ops.length>2500||length>40001)throw new Error('document-size');
    return {ops};
  }
  function fromText(text=''){return normalize({ops:[{insert:String(text).replace(/\r\n?/g,'\n').replace(/\n$/,'')+'\n'}]});}
  function read(value,fallback=''){try{return value?normalize(value):fromText(fallback);}catch{return fromText(fallback);}}
  function tokenize(value){
    const ops=[];
    for(const op of normalize(value).ops){
      if(op.attributes?.consentField){ops.push(op);continue;}
      if(typeof op.insert!=='string'){ops.push(op);continue;}
      let previous=0;
      for(const match of op.insert.matchAll(/\{\{([a-z_]+)\}\}/g)){
        if(!keys.includes(match[1]))continue;
        if(match.index>previous)ops.push({...op,insert:op.insert.slice(previous,match.index)});
        ops.push({...op,insert:{consentVariable:match[1]}});previous=match.index+match[0].length;
      }
      if(previous<op.insert.length)ops.push({...op,insert:op.insert.slice(previous)});
    }
    return normalize({ops});
  }
  function text(value){return normalize(value).ops.map(op=>typeof op.insert==='string'?op.insert:'{{'+op.insert.consentVariable+'}}').join('').trim();}
  function resolve(value,values,options={}){return normalize({ops:tokenize(value).ops.map(op=>{if(typeof op.insert==='string')return op;const key=op.insert.consentVariable,raw=values[key],insert=(String(raw??'')||(options.keepEmpty&&promptedKeys.has(key)?'{{'+key+'}}':'')).replace(options.bind?/\r?\n/g:/$^/g,'; ');return {...op,insert,...(options.bind?{attributes:{...op.attributes,consentField:key,consentFieldId:fieldId()}}:{})};})});}
  function inline(op){
    const attrs=op.attributes||{};let result=typeof op.insert==='string'?escape(op.insert):`<span class="consent-variable-label">${escape('{{'+op.insert.consentVariable+'}}')}</span>`;
    if(attrs.bold)result=`<strong>${result}</strong>`;if(attrs.italic)result=`<em>${result}</em>`;if(attrs.underline)result=`<u>${result}</u>`;if(attrs.strike)result=`<s>${result}</s>`;
    if(attrs.script)result=`<${attrs.script==='sub'?'sub':'sup'}>${result}</${attrs.script==='sub'?'sub':'sup'}>`;
    const styles=[];
    if(attrs.font)styles.push('font-family:'+attrs.font);
    if(attrs.size)styles.push('font-size:'+attrs.size);
    if(attrs.color)styles.push('color:'+attrs.color);
    if(attrs.background)styles.push('background-color:'+attrs.background);
    return styles.length?`<span style="${escape(styles.join(';'))}">${result}</span>`:result;
  }
  function html(value){
    const lines=[];let chunks=[];
    for(const op of normalize(value).ops){
      if(typeof op.insert!=='string'){chunks.push(inline(op));continue;}
      const parts=op.insert.split('\n');
      parts.forEach((part,index)=>{if(part)chunks.push(inline({...op,insert:part}));if(index<parts.length-1){lines.push({body:chunks.join('')||'<br>',attrs:op.attributes||{}});chunks=[];}});
    }
    if(chunks.length)lines.push({body:chunks.join(''),attrs:{}});
    let result='',list='';
    for(let index=0;index<lines.length;index++){
      const line=lines[index];
      if(line.attrs.table){
        if(list){result+=`</${list}>`;list='';}
        const rows=[];let rowId=null;
        while(index<lines.length&&lines[index].attrs.table){const cell=lines[index];if(cell.attrs.table!==rowId){rows.push([]);rowId=cell.attrs.table;}rows.at(-1).push(cell);index++;}index--;
        const widths=rows[0].map(cell=>parseInt(cell.attrs.cellWidth)||160),total=widths.reduce((sum,width)=>sum+width,0);
        result+=`<div class="consent-table-print-wrap"><table class="consent-document-table" style="width:100%;max-width:${total}px;table-layout:fixed"><colgroup>${widths.map(width=>`<col style="width:${width/total*100}%"/>`).join('')}</colgroup><tbody>${rows.map(row=>`<tr style="height:${row.every(cell=>cell.attrs.cellHeight==='auto')?'auto':Math.max(...row.map(cell=>cell.attrs.cellHeight==='auto'?0:parseInt(cell.attrs.cellHeight)||44))+'px'}">${row.map(cell=>`<td${cell.attrs.direction||cell.attrs.align?` style="${cell.attrs.direction?'direction:'+cell.attrs.direction+';':''}${cell.attrs.align?'text-align:'+cell.attrs.align:''}"`:''}>${cell.body}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        continue;
      }
      const a=line.attrs,wanted=a.list==='ordered'?'ol':a.list==='bullet'?'ul':'';
      if(list!==wanted){if(list)result+=`</${list}>`;if(wanted)result+=`<${wanted}>`;list=wanted;}
      const tag=wanted?'li':a.header?'h'+a.header:a.blockquote?'blockquote':'p';
      const styles=[];if(a.align)styles.push('text-align:'+a.align);if(a.direction)styles.push('direction:'+a.direction);if(a.indent)styles.push('margin-inline-start:'+(a.indent*1.5)+'em');
      result+=`<${tag}${styles.length?' style="'+styles.join(';')+'"':''}>${line.body}</${tag}>`;
    }
    if(list)result+=`</${list}>`;return result;
  }
  return {fonts,sizes,variables,fieldId,escape,dimensionValid,normalize,fromText,read,tokenize,text,resolve,html};
});
