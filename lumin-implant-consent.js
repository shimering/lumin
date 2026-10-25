(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LuminImplantConsent=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const legacyTypes={dz_implantation_i9:'Economic (dual)',dz_implantation_i10:'Standard (b&b)'};
  const isImplant=operation=>Boolean(operation?.isImplantProcedure||operation?.is_implant_procedure||legacyTypes[operation?.code]);
  const defaultType=operation=>String(operation?.implantType||operation?.implant_type||legacyTypes[operation?.code]||'').trim();
  const isTemplate=template=>template?.form_type?template.form_type==='implant':template?.key==='implant';
  const cents=value=>Math.round(Number(value)*100);
  function settings(value={}){
    const result={interval_months:Number(value.interval_months??4),first_visit_percent:Number(value.first_visit_percent??50),payment_mode:value.payment_mode||'two',monthly_count:Number(value.monthly_count??4)};
    result.first_visit_mode=value.first_visit_mode||'percent';result.first_visit_amount=Number(value.first_visit_amount??0);
    if(!Number.isInteger(result.interval_months)||result.interval_months<1||result.interval_months>24||!Number.isFinite(result.first_visit_percent)||result.first_visit_percent<0||result.first_visit_percent>100||!['two','monthly'].includes(result.payment_mode)||!Number.isInteger(result.monthly_count)||result.monthly_count<1||result.monthly_count>60)throw new Error('implant-settings');
    if(!['percent','amount'].includes(result.first_visit_mode)||!Number.isFinite(result.first_visit_amount)||result.first_visit_amount<0||result.first_visit_amount>1000000000)throw new Error('implant-settings');
    return result;
  }
  // Each chart finding is counted once, even when a surface finding is repeated.
  function assignments(patient,lookup=()=>null,progress=[],toothLabel=String){
    const found=new Map(),progressByFinding=new Map(progress.map(item=>[item.finding_id,item]));
    function visit(value,tooth){
      if(!value||typeof value!=='object')return;
      if(value.id&&value.code&&!value.isProcedureStep&&!value.is_procedure_step){
        if(!found.has(value.id)){
          const operation=lookup(value.code),tracked=progressByFinding.get(value.id),stored=value.price;
          const price=stored!==null&&stored!==undefined&&String(stored).trim()!==''?Number(stored):Number(operation?.price);
          found.set(value.id,{finding_id:value.id,code:value.code,name:operation?.name||value.code,tooth:String(tooth||''),tooth_label:tooth?toothLabel(tooth):'',price:Number.isFinite(price)&&price>=0?Math.round(price*100)/100:null,implant_type:String(tracked?.implant_type||defaultType(operation)),is_implant:isImplant(operation),batch_id:value.batchId||value.batch_id||null,billing_multiplier:value.billingMultiplier??value.billing_multiplier??null});
        }
        return;
      }
      Object.values(value).forEach(item=>{if(item&&typeof item==='object')visit(item,tooth);});
    }
    Object.entries(patient?.chartState||patient?.chart_state||{}).forEach(([tooth,value])=>visit(value,tooth==='_meta'?'':tooth));
    const entries=[...found.values()],batches=new Map();
    for(const item of entries)if(item.batch_id){const group=batches.get(item.batch_id)||[];group.push(item);batches.set(item.batch_id,group);}
    for(const group of batches.values())group.forEach((item,index)=>{item.batch_member_count=group.length;item.batch_member_index=index;});
    return entries;
  }
  function unitCost(item){
    const count=Number(item.batch_member_count)||1,multiplier=Number(item.billing_multiplier);
    if(!item.batch_id||!Number.isInteger(multiplier)||multiplier<1)return cents(item.price);
    const total=cents(item.price)*multiplier,base=Math.floor(total/count);
    return Number(item.batch_member_index)===count-1?total-base*(count-1):base;
  }
  function totals(entries,terms){
    terms=settings(terms);
    if(!entries.length||entries.some(item=>!item.is_implant||!item.tooth||!item.implant_type.trim()||item.price===null||!Number.isFinite(Number(item.price))||Number(item.price)<0))throw new Error('implant-procedures');
    // A discounted batch multiplier is spread across its teeth, so consent fees
    // agree with the chart instead of charging the base price for every tooth.
    const total=entries.reduce((sum,item)=>sum+unitCost(item),0);
    const amount=Math.round(total),first=terms.first_visit_mode==='amount'?cents(terms.first_visit_amount):Math.round(amount*terms.first_visit_percent/100),remaining=amount-first;
    if(first>amount)throw new Error('implant-first-payment');
    const monthly=Math.floor(remaining/terms.monthly_count),last=remaining-monthly*(terms.monthly_count-1);
    return {total:amount,first,remaining,monthly,last,count:entries.length};
  }
  function paragraph(entries,terms={},language='en'){
    terms=settings(terms);const amounts=totals(entries,terms),ar=language==='ar';
    const n=value=>new Intl.NumberFormat(ar?'ar-EG':'en-GB',{maximumFractionDigits:2}).format(value);
    const money=value=>n(value/100),types=[...new Set(entries.map(item=>item.implant_type))].join(ar?'، ':', ');
    const prices=[...new Set(entries.map(unitCost))];
    const per=prices.length===1?money(prices[0]):entries.map(item=>`${item.tooth_label||item.tooth}: ${money(unitCost(item))}`).join(ar?'؛ ':'; ');
    let lines=ar?['تاسعا: التكلفة:',`تم الاتفاق على عمل عدد ${n(amounts.count)} زراعات من نوع ${types}`,`ثمن الزرعة الواحدة: ${per}`,'(المبلغ شامل التركيبة الزركون لضرس واحد)',`اجمالي المبلغ: ${money(amounts.total)}`,'',`سيتم دفع في جلسة الزراعة (اول جلسة): ${money(amounts.first)} (${n(terms.first_visit_percent)}٪)`]:['Ninth: Cost:',`It has been agreed to place ${n(amounts.count)} implant(s) of type ${types}.`,`Price per implant: ${per}`,'(The amount includes a zirconia crown for one tooth.)',`Total amount: ${money(amounts.total)}`,'',`Payment at the implant placement visit (first visit): ${money(amounts.first)} (${n(terms.first_visit_percent)}%).`];
    if(terms.first_visit_mode==='amount')lines[6]=ar?`سيتم دفع في جلسة الزراعة (اول جلسة): ${money(amounts.first)}`:`Payment at the implant placement visit (first visit): ${money(amounts.first)}.`;
    if(terms.payment_mode==='two')lines.push(ar?`و بقية المبلغ بعد ${n(terms.interval_months)} أشهر أثناء التركيب على الزراعات، بقيمة: ${money(amounts.remaining)}`:`The remaining amount of ${money(amounts.remaining)} is payable after ${n(terms.interval_months)} month(s), when the restorations are fitted to the implants.`);
    else{
      lines.push(ar?`بقية المبلغ: ${money(amounts.remaining)} على ${n(terms.monthly_count)} أقساط شهرية تبدأ بعد شهر من جلسة الزراعة.`:`The remaining amount of ${money(amounts.remaining)} is payable in ${n(terms.monthly_count)} monthly installment(s), starting one month after the implant placement visit.`);
      lines.push(ar?`قيمة القسط الشهري: ${money(amounts.monthly)}؛ القسط الأخير: ${money(amounts.last)}`:`Monthly installment: ${money(amounts.monthly)}; final installment: ${money(amounts.last)}.`);
      lines.push(ar?`موعد التركيب على الزراعات بعد ${n(terms.interval_months)} أشهر.`:`The implant restorations are planned after ${n(terms.interval_months)} month(s).`);
    }
    lines.push('',...entries.map(item=>ar?`الزراعة نوع ${item.implant_type} في مكان ضرس ${item.tooth_label||item.tooth}`:`Implant type ${item.implant_type} at tooth ${item.tooth_label||item.tooth}.`));
    return lines.join('\n');
  }
  function documentWithParagraph(document,paragraph,language){
    const ops=[...document.ops,{insert:'\n'}];
    paragraph.split('\n').forEach((line,index)=>{ops.push({insert:line,...(index===0?{attributes:{bold:true}}:{})});ops.push({insert:'\n',attributes:{direction:language==='ar'?'rtl':'ltr',align:language==='ar'?'right':'left'}});});
    return {ops};
  }
  function withoutParagraph(document,paragraph){
    const raw=document.ops.map(op=>typeof op.insert==='string'?op.insert:'{{'+op.insert.consentVariable+'}}').join('');
    if(!raw.trimEnd().endsWith('\n\n'+paragraph))return document;
    let remaining=raw.trimEnd().length-paragraph.length-1;
    const ops=[];
    for(const op of document.ops){const length=typeof op.insert==='string'?op.insert.length:1;if(remaining<=0)break;ops.push(typeof op.insert==='string'?{...op,insert:op.insert.slice(0,remaining)}:op);remaining-=length;}
    return {ops};
  }
  return {isImplant,defaultType,isTemplate,settings,assignments,totals,paragraph,documentWithParagraph,withoutParagraph};
});
