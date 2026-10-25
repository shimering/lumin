-- Shared, versioned wording; patient documents keep their own text and identity snapshot.
create table public.consent_templates (
  id uuid primary key default gen_random_uuid(),
  title_en text not null check (length(btrim(title_en)) between 1 and 200),
  title_ar text not null default '' check (length(title_ar) <= 200),
  body_en text not null check (length(btrim(body_en)) between 1 and 40000),
  body_ar text not null default '' check (length(body_ar) <= 40000),
  procedure_codes text[] not null default '{}' check (cardinality(procedure_codes) <= 1000 and array_position(procedure_codes,null) is null),
  source_url text not null default '' check (source_url = '' or source_url = 'https://dentolize.com/tools/dental-consent-form-generator/'),
  active boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.patient_consents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  template_id uuid not null references public.consent_templates(id) on delete restrict,
  template_revision integer not null check (template_revision > 0),
  language text not null check (language in ('en','ar')),
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 40000),
  patient_data jsonb not null check (jsonb_typeof(patient_data) = 'object' and octet_length(patient_data::text) <= 10000),
  doctor_id uuid references public.user_profiles(user_id) on delete restrict,
  doctor_name text not null check (length(btrim(doctor_name)) between 1 and 200),
  procedure_code text not null default '' check (length(procedure_code) <= 100),
  procedure_name text not null default '' check (length(procedure_name) <= 1000),
  finding_ids uuid[] not null default '{}' check (cardinality(finding_ids) <= 1000 and array_position(finding_ids,null) is null),
  status text not null default 'draft' check (status in ('draft','finalized')),
  revision integer not null default 1 check (revision > 0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz,
  check ((status = 'draft' and finalized_at is null) or (status = 'finalized' and finalized_at is not null))
);
create index patient_consents_history_idx on public.patient_consents(patient_id,created_at desc,id);
create index patient_consents_template_idx on public.patient_consents(template_id);
create index patient_consents_doctor_idx on public.patient_consents(doctor_id);

alter table public.consent_templates enable row level security;
alter table public.patient_consents enable row level security;
revoke all on public.consent_templates,public.patient_consents from public,anon,authenticated;
grant select,insert,update on public.consent_templates,public.patient_consents to authenticated;
grant all on public.consent_templates,public.patient_consents to service_role;

create policy consent_templates_read on public.consent_templates for select to authenticated
using ((select private.is_active_user()) and ((select private.is_admin()) or (select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))));
create policy consent_templates_add on public.consent_templates for insert to authenticated
with check ((select private.is_active_user()) and (select private.is_admin()));
create policy consent_templates_edit on public.consent_templates for update to authenticated
using ((select private.is_active_user()) and (select private.is_admin()))
with check ((select private.is_active_user()) and (select private.is_admin()));
create policy patient_consents_read on public.patient_consents for select to authenticated
using (((select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))) and exists (select 1 from public.patients p where p.id=patient_id));
create policy patient_consents_add on public.patient_consents for insert to authenticated
with check (((select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))) and created_by=(select auth.uid()) and exists (select 1 from public.patients p where p.id=patient_id));
create policy patient_consents_edit on public.patient_consents for update to authenticated
using (((select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))) and exists (select 1 from public.patients p where p.id=patient_id))
with check (((select private.has_page_permission('patients')) or (select private.has_page_permission('chart'))) and exists (select 1 from public.patients p where p.id=patient_id));

create function private.guard_consent_template() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then new.revision:=1; new.created_at:=now();
  else
    if new.id<>old.id then raise exception 'Template identity cannot change'; end if;
    new.created_at:=old.created_at; new.revision:=old.revision+1;
  end if;
  new.updated_at:=now(); return new;
end;
$$;
create trigger guard_consent_template before insert or update on public.consent_templates for each row execute function private.guard_consent_template();

-- A narrow lookup is needed because staff cannot read other user profiles.
-- Keep the privileged lookup outside exposed schemas and verify live permissions.
create function private.consent_doctors() returns table(user_id uuid,full_name text)
language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.is_active_user() or not (private.has_page_permission('patients') or private.has_page_permission('chart'))
  then raise exception 'Patient access required' using errcode='42501'; end if;
  return query select p.user_id,p.full_name from public.user_profiles p where p.active and p.is_doctor order by p.full_name;
