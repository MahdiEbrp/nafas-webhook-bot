# فهرست امکانات ربات وب‌هوک کلینیک

این فایل به‌طور خودکار از `lib/features/manifest.ts` ساخته می‌شود. دستی ویرایش نکنید.

تعداد بخش‌ها: **11** — بخش‌های آماده: **10** — مجموع اکشن‌ها: **49**

## خلاصه

| بخش | نام فارسی | اکشن‌ها | آماده؟ |
| --- | --- | --- | --- |
| `bookings` | نوبت‌ها و رزروها | 5 | ✅ |
| `working-hours` | ساعت‌های کاری | 5 | ✅ |
| `services` | خدمات کلینیک | 5 | ✅ |
| `service-categories` | دسته‌بندی خدمات | 5 | ✅ |
| `service-groups` | گروه‌های خدمات | 5 | ✅ |
| `users` | کاربران و کارمندان | 4 | ✅ |
| `settings` | تنظیمات سایت | 5 | ✅ |
| `rules` | قوانین کلینیک | 5 | ✅ |
| `care-guides` | راهنمای مراقبت | 5 | ✅ |
| `care-guide-items` | آیتم‌های راهنمای مراقبت | 5 | ✅ |
| `sms` | پیامک | 0 | ❌ |

## نوبت‌ها و رزروها (`bookings`)

> نوبت‌ها همان «قراری» هستند که مشتری با کلینیک می‌گذارد. مثل این است که روی تقویم بنویسی: «فلانی ساعت ۵ می‌آید». این بخش می‌تواند لیست قرارها را ببیند، قرار تازه بسازد، یک قرار را عوض کند یا پاک کند.

**مثال‌هایی از حرف کاربر:** «نوبت‌های امروز رو نشون بده» • «یک نوبت جدید برای مریم با شماره ۰۹۱۲... ثبت کن» • «نوبت فلانی رو کنسل کن» • «چند نوبت پرداخت‌نشده داریم؟»

**کلمه‌های کلیدی:** نوبت، نوبتها، نوبت‌ها، رزرو، قرار، وقت، کنسل، لغو، بیعانه، booking، bookings، appointment، appointments، reservation

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `bookings.list` | `GET /api/v1/webhooks/bookings` | `appointments.read` | خواندن — بی‌خطر | نه | دیدن لیست نوبت‌ها (با صفحه‌بندی، جستجو و فیلتر وضعیت) |
| `bookings.get` | `GET /api/v1/webhooks/bookings/:id` | `appointments.read` | خواندن — بی‌خطر | نه | دیدن جزئیات یک نوبت |
| `bookings.create` | `POST /api/v1/webhooks/bookings` | `appointments.write` | تغییر دادن — نیاز به تأیید | بله | ساختن نوبت جدید |
| `bookings.update` | `PATCH /api/v1/webhooks/bookings/:id` | `appointments.write` | تغییر دادن — نیاز به تأیید | بله | تغییر نام/تلفن/یادداشت/وضعیت یک نوبت |
| `bookings.delete` | `DELETE /api/v1/webhooks/bookings/:id` | `appointments.manage` | حذف کردن — خطرناک | بله | پاک کردن کامل یک نوبت |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `bookings.list`: `page`، `perPage`، `search`، `status`، `slotId`
- `bookings.get`: `id`
- `bookings.create`: `fullName`، `phone`، `email`، `locale`، `notes`، `consultationRequired`، `hasAllergies`، `isPregnant`، `termsAccepted`، `items[].groupId`، `items[].slotId`، `items[].quantity`
- `bookings.update`: `id`، `fullName`، `phone`، `email`، `notes`، `status`
- `bookings.delete`: `id`

**نکته:** وضعیت‌های مجاز: pending | paid | waiting | done | refunded

## ساعت‌های کاری (`working-hours`)

> این بخش دفترچهٔ ساعت‌های کاری کلینیک است: از چه ساعتی باز است، تا چه ساعتی، و در هر ساعت چند نفر جا داریم. مثل زنگ‌های مدرسه که معلوم می‌کند کلاس‌ها کِی شروع می‌شوند.

**مثال‌هایی از حرف کاربر:** «ساعت کاری شنبه‌ها چیه؟» • «شنبه‌ها رو از ۹ صبح تا ۶ عصر کن» • «ظرفیت ساعت ۱۰ رو بیشتر کن»

