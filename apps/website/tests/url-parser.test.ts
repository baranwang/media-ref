import { expect, test } from "vite-plus/test";
import { buildExternalUrl, parseExternalInput } from "../src/lib/url-parser.ts";

test("iqiyi numeric ids map to their real page slugs", () => {
  // 狂飙 albumId and 流浪地球 tvId, slugs taken from the live iqiyi.com pages.
  expect(buildExternalUrl("iqiyi", "5328486914190101")).toBe(
    "https://www.iqiyi.com/a_1fkgtbddd2x.html",
  );
  expect(buildExternalUrl("iqiyi", "923452300")).toBe("https://www.iqiyi.com/v_19rrfe142o.html");
  expect(buildExternalUrl("iqiyi", "1fkgtbddd2x")).toBe("https://www.iqiyi.com/a_1fkgtbddd2x.html");
});

test("iqiyi v_ links keep their v_ prefix", () => {
  expect(parseExternalInput("https://www.iqiyi.com/v_19rrfe142o.html?vfrm=1")?.url).toBe(
    "https://www.iqiyi.com/v_19rrfe142o.html",
  );
});