end;
$$;
revoke all on function private.consent_doctors() from public,anon,authenticated;
grant execute on function private.consent_doctors() to authenticated;
create function public.list_consent_doctors() returns table(user_id uuid,full_name text)
language sql stable security invoker set search_path='' as $$ select * from private.consent_doctors(); $$;
revoke all on function public.list_consent_doctors() from public,anon,authenticated;
grant execute on function public.list_consent_doctors() to authenticated;

create function private.guard_patient_consent() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_template public.consent_templates; v_patient public.patients;
begin
  if tg_op='UPDATE' then
    if old.status='finalized' then raise exception 'Finalized consents are immutable'; end if;
    if (new.id,new.patient_id,new.template_id,new.template_revision,new.patient_data,new.created_by,new.created_at,new.language,new.finding_ids,new.procedure_code)
       is distinct from (old.id,old.patient_id,old.template_id,old.template_revision,old.patient_data,old.created_by,old.created_at,old.language,old.finding_ids,old.procedure_code)
    then raise exception 'Consent identity and template snapshot cannot change'; end if;
    new.revision:=old.revision+1;
  else
    select * into v_template from public.consent_templates where id=new.template_id;
    if not found or not v_template.active then raise exception 'Choose an active consent template'; end if;
    if new.template_revision<>v_template.revision then raise exception 'Template changed; reopen the form'; end if;
    select * into strict v_patient from public.patients where id=new.patient_id;
    new.patient_data:=jsonb_build_object('name',v_patient.name,'number',coalesce(v_patient.patient_number::text,''),'birth_date',coalesce(v_patient.birth_date::text,''),'phone',coalesce(v_patient.phone,''),'address',coalesce(v_patient.address,''),'age',v_patient.age,'gender',coalesce(v_patient.gender,''));
    new.created_by:=auth.uid(); new.created_at:=now(); new.revision:=1;
  end if;
  if new.doctor_id is not null and not exists (select 1 from private.consent_doctors() p where p.user_id=new.doctor_id)
  then raise exception 'Choose an active treating doctor'; end if;
  new.updated_at:=now();
  new.finalized_at:=case when new.status='finalized' then now() else null end;
  return new;
end;
$$;
create trigger guard_patient_consent before insert or update on public.patient_consents for each row execute function private.guard_patient_consent();
revoke all on function private.guard_consent_template(),private.guard_patient_consent() from public,anon,authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.consent_templates,public.patient_consents;
  end if;
end $$;