**کلمه‌های کلیدی:** ساعت کاری، ساعات کاری، ساعت‌های کاری، شیفت، باز، بسته، ظرفیت، تعطیل، working hours، shift، capacity، open، close

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `working-hours.list` | `GET /api/v1/webhooks/working-hours` | `appointments.read` | خواندن — بی‌خطر | نه | دیدن لیست ساعت‌های کاری |
| `working-hours.get` | `GET /api/v1/webhooks/working-hours/:id` | `appointments.read` | خواندن — بی‌خطر | نه | دیدن یک رکورد ساعت کاری |
| `working-hours.create` | `POST /api/v1/webhooks/working-hours` | `appointments.write` | تغییر دادن — نیاز به تأیید | بله | اضافه کردن روز کاری |
| `working-hours.update` | `PATCH /api/v1/webhooks/working-hours/:id` | `appointments.write` | تغییر دادن — نیاز به تأیید | بله | تغییر ساعت/ظرفیت یک روز |
| `working-hours.delete` | `DELETE /api/v1/webhooks/working-hours/:id` | `appointments.manage` | حذف کردن — خطرناک | بله | حذف یک روز کاری |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `working-hours.list`: `page`، `perPage`، `search`، `status`
- `working-hours.get`: `id`
- `working-hours.create`: `day`، `opens`، `closes`، `capacity`، `displayOrder`، `isActive`، `patterns[]`
- `working-hours.update`: `id`، `opens`، `closes`، `capacity`، `displayOrder`، `isActive`، `patterns[]`
- `working-hours.delete`: `id`

**نکته:** روزها به انگلیسی: Sunday..Saturday. ساعت‌ها با فرمت HH:MM و 24 ساعتی.

## خدمات کلینیک (`services`)

> خدمات یعنی کارهایی که کلینیک انجام می‌دهد؛ مثل «اصلاح مو» یا «پاکسازی پوست». هر خدمت قیمت، مدت‌زمان، عکس و چند سؤال پرتکرار دارد.

**مثال‌هایی از حرف کاربر:** «لیست خدمات فعال رو نشون بده» • «یه خدمت جدید به اسم «لیزر» با قیمت ۲ میلیون بساز» • «قیمت این خدمت رو عوض کن» • «خدمات ویژه کدوم‌اند؟»

**کلمه‌های کلیدی:** خدمات، خدمت، سرویس، قیمت، تعرفه، ویژه، پرطرفدار، service، services، price، pricing، featured

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `services.list` | `GET /api/v1/webhooks/services` | `services.read` | خواندن — بی‌خطر | نه | دیدن لیست خدمات |
| `services.get` | `GET /api/v1/webhooks/services/:id` | `services.read` | خواندن — بی‌خطر | نه | دیدن یک خدمت |
| `services.create` | `POST /api/v1/webhooks/services` | `services.write` | تغییر دادن — نیاز به تأیید | بله | ساختن خدمت جدید |
| `services.update` | `PATCH /api/v1/webhooks/services/:id` | `services.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک خدمت (قیمت، عنوان، فعال بودن…) |
| `services.delete` | `DELETE /api/v1/webhooks/services/:id` | `services.manage` | حذف کردن — خطرناک | بله | حذف یک خدمت |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `services.list`: `page`، `perPage`، `search`، `categoryId`، `status`، `featured`
- `services.get`: `id`
- `services.create`: `categoryId`، `slug`، `price`، `priceType`، `durationMin`، `sessionsCount`، `coverImage`، `isActive`، `isFeatured`، `displayOrder`، `translations.fa.title`، `translations.en.title`، `images[]`، `faqs[]`
- `services.update`: `id`، `price`، `priceType`، `durationMin`، `isActive`، `isFeatured`، `translations.fa.title`
- `services.delete`: `id`

**نکته:** priceType: fixed | from | on_request. هر خدمت باید categoryId معتبر داشته باشد.

## دسته‌بندی خدمات (`service-categories`)

> دسته‌بندی مثل کشوهای یک کمد است. خدمات را داخل کشوها می‌گذاریم تا پیدا کردنشان راحت‌تر شود؛ مثلاً کشوی «پوست» و کشوی «مو».

**مثال‌هایی از حرف کاربر:** «دسته‌های خدمات چی هستن؟» • «یه دستهٔ جدید به اسم «پوست» بساز»

**کلمه‌های کلیدی:** دسته خدمات، دسته‌بندی، کتگوری، category، categories

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `service-categories.list` | `GET /api/v1/webhooks/service-categories` | `services.read` | خواندن — بی‌خطر | نه | دیدن دسته‌ها |
| `service-categories.get` | `GET /api/v1/webhooks/service-categories/:id` | `services.read` | خواندن — بی‌خطر | نه | دیدن یک دسته |
| `service-categories.create` | `POST /api/v1/webhooks/service-categories` | `services.write` | تغییر دادن — نیاز به تأیید | بله | ساختن دستهٔ جدید |
| `service-categories.update` | `PATCH /api/v1/webhooks/service-categories/:id` | `services.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک دسته |
| `service-categories.delete` | `DELETE /api/v1/webhooks/service-categories/:id` | `services.manage` | حذف کردن — خطرناک | بله | حذف یک دسته |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `service-categories.list`: `page`، `perPage`، `search`، `status`
- `service-categories.get`: `id`
- `service-categories.create`: `groupId`، `slug`، `icon`، `image`، `displayOrder`، `isActive`، `translations.fa.name`
- `service-categories.update`: `id`، `groupId`، `slug`، `isActive`، `translations.fa.name`
- `service-categories.delete`: `id`

