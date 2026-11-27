import { expect, test } from "vite-plus/test";
import {
  buildExternalUrl,
  contributionLinkFields,
  parseExternalInput,
} from "../src/lib/url-parser.ts";

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

test.each([
  {
    input: "https://www.bilibili.com/bangumi/play/ss38221?spm_id_from=333.337",
    namespace: "bilibili",
    nativeId: "ss38221",
    url: "https://www.bilibili.com/bangumi/play/ss38221",
  },
  {
    input: "https://www.bilibili.com/bangumi/play/ep402225",
    namespace: "bilibili",
    nativeId: "ep402225",
    url: "https://www.bilibili.com/bangumi/play/ep402225",
  },
  {
    input: "https://www.bilibili.com/bangumi/media/md28234679",
    namespace: "bilibili",
    nativeId: "md28234679",
    url: "https://www.bilibili.com/bangumi/media/md28234679",
  },
  {
    input: "https://v.qq.com/x/cover/mzc00200mp8vo9b/u0044abcdefg.html",
    namespace: "tencent",
    nativeId: "mzc00200mp8vo9b",
    url: "https://v.qq.com/x/cover/mzc00200mp8vo9b.html",
  },
  {
    input: "https://v.qq.com/detail/m/mzc00200mp8vo9b.html",
    namespace: "tencent",
    nativeId: "mzc00200mp8vo9b",
    url: "https://v.qq.com/x/cover/mzc00200mp8vo9b.html",
  },
  {
    input: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
    namespace: "iqiyi",
    nativeId: "a_1fkgtbddd2x",
    url: "https://www.iqiyi.com/a_1fkgtbddd2x.html",
  },
  {
    input: "https://www.iqiyi.com/v_19rrfe142o.html?vfrm=1",
    namespace: "iqiyi",
    nativeId: "v_19rrfe142o",
    url: "https://www.iqiyi.com/v_19rrfe142o.html",
  },
  {
    input: "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html?spm=a2hja.14919748",
    namespace: "youku",
    nativeId: "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html",
    url: "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html",
  },
  {
    input: "https://list.youku.com/show/id_zCC001F06962411DE83B1.html",
    namespace: "youku",
    nativeId: "cc001f06962411de83b1",
    url: "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
  },
  {
    input: "https://www.mgtv.com/b/338497/8038640.html",
    namespace: "mgtv",
    nativeId: "338497",
    url: "https://www.mgtv.com/h/338497.html",
  },
  {
    input: "https://movie.douban.com/subject/26647087/",
    namespace: "douban",
    nativeId: "26647087",
    url: "https://movie.douban.com/subject/26647087/",
  },
  {
    input: "https://www.themoviedb.org/tv/1429-attack-on-titan",
    namespace: "tmdb",
    nativeId: "tv:1429",
    url: "https://www.themoviedb.org/tv/1429?language=zh-CN",
  },
  {
    input: "https://www.imdb.com/title/tt2560140/",
    namespace: "imdb",
    nativeId: "tt2560140",
    url: "https://www.imdb.com/title/tt2560140/",
  },
  {
    input: "https://thetvdb.com/dereferrer/series/267440",
    namespace: "tvdb",
    nativeId: "267440",
    url: "https://thetvdb.com/dereferrer/series/267440",
  },
  {
    input: "https://trakt.tv/shows/attack-on-titan",
    namespace: "trakt",
    nativeId: "show:attack-on-titan",
    url: "https://trakt.tv/shows/attack-on-titan",
  },
  {
    input: "https://bgm.tv/subject/55770",
    namespace: "bangumi",
    nativeId: "55770",
    url: "https://bgm.tv/subject/55770",
  },
])("parses $input", ({ input, namespace, nativeId, url }) => {
  expect(parseExternalInput(input)).toMatchObject({ namespace, nativeId, url });
});

test("stored canonical ids build a page whose link parses back to an id the server accepts", () => {
  expect(buildExternalUrl("youku", "cc001f06962411de83b1")).toBe(
    "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
  );
  expect(buildExternalUrl("youku", "XNTk3MzA5NzgzMg==")).toBe(
    "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html",
  );
  expect(buildExternalUrl("iqiyi", "a_1fkgtbddd2x")).toBe(
    "https://www.iqiyi.com/a_1fkgtbddd2x.html",
  );
  expect(parseExternalInput(buildExternalUrl("iqiyi", "5328486914190101"))?.nativeId).toBe(
    "a_1fkgtbddd2x",
  );
});

test.each([
  "bilibili:ss0",
  "ep00",
  "https://www.bilibili.com/bangumi/play/ss038221",
  "https://v.qq.com/detail/m/short.html",
  "https://v.qq.com/x/cover/MZC00200MP8VO9B.html",
  "https://www.mgtv.com/h/0338497.html",
  "https://bgm.tv/subject/0",
  "douban:026647087",
  "iqiyi:19rrfe142o",
  "youku:X",
  "https://list.youku.com/show/id_zinvalid.html",
  "https://v.youku.com/v_show/id_X.html",
])("rejects an invalid adapter ID in %s", (input) => {
  expect(parseExternalInput(input)).toBeNull();
});

