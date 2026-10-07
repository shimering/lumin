# Lumin Storage Setup — Windows

For Windows 10/11 on a 64-bit Intel or AMD computer.

This is the familiar Lumin Storage Setup launcher rebuilt for the current
rolled-back server. Its bundled API and sync engine come directly from
`storage-server`, rather than the separate Server Station copy. The current
defaults are port **5000**, a **50 MB** upload limit, and the current server's
image/document extensions. Original 3D scan ZIP uploads and sync are supported
by the server even when ZIP is absent from the extension list. Set a larger
upload limit in the setup app if your clinic needs larger archives.

Copy **LuminStorageSetup.zip** to the other computer and extract it into a new
folder. Double-click **LuminStorageSetup.exe**. Python is included; no Python
installation or terminal commands are needed.

1. Stop the old storage server on that computer. This app uses the selected port and
   tells you if the old server is still running; it never stops another app.
2. If this PC already has a storage server, click **Load existing server settings**
   and select its `config.json`. This loads its folder, clinic key, port, upload
   limit and allowed file extensions. Pairing state is kept private to each PC.
   Otherwise choose the existing **Patients** folder containing the patient subfolders.
   Do not select the old server program folder or an individual patient.
3. Enter the clinic key saved for that server in **Lumin Admin → Storage Server**.
4. Click **Start server**. Keep the app running while using the server; it can run quietly in the tray.
5. For access from the web app and other computers, use **Enable remote access**.
   Tailscale must already be installed and signed in on this computer. This
   button sets up its HTTPS Funnel and verifies public browser access. It
   preserves an existing HTTPS configuration if it serves another application.
   If Tailscale is missing, use the [official Windows download](https://tailscale.com/download/windows).
6. **Copy address**, then **Open Lumin Admin**. Add or edit this computer's saved
   server using that HTTPS address and the same clinic key. If this computer
   already had a saved HTTPS address, its Tailscale address stays the same.
7. Sign in as a Lumin administrator and save this PC as the dedicated server.
   Select it as active storage for the clinic. To synchronize with a laptop,
   select the dedicated PC as coordinator and the laptop as peer, then click
   **Pair servers** and **Sync now**. Both PCs must be running compatible servers.

If one computer has been reinstalled and the previous pairing no longer matches,
click **Update pairing** to reconnect the selected PCs. This requires an active
Lumin administrator on both servers, waits for running sync jobs, and preserves
stored files, revision history and annotations. An incorrect saved clinic key
is reported separately from an expired administrator session.

## Reviewing image differences and deletions

Update this setup app on **both computers** before using the new review choices.
In Lumin Admin, open **Review** next to a sync difference. For two images, select
**Keep this version on both** below the image you want, then **Save choice on both
servers**. Its notes, tooth assignments and scan settings accompany it; the other
version and its unchanged conflict copies move into the private recovery archive.
You can also keep both versions on both computers.
Keep-one choices also work for filename capitalization differences, preserving
the existing filename spelling on each computer. The comparison shows these
choices above each preview. If an older app is responding, the choices remain
visible but disabled and an update notice explains how to enable them.

If one image was deleted, choose **Restore this copy on both** or **Delete on both
servers**, then save the choice. Deletions wait for review, including an old path
after a category move. New files are copied normally. A disconnected save keeps
the chosen action: reload its review and click **Resume saving** before starting
another sync. Files and previous annotations remain recoverable in the archive.

## Automatic startup

Turn on **Start with Windows and connect automatically** after choosing the
patient folder and entering the clinic key. The app saves those settings, starts
the server, and enables remote access. At each Windows sign-in it opens minimized,
starts the server and reconnects through Tailscale automatically. If the internet
or Tailscale is still starting, remote access retries automatically.

Tailscale must be installed, signed in, and allowed to run at startup. Windows
sign-in is required; the app does not run before anyone signs in. Turn the startup
toggle off to remove its automatic startup registration.

## Silent operation and system tray

Tailscale checks run without opening command windows. The server and remote
access helpers are also hidden; their diagnostic output remains in local logs.

Turn on **Minimize to tray** to hide the setup window immediately. The preference
is saved for this computer. Minimizing or closing the window then keeps storage
running in the Windows notification area. Double-click the tray icon, or choose
**Open Lumin Storage Setup**, to reopen it. Choose **Quit and stop server** to
exit completely. Turning the toggle off restores normal taskbar behavior.

With both startup and tray enabled, Windows sign-in starts storage in the tray.
Without tray enabled, it starts minimized on the taskbar; closing the window
stops this session. **Stop server** always stops the server. Automatic startup
starts it again at the next sign-in.

Enabling startup installs a copy of the EXE inside this computer's private
AppData folder, so moving the extracted ZIP folder does not break startup.
To update, close the existing app and open the newer EXE. Your saved folder,
clinic key, sync identity, and startup preference are retained, and the startup
copy updates to the new version.

The local `http://localhost:5000` address is for this computer only. Use the
verified HTTPS address in the hosted web app.

The port and upload limit can be changed before starting. Remote access follows
the selected port. Storage folder changes made in Lumin Admin are saved by the
server and retained when this setup app is stopped and restarted.

Sync transfers patient images, documents, and original 3D scan ZIP files in both
directions. With the default extensions, generated JSON/SQL and mapping databases are excluded.
Importing an existing custom extension list retains its patient file types;
generated JSON/SQL metadata and mapping databases remain excluded from sync.
Removed or replaced files are kept in the sync recovery archive. A fresh server
starts with no deletion history and preserves conflicting files during pairing.
The existing Lumin administrator authentication is required for pairing/sync.

## Interrupted sync and files needing review

Update both computers with this EXE (or the current storage server update ZIP),
then restart both servers. Saved settings and identities are retained. In Lumin
Admin, **Retry** skips already verified transfers. The updated engine retains
revision history left by earlier installations instead of rejecting its merge
with HTTP 400, and reports specific safe errors for incompatible transfers.

Use **Review** beside a conflict to compare the original copies. Image previews
load independently; ZIPs and documents have **Download original**. **Keep both
and mark reviewed** preserves both versions on both computers. If an original
changes during review, reload the comparison before saving. For a failed job,
reviewing files does not finish the remaining transfers; click **Retry** afterward.

The web app must also include the updated `lumin-storage-sync.js` and CSS for
review buttons to appear. `/api/health` on an updated server includes
`syncConflictReview: true`, `syncHistoricalRevisions: true`, and
`syncClinicalMetadata: true` in `capabilities`.

Each Windows computer stores its configuration, logs and sync identity under
`%LOCALAPPDATA%\LuminStorageSetup\<computer-id>`. **Only copy this release folder
to another computer. Do not copy AppData or the old `.lumin-sync` directory.**
Selecting an existing patient folder does not move or rename the patient files.
Reopening the app on the same computer preserves its identity and settings.

If the server cannot start, click **View log**. If port 5000 is busy, close the old
server first. If Windows asks for network access, allow the app on the clinic's
private network when LAN access is needed. You can close this app to stop its
server. With the startup toggle enabled, it starts automatically when you sign in.

## إعداد سريع بالعربية

انسخ ملف ZIP إلى الكمبيوتر الآخر وفكّه في مجلد جديد، ثم افتح
`LuminStorageSetup.exe`. لا تحتاج إلى تثبيت Python أو استخدام الأوامر.

1. أوقف خادم التخزين القديم على هذا الكمبيوتر.
2. إذا كان الخادم موجودًا بالفعل، اضغط **تحميل إعدادات الخادم الموجود** واختر
   ملف `config.json` لتحميل المجلد والمفتاح والمنفذ وحد الرفع. أو اختر مجلد
   `Patients` الذي يحتوي على مجلدات المرضى.
3. أدخل مفتاح العيادة المحفوظ لهذا الخادم في إدارة Lumin.
4. اضغط **تشغيل الخادم** واترك التطبيق مفتوحًا.
5. ثبّت Tailscale وسجّل الدخول إذا لزم الأمر، ثم اضغط **تفعيل الوصول عن بُعد**.
6. انسخ عنوان HTTPS واحفظه مع مفتاح العيادة في إعدادات الخادم في Lumin.
7. سجّل الدخول كمسؤول، واختر الكمبيوتر الرئيسي واللابتوب، ثم اربط الخادمين
   وابدأ المزامنة.

الإعدادات الافتراضية الحالية هي المنفذ **5000** وحد الرفع **50 ميجابايت**.
يمكن تغييرهما قبل تشغيل الخادم. احفظ الكمبيوتر الرئيسي كخادم التخزين النشط
للعيادة، واستخدم عنوان HTTPS للوصول من تطبيق Lumin على الأجهزة الأخرى.

لحل انقطاع المزامنة وخطأ HTTP 400، حدّث تطبيق الخادم على الجهازين ثم أعد
تشغيلهما واضغط **إعادة المحاولة**. اضغط **مراجعة** لمقارنة الملف على الجهازين،
أو **تنزيل الأصل** لملفات ZIP والمستندات. **حفظ النسختين واعتماد المراجعة**
يحفظ النسختين دون استبدال الأصلين. يجب تحديث واجهة Lumin أيضًا لإظهار الأزرار.

فعّل **التشغيل مع Windows والاتصال تلقائيًا** لحفظ الإعدادات وتشغيل الخادم
والوصول عن بُعد تلقائيًا. بعد تسجيل الدخول إلى Windows يفتح التطبيق مصغّرًا
ويتصل عبر Tailscale، ويعيد المحاولة إذا لم يبدأ الإنترنت أو Tailscale بعد.
يجب تثبيت Tailscale وتسجيل الدخول فيه وتفعيل تشغيله مع Windows. صغّر التطبيق
لإبقاء الخادم يعمل؛ إغلاقه يوقف جلسة الخادم الحالية. لتعطيل التشغيل التلقائي،
أوقف المفتاح. للتحديث، أغلق التطبيق القديم ثم افتح ملف EXE الجديد؛ تبقى
إعدادات المجلد والمفتاح وهوية المزامنة محفوظة.

لكل كمبيوتر هوية مستقلة. انسخ مجلد الإصدار فقط، ولا تنسخ مجلد `.lumin-sync`
القديم أو بيانات AppData. تتم مزامنة الصور والمستندات وملفات ZIP للمسح ثلاثي
الأبعاد؛ ولا تتم مزامنة قواعد بيانات الربط أو ملفات JSON/SQL المولدة.

## Patient and tooth details

The dental chart, photo gallery and 3D scan gallery read and save annotations
**on the selected local storage server**. Existing `patient_media_details.json`
files are imported into local SQLite; per-patient JSON backups are updated
atomically. Patient IDs and numbers, Lumin tooth IDs 1–32 and A–T, labels, notes,
scan dates and scan settings stay local. Supabase media records are never read
or written by these workflows.

Sync shares the local metadata between both PCs alongside their files. Edits
from either PC propagate. Simultaneous edits are available in Review, where
**Keep both and mark reviewed** saves a copy with each version's annotations on
both PCs. Supabase still handles the existing administrator authentication and
server settings. Install this EXE on both computers and update the Lumin web
interface. No Supabase migration is needed.

يستخدم مخطط الأسنان ومعرض الصور ومعرض المسح ثلاثي الأبعاد بيانات الخادم
المحلي المحدد للقراءة والحفظ. تُستورد ملفات `patient_media_details.json`
الموجودة وتُحفظ نسخة محلية لكل مريض. تشمل البيانات معرّف المريض ورقمه،
والأسنان المحددة، واسم الملف وملاحظاته وإعدادات المسح. لا تعتمد هذه البيانات
على سجلات الوسائط في Supabase. تُزامن البيانات المحلية بين الجهازين؛ وعند
تعديلها على الجهازين تُحفظ النسختان للمراجعة. حدّث ملف EXE على الجهازين
وواجهة Lumin. لا يلزم تعديل قاعدة بيانات Supabase.

## Developer build

Use Python with `pyinstaller`, `customtkinter`, and the packages in
`storage-server/requirements.txt`. Run `python lumin-server-setup/build_exe.py`.
The build uses the current `storage-server/server.py`, `file_sync.py`, `clinical_metadata.py`, and
`tailscale_access.py`; no real config, patient files, or identity is included.
It copies only port, upload limit and allowed extensions into a safe defaults
resource, verifies the packaged server and English/Arabic UI, and then creates
the ZIP. `release/build-info.json` records the current revision, source hashes
and executable hash so compatibility can be checked after another rollback.

To test the actual packaged server without touching clinic data:
`LuminStorageSetup.exe --self-test-output <absolute-path-to-result.json>`.
It uses disposable files and an automatically allocated port.