## گروه‌های خدمات (`service-groups`)

> گروه، قفسهٔ بزرگ‌تر است و دسته داخل آن می‌نشیند. مثل «کتابخانه → قفسهٔ داستان → کتاب‌های ترسناک».

**مثال‌هایی از حرف کاربر:** «گروه‌های خدمات رو نشون بده» • «یه گروه جدید بساز»

**کلمه‌های کلیدی:** گروه خدمات، گروه، group، groups

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `service-groups.list` | `GET /api/v1/webhooks/service-groups` | `services.read` | خواندن — بی‌خطر | نه | دیدن گروه‌ها |
| `service-groups.get` | `GET /api/v1/webhooks/service-groups/:id` | `services.read` | خواندن — بی‌خطر | نه | دیدن یک گروه |
| `service-groups.create` | `POST /api/v1/webhooks/service-groups` | `services.write` | تغییر دادن — نیاز به تأیید | بله | ساختن گروه جدید |
| `service-groups.update` | `PATCH /api/v1/webhooks/service-groups/:id` | `services.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک گروه |
| `service-groups.delete` | `DELETE /api/v1/webhooks/service-groups/:id` | `services.manage` | حذف کردن — خطرناک | بله | حذف یک گروه |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `service-groups.list`: `page`، `perPage`، `search`، `status`
- `service-groups.get`: `id`
- `service-groups.create`: `slug`، `icon`، `image`، `displayOrder`، `isActive`، `translations.fa.name`
- `service-groups.update`: `id`، `slug`، `isActive`، `translations.fa.name`
- `service-groups.delete`: `id`

## کاربران و کارمندان (`users`)

> این‌ها آدم‌هایی هستند که اجازهٔ ورود به سیستم را دارند: مدیر، منشی، پرسنل. برای هر نفر می‌شود حساب ساخت، غیرفعالش کرد یا دسترسی‌اش را بست.

**مثال‌هایی از حرف کاربر:** «کاربرهای فعال رو لیست کن» • «یه حساب برای منشی جدید بساز» • «فلانی رو غیرفعال کن» • «کی مدیره؟»

**کلمه‌های کلیدی:** کاربر، کاربرها، کاربران، کارمند، منشی، مدیر، پرسنل، نقش، دسترسی، بلاک، بن، user، users، staff، employee، role، ban

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `users.list` | `GET /api/v1/webhooks/users` | `users.read` | خواندن — بی‌خطر | نه | دیدن لیست کاربران |
| `users.create` | `POST /api/v1/webhooks/users` | `users.write` | تغییر دادن — نیاز به تأیید | بله | ساختن کاربر جدید |
| `users.update-status` | `PATCH /api/v1/webhooks/users/:id` | `users.manage` | تغییر دادن — نیاز به تأیید | بله | فعال/غیرفعال/بن کردن یک کاربر |
| `users.delete` | `DELETE /api/v1/webhooks/users/:id` | `users.manage` | حذف کردن — خطرناک | بله | حذف یک کاربر |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `users.list`: `page`، `perPage`، `search`، `status`، `role`
- `users.create`: `fullName`، `email`، `phone`، `password`، `roleKey`
- `users.update-status`: `id`، `isActive`، `isBanned`، `banReason`
- `users.delete`: `id`

**نکته:** رمز عبور باید حداقل ۸ کاراکتر و شامل حرف بزرگ، حرف کوچک، عدد و علامت باشد.

## تنظیمات سایت (`settings`)

> تنظیمات، کلیدهای جادویی سایت هستند: شمارهٔ تماس، آدرس، متن‌های ثابت. عوض کردن هر کدام، سایت را عوض می‌کند.

**مثال‌هایی از حرف کاربر:** «شماره تماس کلینیک چیه؟» • «شماره تلفن رو عوض کن» • «تنظیمات رو لیست کن»

**کلمه‌های کلیدی:** تنظیمات، تنظیم، شماره تماس، آدرس، setting، settings، config

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `settings.list` | `GET /api/v1/webhooks/settings` | `settings.read` | خواندن — بی‌خطر | نه | دیدن تنظیمات |
| `settings.get` | `GET /api/v1/webhooks/settings/:id` | `settings.read` | خواندن — بی‌خطر | نه | دیدن یک تنظیم |
| `settings.create` | `POST /api/v1/webhooks/settings` | `settings.write` | تغییر دادن — نیاز به تأیید | بله | ساختن تنظیم جدید |
| `settings.update` | `PATCH /api/v1/webhooks/settings/:id` | `settings.write` | تغییر دادن — نیاز به تأیید | بله | تغییر مقدار یک تنظیم |
| `settings.delete` | `DELETE /api/v1/webhooks/settings/:id` | `settings.manage` | حذف کردن — خطرناک | بله | حذف یک تنظیم |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `settings.list`: `page`، `perPage`، `search`، `status`
- `settings.get`: `id`
- `settings.create`: `key`، `value`، `type`، `isActive`، `translations.fa`، `translations.en`
- `settings.update`: `id`، `value`، `isActive`، `translations.fa`
- `settings.delete`: `id`

**نکته:** type: string | number | boolean | json | localized

## قوانین کلینیک (`rules`)

> قوانین همان تذکرهای کوچک هستند: «نیم ساعت قبل بیایید»، «اگر لغو کردید خبر بدهید». سایت آن‌ها را به مشتری نشان می‌دهد.

**مثال‌هایی از حرف کاربر:** «قوانین رو نشون بده» • «یه قانون جدید اضافه کن»

**کلمه‌های کلیدی:** قوانین، قانون، شرایط، rule، rules

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `rules.list` | `GET /api/v1/webhooks/rules` | `rules.read` | خواندن — بی‌خطر | نه | دیدن قوانین |
| `rules.get` | `GET /api/v1/webhooks/rules/:id` | `rules.read` | خواندن — بی‌خطر | نه | دیدن یک قانون |
| `rules.create` | `POST /api/v1/webhooks/rules` | `rules.write` | تغییر دادن — نیاز به تأیید | بله | ساختن قانون جدید |
| `rules.update` | `PATCH /api/v1/webhooks/rules/:id` | `rules.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک قانون |
| `rules.delete` | `DELETE /api/v1/webhooks/rules/:id` | `rules.manage` | حذف کردن — خطرناک | بله | حذف یک قانون |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `rules.list`: `page`، `perPage`، `search`، `status`
- `rules.get`: `id`
- `rules.create`: `slug`، `icon`، `color`، `highlighted`، `displayOrder`، `isActive`، `translations.fa.name`
- `rules.update`: `id`، `highlighted`، `isActive`، `translations.fa.name`
- `rules.delete`: `id`

