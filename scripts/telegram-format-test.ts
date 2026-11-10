import assert from "node:assert/strict";
import { formatTelegramText, jalaliDate, telegramChunks } from "../lib/telegram/format";

export function testTelegramFormatting() {
  const now = new Date("2026-03-21T12:00:00Z");
  assert.equal(jalaliDate(now), "۱ فروردین ۱۴۰۵");
  assert.equal(jalaliDate("invalid"), "نامشخص");
  const id = "11111111-1111-4111-8111-111111111111";
  const password = "Ab12**<>&!";
  const command = '/users password ' + id + ' {"password":"' + password + '","confirmPassword":"' + password + '"}';
  const result = formatTelegramText(`**👥 کاربران**\n📄 صفحه: 12\n- مجموع: 42\n• شناسه: ${id}\n• تلفن: +989123456789\n• ایمیل: test123@example.com\n${command}\n${id}: ${password}\n• تاریخ ثبت: 2026-03-21\nمتن <b>بدون HTML</b>`, now);
  assert(result.text.includes("صفحه: ۱۲"));
  assert(result.text.includes("• مجموع: ۴۲"));
  assert(result.text.includes(command), "JSON command remains byte-for-byte copyable");
  assert(result.text.includes(`${id}: ${password}`), "temporary password remains exact");
  assert(result.text.includes("+989123456789"));
  assert(result.text.includes("test123@example.com"));
  assert(result.text.includes("• تاریخ ثبت: ۱ فروردین ۱۴۰۵"));
  assert(result.text.includes("🗓 ارسال: ۱ فروردین ۱۴۰۵"));
  assert(result.text.includes("<b>بدون HTML</b>"));
  const title = result.entities.find(entity => entity.type === "bold" && entity.offset === 0)!;
  assert.equal(result.text.slice(title.offset, title.offset + title.length), "👥 کاربران");
  for (const entity of result.entities) {
    assert(entity.offset >= 0 && entity.offset + entity.length <= result.text.length);
  }
  const long = formatTelegramText(`**👥 فهرست کاربران**\n${"👤 اطلاعات کاربر\n".repeat(600)}`, now);
  const chunks = telegramChunks(long.text, long.entities);
  assert(chunks.length > 1);
  assert.equal(chunks.map(chunk => chunk.text).join(""), long.text, "no truncation");
  for (const chunk of chunks) {
    assert(chunk.text.length <= 3900);
    assert(!/[\uD800-\uDBFF]$/u.test(chunk.text));
    for (const entity of chunk.entities) assert(entity.offset + entity.length <= chunk.text.length);
  }
  const hugeCode = formatTelegramText('/users ' + 'a'.repeat(8500), now);
  const codeChunks = telegramChunks(hugeCode.text, hugeCode.entities);
  assert.equal(codeChunks.map(chunk => chunk.text).join(""), hugeCode.text);
  assert(codeChunks.every(chunk => chunk.entities.every(entity => entity.offset + entity.length <= chunk.text.length)));
}
if (process.argv[1]?.endsWith("telegram-format-test.ts")) {
  testTelegramFormatting();
  console.log("Telegram formatting tests passed.");
}