-- Original bilingual starter forms; categories reference Dentolize’s public generator.
insert into public.consent_templates(title_en,title_ar,body_en,body_ar,source_url) values
('Dental implants','زراعة الأسنان','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
A titanium or ceramic implant is placed in the jaw to support replacement teeth. Imaging, healing, temporary teeth, bone augmentation and the final restoration may involve separate stages.

Risks
Possible complications include bleeding, infection, pain, delayed healing, failure to integrate, later bone loss, gum recession and damage to nearby structures. Nerve injury can alter sensation temporarily or permanently; upper-jaw surgery can affect the sinus. Further surgery or implant removal may be needed. Smoking and some health conditions increase risk.

Choices
A bridge, removable denture or leaving the space may be suitable. Leaving a space can affect chewing and tooth position.

My responsibilities
I will follow wound-care instructions, attend reviews and maintain long-term implant cleaning. The restoration can need repairs or replacement.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
توضع غرسة من التيتانيوم أو السيراميك في عظم الفك لدعم أسنان بديلة. قد تتطلب الأشعة والالتئام والأسنان المؤقتة وتطعيم العظم والتركيبة النهائية مراحل منفصلة.

المخاطر
تشمل المضاعفات المحتملة النزيف والعدوى والألم وتأخر الالتئام وعدم اندماج الغرسة وفقد العظم لاحقاً وانحسار اللثة وإصابة الأنسجة المجاورة. قد تسبب إصابة العصب تغيراً مؤقتاً أو دائماً في الإحساس، وقد تؤثر جراحة الفك العلوي في الجيب الأنفي. قد تلزم جراحة إضافية أو إزالة الغرسة. يزيد التدخين وبعض الأمراض من المخاطر.

البدائل
قد يناسبني جسر أو طقم متحرك أو ترك الفراغ. وقد يؤثر ترك الفراغ في المضغ وموضع الأسنان.

مسؤولياتي
سألتزم بتعليمات العناية بالجرح والمراجعات وتنظيف الزرعات على المدى الطويل. قد تحتاج التركيبة إلى إصلاح أو استبدال.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Fixed orthodontic treatment','تقويم الأسنان الثابت','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
Brackets, wires and sometimes additional appliances gradually change tooth position and bite. Extractions, interproximal reduction or surgery require a separate discussion where indicated.

Risks
Discomfort, ulcers, broken appliances, decay, permanent enamel marks, gum inflammation or recession and root shortening can occur. Rarely, teeth can lose vitality or supporting tissues can deteriorate. Jaw symptoms can continue independently of treatment. Progress and duration depend on growth, biology, attendance and cooperation; the planned result may not be fully achievable.

Choices
Depending on the diagnosis, choices include aligners, a limited correction, surgery or observation. Without treatment, the existing alignment or bite may persist or change.

My responsibilities
I will clean around appliances, avoid damaging foods, attend adjustments and report breakages. Retainers and follow-up are needed after treatment because teeth can move again. Fees, missed visits and early discontinuation must be agreed separately.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
تحرك الحاصرات والأسلاك وأحياناً أجهزة إضافية الأسنان تدريجياً لتحسين الاصطفاف والإطباق. يتطلب الخلع أو برد ما بين الأسنان أو الجراحة مناقشة منفصلة عند الحاجة.

المخاطر
قد يحدث ألم وتقرحات وكسر بالأجهزة وتسوس وبقع دائمة بالمينا والتهاب أو انحسار اللثة وقصر الجذور. نادراً قد تفقد الأسنان حيويتها أو تتضرر الأنسجة الداعمة. قد تستمر أعراض مفصل الفك مستقلة عن العلاج. تعتمد النتيجة والمدة على النمو والاستجابة الحيوية والانتظام والتعاون، وقد لا تتحقق النتيجة المخططة بالكامل.

البدائل
بحسب التشخيص قد تشمل البدائل التقويم الشفاف أو التصحيح المحدود أو الجراحة أو المتابعة دون علاج. قد يستمر وضع الأسنان والإطباق الحالي أو يتغير دون علاج.

مسؤولياتي
سأنظف حول الأجهزة وأتجنب الأطعمة الضارة بها وأحضر جلسات الضبط وأبلغ عن الكسور. يلزم استخدام المثبت والمتابعة بعد العلاج لاحتمال تحرك الأسنان مجدداً. يجب الاتفاق على الرسوم والغياب والتوقف المبكر بصورة منفصلة.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Clear aligner treatment','التقويم الشفاف','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
A sequence of removable aligners moves teeth. Attachments, elastics, enamel reduction, refinement scans or additional appliances may be proposed and explained individually.

Risks
Soreness, speech changes, irritation, decay, gum problems and root shortening are possible. Aligners may be lost or damaged, and some movements may not track as planned. Extra aligners or another method can be required.

Choices
Fixed appliances, a limited correction or no active treatment may be options. Existing alignment and bite problems can remain without treatment.

My responsibilities
I will wear and change aligners as instructed, remove them for eating, keep teeth and aligners clean and attend reviews. Poor wear can extend treatment or prevent the intended result. Retainers are required afterwards to reduce relapse. Replacement and refinement costs should be agreed before starting.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
تحرك مجموعة متتابعة من القوالب المتحركة الأسنان. قد يقترح الطبيب نتوءات أو مطاطات أو برداً محدوداً للمينا أو مسحاً إضافياً أو أجهزة مساعدة ويشرحها بحسب الحالة.

المخاطر
قد يحدث ألم وتغير بالكلام وتهيج وتسوس ومشكلات باللثة وقصر بالجذور. قد تفقد القوالب أو تتلف وقد لا تتحرك بعض الأسنان كما خُطط. قد تلزم قوالب إضافية أو طريقة علاج أخرى.

البدائل
قد تشمل الخيارات الأجهزة الثابتة أو التصحيح المحدود أو عدم العلاج. قد تستمر مشكلات الاصطفاف والإطباق دون علاج.

مسؤولياتي
سأرتدي القوالب وأغيرها وفق التعليمات وأزيلها للطعام وأحافظ على نظافتها ونظافة الأسنان وأحضر المراجعات. عدم الالتزام قد يطيل العلاج أو يمنع النتيجة المطلوبة. تلزم مثبتات بعده لتقليل الانتكاس. يجب الاتفاق على تكلفة الاستبدال والمراحل الإضافية قبل البدء.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Surgical tooth extraction','الخلع الجراحي للأسنان','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
Removal of the specified tooth may require an incision, removal of surrounding bone, division of the tooth and stitches to manage pain, infection or another diagnosed problem.

Risks
Pain, bleeding, swelling, bruising, restricted opening, dry socket and infection can occur. Adjacent teeth or restorations may be damaged. A root fragment may remain or require further surgery. Nerve damage may cause lasting altered feeling in the tongue, lip or chin. Upper teeth may communicate with the sinus; rarely, a jaw fracture can occur.

Choices
Depending on the tooth, restoration, root canal treatment, specialist referral or observation may be possible. Delaying care can allow pain or infection to worsen.

My responsibilities
I will follow the clinic’s bleeding-control, hygiene, diet and smoking advice and attend follow-up. I will seek prompt help for persistent bleeding, spreading swelling, fever or difficulty breathing or swallowing.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
قد يتطلب خلع السن المحدد شقاً باللثة وإزالة عظم محيط وتقسيم السن وغرزاً لعلاج الألم أو العدوى أو مشكلة أخرى مشخصة.

المخاطر
قد يحدث ألم ونزيف وتورم وكدمات ومحدودية فتح الفم والتهاب السنخ وعدوى. قد تتضرر الأسنان المجاورة أو ترميماتها. قد يبقى جزء من الجذر أو يحتاج إلى جراحة إضافية. قد تسبب إصابة العصب تغيراً مستمراً في إحساس اللسان أو الشفة أو الذقن. قد يحدث اتصال بالجيب الأنفي مع الأسنان العلوية ونادراً كسر بالفك.

البدائل
قد يمكن ترميم السن أو علاج جذوره أو الإحالة إلى متخصص أو المتابعة بحسب حالته. قد يؤدي التأخير إلى زيادة الألم أو العدوى.

مسؤولياتي
سأتبع تعليمات العيادة للتحكم بالنزيف والنظافة والطعام والتدخين وأحضر المتابعة. سأطلب المساعدة فوراً عند استمرار النزيف أو انتشار التورم أو الحمى أو صعوبة التنفس أو البلع.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Root canal treatment','علاج جذور الأسنان','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
The tooth’s internal canals are cleaned, disinfected and sealed to retain a tooth with inflamed or infected pulp. Several visits and a final protective restoration may be required.

Risks
Pain, swelling, persistent infection, missed canals, instrument separation, perforation, damage to surrounding tissues and tooth fracture are possible. Healing is uncertain and retreatment, surgery or extraction may still be necessary.

Choices
Extraction and replacement, specialist care or no treatment may be considered. Untreated infection can worsen or spread.

My responsibilities
I will return to complete treatment and arrange the definitive filling or crown promptly. I understand that a temporary filling provides limited protection and that the tooth can fracture or become infected again.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
تُنظف القنوات الداخلية وتُعقم وتُحشى للمحافظة على سن يعاني التهاباً أو عدوى باللب. قد تلزم عدة زيارات وتركيبة أو ترميم نهائي واقٍ.

المخاطر
قد يحدث ألم وتورم وعدوى مستمرة وقنوات غير مكتشفة وانفصال أداة وثقب وإصابة الأنسجة المحيطة وكسر بالسن. لا يمكن ضمان الالتئام وقد يلزم إعادة العلاج أو جراحة أو خلع.

البدائل
يمكن بحث الخلع والتعويض أو العلاج لدى متخصص أو عدم العلاج. قد تتفاقم العدوى أو تنتشر دون علاج.

مسؤولياتي
سأعود لإتمام العلاج وأرتب الحشو أو التاج النهائي سريعاً. أدرك أن الحشو المؤقت يوفر حماية محدودة وأن السن قد ينكسر أو يصاب بالعدوى مجدداً.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Crowns and bridges','التيجان والجسور','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
Teeth are shaped to receive a crown or support a bridge. Impressions or scans, temporary restorations and laboratory stages may be needed to restore function or appearance.

Risks
Sensitivity, pulp injury requiring root canal treatment, fracture, decay at margins, gum changes and loss of retention may occur. Appearance and bite may need adjustment; restorations can wear, chip or need replacement. Tooth preparation is irreversible.

Choices
A direct filling, onlay, removable replacement, implant or no treatment may be considered where suitable. Without protection a weakened tooth can deteriorate.

My responsibilities
I will clean around and beneath restorations, attend reviews and report looseness or persistent pain. Material, shade, limitations, maintenance and fees will be agreed before completion.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
تُحضّر الأسنان لاستقبال تاج أو دعم جسر. قد تلزم طبعات أو مسح وتركيبات مؤقتة ومراحل معملية لاستعادة الوظيفة أو المظهر.

المخاطر
قد تحدث حساسية وإصابة باللب تحتاج علاج جذور وكسر وتسوس عند الحواف وتغيرات باللثة وفقد ثبات التركيبة. قد يلزم ضبط الشكل والإطباق وقد تتآكل التركيبات أو تتشقق أو تحتاج للاستبدال. تحضير الأسنان غير قابل للعكس.

البدائل
يمكن بحث الحشو المباشر أو الترميم الجزئي أو التعويض المتحرك أو الزرع أو عدم العلاج عند ملاءمتها. قد يتدهور السن الضعيف دون حماية.

مسؤولياتي
سأنظف حول التركيبات وتحتها وأحضر المراجعات وأبلغ عن الحركة أو الألم المستمر. سيتم الاتفاق على المادة واللون والحدود والعناية والرسوم قبل الإتمام.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/'),
('Tooth whitening','تبييض الأسنان','Patient: {{patient_name}}
File: {{patient_number}} · Date of birth: {{birth_date}}
Phone: {{phone}}
Treating doctor: {{doctor_name}} · Date: {{date}}
Procedure / teeth: {{procedure}}

Treatment and purpose
A supervised whitening product is used to lighten natural teeth. The response varies and fillings, veneers and crowns will not change colour.

Risks and limits
Temporary sensitivity and gum irritation may occur. Uneven results, limited improvement and later colour relapse are possible; existing restorations may need replacement to match. Treatment may need to stop if symptoms develop.

Choices
Cleaning alone, restorative options or keeping the present shade can be considered. Discolouration itself may remain without whitening.

My responsibilities
I will use only the instructed amount and schedule, report significant sensitivity and avoid swallowing the product. I understand the agreed target shade and any future maintenance or restoration costs.

Discussion and agreement
I have supplied my health history, allergies and current medication list. My clinician has discussed my individual risks, the proposed fees and any additional stages or costs. I can ask for clarification or another opinion and may withdraw consent before treatment. Results and completion dates cannot be guaranteed. I have had time to consider the information and my questions have been addressed. I agree to the treatment described in this form.

Individual risks, treatment details, fees and arrangements:
{{details}}','المريض: {{patient_name}}
رقم الملف: {{patient_number}} · تاريخ الميلاد: {{birth_date}}
الهاتف: {{phone}}
الطبيب المعالج: {{doctor_name}} · التاريخ: {{date}}
الإجراء / الأسنان: {{procedure}}

العلاج والغرض
تُستخدم مادة تبييض تحت إشراف الطبيب لتفتيح الأسنان الطبيعية. تختلف الاستجابة ولا يتغير لون الحشوات أو القشور أو التيجان.

المخاطر والحدود
قد تحدث حساسية مؤقتة وتهيج باللثة. قد تكون النتيجة غير متجانسة أو محدودة وقد يعود اللون لاحقاً؛ وقد تحتاج التركيبات الحالية إلى الاستبدال لتوافق اللون. قد يلزم إيقاف العلاج عند ظهور أعراض.

البدائل
يمكن بحث التنظيف فقط أو خيارات ترميمية أو الاحتفاظ باللون الحالي. قد يبقى التصبغ دون تبييض.

مسؤولياتي
سألتزم بالكمية والجدول المحددين وأبلغ عن الحساسية الشديدة وأتجنب ابتلاع المادة. أفهم اللون المستهدف المتفق عليه وتكاليف العناية المستقبلية أو استبدال التركيبات.

المناقشة والموافقة
قدمت تاريخي الصحي والحساسية وقائمة الأدوية الحالية. ناقش معي الطبيب المخاطر الخاصة بحالتي والرسوم المقترحة وأي مراحل أو تكاليف إضافية. يمكنني طلب التوضيح أو رأي آخر والتراجع عن الموافقة قبل العلاج. لا يمكن ضمان النتائج أو موعد انتهاء العلاج. أتيحت لي فرصة كافية للتفكير وتمت الإجابة عن أسئلتي. أوافق على العلاج الموضح في هذا النموذج.

المخاطر الفردية وتفاصيل العلاج والرسوم والترتيبات:
{{details}}','https://dentolize.com/tools/dental-consent-form-generator/');