## راهنمای مراقبت (`care-guides`)

> بعد از درمان، مشتری باید بداند چه کار کند: چه چیزی بخورد، چه چیزی نه. این راهنماها همان برگه‌های «بعد از کار چه کنیم؟» هستند.

**مثال‌هایی از حرف کاربر:** «راهنمای مراقبت بعد از لیزر رو نشون بده» • «یه راهنمای جدید بساز»

**کلمه‌های کلیدی:** راهنما، مراقبت، بعد از درمان، guide، guides، care

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `care-guides.list` | `GET /api/v1/webhooks/care-guides` | `care-guides.read` | خواندن — بی‌خطر | نه | دیدن راهنماها |
| `care-guides.get` | `GET /api/v1/webhooks/care-guides/:id` | `care-guides.read` | خواندن — بی‌خطر | نه | دیدن یک راهنما |
| `care-guides.create` | `POST /api/v1/webhooks/care-guides` | `care-guides.write` | تغییر دادن — نیاز به تأیید | بله | ساختن راهنمای جدید |
| `care-guides.update` | `PATCH /api/v1/webhooks/care-guides/:id` | `care-guides.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک راهنما |
| `care-guides.delete` | `DELETE /api/v1/webhooks/care-guides/:id` | `care-guides.manage` | حذف کردن — خطرناک | بله | حذف یک راهنما |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `care-guides.list`: `page`، `perPage`، `search`، `status`
- `care-guides.get`: `id`
- `care-guides.create`: `slug`، `icon`، `displayOrder`، `isActive`، `translations.fa.name`
- `care-guides.update`: `id`، `isActive`، `translations.fa.name`
- `care-guides.delete`: `id`

## آیتم‌های راهنمای مراقبت (`care-guide-items`)

> هر راهنما از چند تکهٔ کوچک ساخته می‌شود؛ مثل فهرست کارها: «۱. دو ساعت ورزش نکن ۲. ضدآفتاب بزن». هر تکه یک آیتم است.

**مثال‌هایی از حرف کاربر:** «آیتم‌های راهنمای لیزر رو ببین» • «یه آیتم جدید به این راهنما اضافه کن»

**کلمه‌های کلیدی:** آیتم راهنما، مورد راهنما، care guide item، guide item، items

| اکشن | متد و آدرس | دسترسی لازم | نوع | تأیید لازم؟ | توضیح |
| --- | --- | --- | --- | --- | --- |
| `care-guide-items.list` | `GET /api/v1/webhooks/care-guide-items` | `care-guides.read` | خواندن — بی‌خطر | نه | دیدن آیتم‌های راهنما |
| `care-guide-items.get` | `GET /api/v1/webhooks/care-guide-items/:id` | `care-guides.read` | خواندن — بی‌خطر | نه | دیدن یک آیتم |
| `care-guide-items.create` | `POST /api/v1/webhooks/care-guide-items` | `care-guides.write` | تغییر دادن — نیاز به تأیید | بله | اضافه کردن آیتم به راهنما |
| `care-guide-items.update` | `PATCH /api/v1/webhooks/care-guide-items/:id` | `care-guides.write` | تغییر دادن — نیاز به تأیید | بله | تغییر یک آیتم |
| `care-guide-items.delete` | `DELETE /api/v1/webhooks/care-guide-items/:id` | `care-guides.manage` | حذف کردن — خطرناک | بله | حذف یک آیتم |

**فیلدهایی که هوش مصنوعی می‌تواند پر کند:**

- `care-guide-items.list`: `page`، `perPage`، `search`، `status`، `guideId`
- `care-guide-items.get`: `id`
- `care-guide-items.create`: `guideId`، `highlighted`، `displayOrder`، `isActive`، `translations.fa.title`
- `care-guide-items.update`: `id`، `guideId`، `highlighted`، `isActive`، `translations.fa.title`
- `care-guide-items.delete`: `id`

## پیامک (`sms`)

> پیامک یعنی فرستادن یک پیام کوتاه به گوشی مشتری، مثل یادآوری نوبت. در پروژهٔ فعلی فقط «طرح» آن ساخته شده (provider، template، message) ولی هنوز آدرس (route) ندارد؛ پس ربات فقط می‌تواند توضیحش بدهد و کاری انجام دهد که route دارد.

**مثال‌هایی از حرف کاربر:** «یه پیامک یادآوری بفرست» • «قالب‌های پیامک چی هستن؟»

**کلمه‌های کلیدی:** پیامک، اس‌ام‌اس، sms، provider، template، message

⚠ این بخش هنوز آدرس (route) ندارد و ربات فقط می‌تواند توضیحش بدهد.

## جدول دسترسی‌ها

| permission | نوع | تعداد اکشن |
| --- | --- | --- |
| `appointments.read` | خواندن — بی‌خطر | 4 |
| `appointments.write` | تغییر دادن — نیاز به تأیید | 4 |
| `appointments.manage` | حذف کردن — خطرناک | 2 |
| `services.read` | خواندن — بی‌خطر | 6 |
| `services.write` | تغییر دادن — نیاز به تأیید | 6 |
| `services.manage` | حذف کردن — خطرناک | 3 |
| `users.read` | خواندن — بی‌خطر | 1 |
| `users.write` | تغییر دادن — نیاز به تأیید | 1 |
| `users.manage` | حذف کردن — خطرناک | 2 |
| `settings.read` | خواندن — بی‌خطر | 2 |
| `settings.write` | تغییر دادن — نیاز به تأیید | 2 |
| `settings.manage` | حذف کردن — خطرناک | 1 |
| `rules.read` | خواندن — بی‌خطر | 2 |
| `rules.write` | تغییر دادن — نیاز به تأیید | 2 |
| `rules.manage` | حذف کردن — خطرناک | 1 |
| `care-guides.read` | خواندن — بی‌خطر | 4 |
| `care-guides.write` | تغییر دادن — نیاز به تأیید | 4 |
| `care-guides.manage` | حذف کردن — خطرناک | 2 |

## قانون طلایی

هوش مصنوعی فقط می‌تواند یکی از اکشن‌های بالا را انتخاب کند. آدرس، متد، دسترسی و تأییدِ لازم همه در کد تعیین شده‌اند؛ بنابراین مدل نمی‌تواند کارِ خارج از این فهرست انجام دهد.