test("a short iQiyi slug and a 20-hex Youku video ID retain their page context", () => {
  const album = "https://www.iqiyi.com/a_abc.html";
  const video = "https://v.youku.com/v_show/id_cc001f06962411de83b1.html";
  expect(parseExternalInput(album)).toMatchObject({ nativeId: album, url: album });
  expect(parseExternalInput(video)).toMatchObject({ nativeId: video, url: video });
});

test("Youku keys preserve the video or show page", () => {
  const video = "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html";
  expect(parseExternalInput("youku:XNTk3MzA5NzgzMg==")).toMatchObject({
    nativeId: video,
    url: video,
  });
  expect(parseExternalInput(`youku:${video}`)).toMatchObject({ nativeId: video, url: video });
  expect(parseExternalInput("youku:cc001f06962411de83b1")).toMatchObject({
    nativeId: "cc001f06962411de83b1",
    url: "https://list.youku.com/show/id_zcc001f06962411de83b1.html",
  });
});

test("canonical keys keep the stored iQiyi ID and the TMDB media type", () => {
  expect(parseExternalInput("iqiyi:923452300")).toMatchObject({
    nativeId: "923452300",
    url: "https://www.iqiyi.com/v_19rrfe142o.html",
  });
  expect(parseExternalInput("tmdb:movie:603")).toMatchObject({
    nativeId: "movie:603",
    mediaTypeHint: "movie",
    url: "https://www.themoviedb.org/movie/603?language=zh-CN",
  });
});

test.each([
  "x/m/play?vid=u0045abc123&cid=mzc00200mp8vo9b",
  "x/m/detail/?cid=mzc00200mp8vo9b",
  "play.html?cid=mzc00200mp8vo9b",
  "z/msite/play-short/index.html?cid=mzc00200mp8vo9b",
  "cover/m/mzc00200mp8vo9b.html",
  "cover/mzc00200mp8vo9b/u0045abc123.html",
])("accepts a namespaced Tencent mobile page: %s", (page) => {
  expect(parseExternalInput(`tencent:https://m.v.qq.com/${page}`)).toMatchObject({
    namespace: "tencent",
    nativeId: "mzc00200mp8vo9b",
    url: "https://v.qq.com/x/cover/mzc00200mp8vo9b.html",
  });
});

test.each(["video", "alipay_video"])("accepts a namespaced Youku mobile %s page", (path) => {
  const url = "https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html";
  expect(
    parseExternalInput(`youku:https://m.youku.com/${path}/id_XNTk3MzA5NzgzMg==.html?source=share`),
  ).toMatchObject({ namespace: "youku", nativeId: url, url });
});

test.each([
  "tencent:https://m.v.qq.com/x/m/play?vid=u0045abc123",
  "tencent:https://m.v.qq.com/x/m/play?cid=short",
  "tencent:https://m.v.qq.com/unknown?cid=mzc00200mp8vo9b",
  "tencent:https://m.v.qq.com.example.org/play.html?cid=mzc00200mp8vo9b",
  "youku:https://v.youku.com/video/id_XNTk3MzA5NzgzMg==.html",
  "youku:https://m.youku.com.example.org/video/id_XNTk3MzA5NzgzMg==.html",
  "tencent:https://m.youku.com/video/id_XNTk3MzA5NzgzMg==.html",
])("rejects unsupported mobile links: %s", (input) => {
  expect(parseExternalInput(input)).toBeNull();
});

test("a look-alike host is not a recognised link", () => {
  expect(parseExternalInput("https://iqiyi.com.example.org/a_1fkgtbddd2x.html")).toBeNull();
  expect(parseExternalInput("https://notbilibili.com/bangumi/play/ss38221")).toBeNull();
});

test.each([
  ["tvdb", "movie:123"],
  ["trakt", "movie:727"],
  ["trakt", "show:727"],
  ["trakt", "show:attack-on-titan"],
] as const)(
  "pasting a %s catalog link preserves its typed key %s on submission",
  (namespace, nativeId) => {
    const url = buildExternalUrl(namespace, nativeId);
    expect(contributionLinkFields(parseExternalInput(url)!)).toEqual({
      namespace,
      nativeId,
      rawNativeId: url,
    });
  },
);

test("trakt and tvdb external IDs with type prefixes build valid external URLs", () => {
  expect(buildExternalUrl("trakt", "movie:727", "movie")).toBe("https://trakt.tv/movies/727");
  expect(buildExternalUrl("trakt", "show:159384", "tv")).toBe("https://trakt.tv/shows/159384");
  expect(buildExternalUrl("trakt", "show:159384")).toBe("https://trakt.tv/shows/159384");
  expect(buildExternalUrl("tvdb", "movie:123", "movie")).toBe(
    "https://thetvdb.com/dereferrer/movie/123",
  );
  expect(buildExternalUrl("tvdb", "series:267440", "tv")).toBe(
    "https://thetvdb.com/dereferrer/series/267440",
  );
  expect(parseExternalInput("trakt:movie:727")).toMatchObject({
    namespace: "trakt",
    nativeId: "movie:727",
    url: "https://trakt.tv/movies/727",
    mediaTypeHint: "movie",
  });
});
