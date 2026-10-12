import {assert} from "./test_helpers.ts";
import {fixture, DOCTOR, PID} from "./test_fixture.ts";
import {createHandler} from "./index.ts";
import {driveThumbnailUrl} from "./store.ts";

Deno.test("Drive previews request 80 pixels without enlarging small previews or changing signed query values", () => {
  assert(driveThumbnailUrl("https://lh3.googleusercontent.com/preview=s220?token=private")?.href === "https://lh3.googleusercontent.com/preview=s80?token=private");
  assert(driveThumbnailUrl("https://lh4.googleusercontent.com/preview=s64")?.pathname.endsWith("=s64"));
  assert(driveThumbnailUrl("https://lh3.googleusercontent.com/preview=s0")?.pathname.endsWith("=s80"));
  assert(driveThumbnailUrl("https://lh3.googleusercontent.com/preview?sz=s800&s=signed")?.searchParams.get("sz") === "s80");
  assert(driveThumbnailUrl("https://lh3.googleusercontent.com/preview?sz=s800&s=signed")?.searchParams.get("s") === "signed");
  for (const link of ["invalid", "http://lh3.googleusercontent.com/p=s220", "https://googleusercontent.com.evil.test/p=s220", "https://user:pass@lh3.googleusercontent.com/p=s220"]) assert(driveThumbnailUrl(link) === null);
});

Deno.test("gallery previews remain small and authenticated; originals are requested only through the original route", async () => {
  const f = await fixture(), uploaded = await f.upload(), row = f.db.tables.google_drive_files[0];
  f.google.files.get(row.drive_id).thumbnailLink = "https://lh3.googleusercontent.com/preview=s220";
  const previews: string[] = []; let originals = 0;
  const handler = createHandler(f.config, f.db, async (url, options) => {
    if (String(url).includes("googleusercontent.com")) {
      assert(new Headers(options?.headers).get("Authorization")?.startsWith("Bearer "));
      previews.push(String(url));
      return new Response("small-preview", {headers: {"Content-Type": "image/webp"}});
    }
    if (String(url).includes("alt=media")) originals++;
    return f.google.fetch(url, options);
  });
  const request = (route: string) => handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/" + route + uploaded.relativePath, {headers: {Authorization: "Bearer doctor"}}));
  const preview = await request("api/thumbnail/");
  assert(await preview.text() === "small-preview" && preview.headers.get("Cache-Control") === "private, no-store");
  assert(previews[0].endsWith("=s80") && Number(originals) === 0);
  delete f.google.files.get(row.drive_id).thumbnailLink;
  assert((await request("api/thumbnail/")).status === 404 && Number(originals) === 0);
  assert(await (await request("files/")).text() === "xray" && Number(originals) === 1);
  f.db.tables.user_profiles.find(row => row.user_id === DOCTOR).active = false;
  assert((await request("api/thumbnail/")).status === 403);
});

Deno.test("tooth index contains live X-ray counts only and performs no Google image or token requests", async () => {
  const f = await fixture(), uploaded = await f.upload();
  await f.request(`/api/patient/${PID}/media-details`, "doctor", {relativePath: uploaded.relativePath, details: {tooth_ids: ["3", "A"]}});
  let googleCalls = 0;
  const handler = createHandler(f.config, f.db, async (url, options) => { googleCalls++; return f.google.fetch(url, options); });
  const request = () => handler(new Request(f.config.supabaseUrl + "/functions/v1/google-drive/api/xray-index", {headers: {Authorization: "Bearer doctor"}}));
  const response = await request(), data = await response.json();
  assert(data.countsByPatient[PID]["3"] === 1 && data.countsByPatient[PID].A === 1 && Number(googleCalls) === 0);
  assert(!JSON.stringify(data).includes(uploaded.relativePath));
  f.db.tables.google_drive_files[0].record.deleted = true;
  assert(Object.keys((await (await request()).json()).countsByPatient).length === 0);
  f.db.tables.user_profiles.find(row => row.user_id === DOCTOR).active = false;
  assert((await request()).status === 403 && Number(googleCalls) === 0);
});
